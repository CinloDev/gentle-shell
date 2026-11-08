import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import type { PreviewResult } from "./tree-file-preview.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TreeFileView {
 private result: PreviewResult = { kind: "text", text: "", message: "Loading…" };
 private lines = [""];
 private visual: string[] = [];
 private visualWidth = -1;
 private overflow = false;
 private vertical = 0;
 private disposed = false;
 private path: string;
 private theme: ShellBarTheme;
 private close: () => void;
 private redraw: () => void;
 private rows: () => number;
 constructor(path: string, theme: ShellBarTheme, close: () => void, redraw: () => void, rows: () => number) {
  this.path = path; this.theme = theme; this.close = close; this.redraw = redraw; this.rows = rows;
 }
 update(result: PreviewResult): void {
  if (this.disposed) return;
  this.result = result;
  this.lines = result.text.split("\n").map(line => {
   let column = 0, output = "";
   for (const { segment } of graphemes.segment(line)) {
    if (segment === "\t") { const spaces = 8 - column % 8; output += " ".repeat(spaces); column += spaces; }
    else { output += segment; column += visibleWidth(segment); }
   }
   return output;
  });
  this.visualWidth = -1; this.vertical = 0; this.redraw();
 }
 private wrapped(width: number): string[] {
  if (this.visualWidth === width) return this.visual;
  this.visualWidth = width; this.visual = []; this.overflow = false;
  if (width < 3) { this.visual.push("!"); return this.visual; }
  const maxRows = 8192;
  const add = (line: string): boolean => {
   if (this.visual.length === maxRows) { this.overflow = true; return false; }
   this.visual.push(line); return true;
  };
  outer: for (const line of this.lines) {
   let part = "", used = 0, continuation = false;
   for (const { segment } of graphemes.segment(line)) {
    const size = visibleWidth(segment);
    const available = continuation ? width - 1 : width;
    if (used && used + size > available) {
     if (!add((continuation ? "  " : " ") + part)) break outer;
     part = ""; used = 0; continuation = true;
    }
    part += segment; used += size;
   }
   if (!add((continuation ? "  " : " ") + part)) break;
  }
  return this.visual;
 }
 private capacity(): number { return Math.max(1, this.rows() - 6); }
 private scroll(delta: number): void { this.vertical = Math.max(0, Math.min(Math.max(0, this.visual.length - this.capacity()), this.vertical + delta)); this.redraw(); }
 render(width: number): string[] {
  const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(this.rows()));
  if (w < 2 || h < 2) return Array.from({ length: h }, () => " ".repeat(w));
  const inner = w - 2;
  const pad = (line: string) => { const clipped = truncateToWidth(line, inner); return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))); };
  const fg = (role: string, text: string) => this.theme.fg(role, text);
  const title = sanitizeTerminalText(this.path).replace(/[\n\t]/g, " ");
  const visual = this.wrapped(Math.max(0, inner - 1));
  const notice = inner < 4 ? "!" : this.overflow ? "Display truncated" : this.result.message;
  const content = [fg("accent", ` ${title} · read-only`), fg(this.result.kind === "error" ? "error" : "muted", notice)];
  this.vertical = Math.min(this.vertical, Math.max(0, visual.length - this.capacity()));
  for (const line of visual.slice(this.vertical, this.vertical + Math.max(0, h - 6))) content.push(fg("text", line));
  while (content.length < h - 3) content.push("");
  if (h >= 4) content.push(fg("muted", " ↑↓ / wheel scroll · Esc close"));
  const edge = (a: string, b: string) => fg("border", a + "─".repeat(inner) + b);
  return [edge("╭", "╮"), ...content.slice(0, h - 2).map(line => fg("border", "│") + pad(line) + fg("border", "│")), edge("╰", "╯")];
 }
 handleInput(data: string): void {
  if (this.disposed) return;
  if (matchesKey(data, Key.escape)) return this.close();
  if (matchesKey(data, Key.down) || data === "j") this.scroll(1);
  else if (matchesKey(data, Key.up) || data === "k") this.scroll(-1);
  else if (matchesKey(data, Key.pageDown)) this.scroll(this.capacity());
  else if (matchesKey(data, Key.pageUp)) this.scroll(-this.capacity());
 }
 handleMouse(event: TuiMouseEvent) { if (!this.disposed && event.type === "wheel") this.scroll(event.wheelDelta ?? 0); return { handled: true, render: true }; }
 invalidate(): void {}
 dispose(): void { this.disposed = true; }
}
