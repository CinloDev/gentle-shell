import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { readTreeFilePreview } from "../lib/tree-file-preview.ts";

test("reads text faithfully, identifies binary and bounded previews, and rejects unsafe targets", async t => {
 const root = await mkdtemp(join(tmpdir(), "tree-preview-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, "dir"));
 await writeFile(join(root, "dir", "text"), "first\n\t  child\n\nlast\n");
 await writeFile(join(root, "binary"), Buffer.from([65, 0, 66]));
 await symlink(join(root, "dir", "text"), join(root, "link"));
 await symlink(join(root, "dir"), join(root, "dirlink"));
 assert.deepEqual(await readTreeFilePreview(root, join(root, "dir", "text")), { kind: "text", text: "first\n\t  child\n\nlast\n", message: "" });
 assert.equal((await readTreeFilePreview(root, join(root, "dir", "text"), 5)).message, "Preview truncated");
 assert.equal((await readTreeFilePreview(root, join(root, "binary"))).kind, "binary");
 for (const path of [join(root, "link"), join(root, "dirlink", "text"), join(root, "dir"), join(root, "missing"), join(root, "..", "outside")]) {
  assert.equal((await readTreeFilePreview(root, path)).kind, "error", path);
 }
});

test("rejects Unix socket special files without opening them", { skip: process.platform === "win32" }, async t => {
 const root = await mkdtemp(join(tmpdir(), "tree-preview-socket-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const socket = join(root, "socket"); const server = createServer();
 await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
 t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
 assert.equal((await readTreeFilePreview(root, socket)).message, "Not a regular file");
});

test("removes terminal controls without changing line and tab structure", async t => {
 const root = await mkdtemp(join(tmpdir(), "tree-preview-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const file = join(root, "text"); await writeFile(file, "a\x1b[31mred\x1b[0m\n\tb\x07\n");
 const result = await readTreeFilePreview(root, file);
 assert.equal(result.kind, "text"); assert.equal(result.text, "ared\n\tb\n");
});
