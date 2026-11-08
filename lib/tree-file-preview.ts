import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export type PreviewResult = { kind: "text" | "binary" | "error"; text: string; message: string };
const MAX_BYTES = 128 * 1024;

/** Best-effort checks: concurrent ancestor replacement is not a security boundary. */
export async function readTreeFilePreview(root: string, path: string, limit = MAX_BYTES): Promise<PreviewResult> {
 const fail = (message: string): PreviewResult => ({ kind: "error", text: "", message });
 const base = resolve(root), target = resolve(path), rel = relative(base, target);
 if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return fail("File is outside session root");
 let handle: Awaited<ReturnType<typeof open>> | undefined;
 try {
  const rootStat = await lstat(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return fail("Not a directory");
  let current = base;
  for (const part of rel.split(sep)) {
   current = resolve(current, part);
   const stat = await lstat(current);
   if (stat.isSymbolicLink()) return fail("Symlinks cannot be previewed");
   if (current !== target && !stat.isDirectory()) return fail("Not a directory");
   if (current === target && !stat.isFile()) return fail("Not a regular file");
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return fail("Safe file opening is unavailable on this platform");
  handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await handle.stat()).isFile()) return fail("Not a regular file");
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_BYTES, Math.floor(limit))) : MAX_BYTES;
  const buffer = Buffer.alloc(size + 1); let count = 0;
  while (count < buffer.length) {
   const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
   if (!bytesRead) break;
   count += bytesRead;
  }
  const bytes = buffer.subarray(0, Math.min(count, size));
  if (bytes.includes(0)) return { kind: "binary", text: "", message: "Binary file cannot be previewed" };
  return { kind: "text", text: sanitizeTerminalText(bytes.toString("utf8")), message: count > size ? "Preview truncated" : "" };
 } catch (error) {
  return fail(`Cannot read file: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error)).replace(/[\n\t]/g, " ")}`);
 } finally { await handle?.close().catch(() => {}); }
}
