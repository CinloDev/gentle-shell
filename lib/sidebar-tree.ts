import { lstat, readdir } from "node:fs/promises";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { parsePorcelain, type ChangeStatus, type GitRunner } from "./shell-changes.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow } from "./shell-panel.ts";

type Entry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };
type Reader = (path: string) => Promise<Entry[]>;
type RootState = { root: Node; gitFiles: Map<string, Status>; dirtyDirectories: Set<string>; deletedChildren: Map<string, Map<string, boolean>>; gitError: boolean; offset: number };
type Node = { name: string; path: string; directory: boolean; expanded: boolean; state: "idle" | "loading" | "ready" | "error"; children: Node[]; generation: number; refreshing?: boolean; queued?: boolean; refreshError?: boolean; virtual?: boolean };
type Status = ChangeStatus | "conflict";
const badges: Record<Status, [string, string]> = { modified: ["M", "warning"], untracked: ["U", "success"], added: ["A", "success"], deleted: ["D", "error"], renamed: ["R", "accent"], conflict: ["!", "error"] };
const makeNode = (path: string, directory: boolean, virtual = false): Node => ({ name: basename(path), path, directory, expanded: false, state: virtual ? "ready" : "idle", children: [], generation: 0, virtual });
async function readDirectory(root: string, path: string): Promise<Entry[]> {
 // Best effort only: an ancestor can still change between these checks and readdir.
 const base = resolve(root), target = resolve(path), rest = relative(base, target);
 if (rest === ".." || rest.startsWith(`..${sep}`)) throw new Error("Outside root");
 let current = base;
 for (const part of ["", ...rest.split(sep).filter(Boolean)]) {
  if (part) current = join(current, part);
  const stat = await lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Not a directory");
 }
 return readdir(target, { withFileTypes: true });
}
function icon(name: string): string {
 if (/\.(?:md|mdx)$/i.test(name)) return "📝";
 if (/\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(name)) return "🖼️";
 if (/\.(?:json|jsonc|ya?ml|toml|ini|conf|config)$/i.test(name)) return "⚙️";
 return "📄";
}

/** Session-scoped lazy tree. Rendering never performs filesystem or Git I/O. */
export class SidebarTree {
 private root: Node;
 private snapshots = new Map<string, RootState>();
 // The root whose snapshot still paints while a root never visited is read.
 private handoff?: { from: string };
 private disposed = false;
 private rows: Array<Node | undefined> = [];
 private geometryValid = false;
 private offset = 0;
 private bodyCount = 0;
 private bodyCapacity = 0;
 private projectRoot?: string;
 private gitFiles = new Map<string, Status>();
 private dirtyDirectories = new Set<string>();
 // Index virtual children by parent once per status update, rather than scanning
 // every deleted path for every loaded directory on every refresh.
 private deletedChildren = new Map<string, Map<string, boolean>>();
 private gitError = false;
 private theme: ShellBarTheme;
 private changed: () => void;
 private read: Reader;
 private openFile?: (path: string, root: string) => void;
 constructor(root: string, theme: ShellBarTheme, changed: () => void, read?: Reader, openFile?: (path: string, root: string) => void) {
  this.theme = theme; this.changed = changed; this.read = read ?? (path => readDirectory(this.baseOf(path), path)); this.openFile = openFile;
  this.root = makeNode(root, true); this.root.expanded = true;
 }
 private painted(): RootState | undefined { return this.handoff ? this.snapshots.get(this.handoff.from) : undefined; }
 private get viewOffset(): number { return this.painted()?.offset ?? this.offset; }
 private setViewOffset(offset: number): void { const painted = this.painted(); if (painted) painted.offset = offset; else this.offset = offset; }
 private capture(): RootState { return { root: this.root, gitFiles: this.gitFiles, dirtyDirectories: this.dirtyDirectories, deletedChildren: this.deletedChildren, gitError: this.gitError, offset: this.offset }; }
 // The root a path belongs to: the live root, or the root still painted during
 // a deferred switch, so a click on the painted tree stays inside its own root.
 private baseOf(path: string): string {
  for (const base of this.handoff ? [this.root.path, this.handoff.from] : [this.root.path]) {
   const rest = relative(base, path);
   if (rest !== ".." && !rest.startsWith(`..${sep}`)) return base;
  }
  return this.root.path;
 }
 setGitStatus(root: string, files: Array<{ path: string; status: ChangeStatus; conflict?: boolean }>, error: boolean): void {
  if (this.disposed) return;
  this.gitError = error;
  if (!error) {
   this.gitFiles = new Map(); this.dirtyDirectories = new Set(); this.deletedChildren = new Map();
   for (const file of files) {
    const path = join(root, file.path); const rest = relative(this.root.path, path);
    if (!rest || rest === ".." || rest.startsWith(`..${sep}`)) continue;
    this.gitFiles.set(path, file.conflict ? "conflict" : file.status);
    const parts = rest.split(sep); let parent = this.root.path;
    for (let i = 0; i < parts.length; i++) {
     const child = join(parent, parts[i]!); const directory = i < parts.length - 1;
     if (directory) this.dirtyDirectories.add(child);
     if (file.status === "deleted") {
      let children = this.deletedChildren.get(parent);
      if (!children) this.deletedChildren.set(parent, children = new Map());
      children.set(child, directory || children.get(child) === true);
     }
     parent = child;
    }
   }
   this.reconcile(this.root);
  }
  this.geometryValid = false; this.changed();
 }
 private cancel(node: Node): void {
  node.generation++; node.expanded = false; node.refreshing = false; node.queued = false;
  if (node.state === "loading") node.state = "idle";
  for (const child of node.children) this.cancel(child);
 }
 private reconcile(node: Node): void {
  const wanted = this.deletedChildren.get(node.path);
  node.children = node.children.filter(child => {
   if (!child.virtual || wanted?.has(child.path)) return true;
   this.cancel(child); return false;
  });
  const existing = new Set(node.children.map(child => child.path));
  if (wanted) for (const [path, directory] of wanted) if (!existing.has(path)) node.children.push(makeNode(path, directory, true));
  node.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  for (const child of node.children) if (child.directory) this.reconcile(child);
 }
 /** Switches roots. A root with a snapshot paints it at once; a root never
  * visited keeps the previous snapshot painted until its read answers, so a
  * switch never flashes a loading frame over the tree the user was reading.
  * Returns false when the switch was cancelled back to the painted root, which
  * needs neither another read nor another status: it is already on screen. */
 setRoot(root: string): boolean {
  if (this.disposed || root === this.root.path) return false;
  this.deactivate();
  const from = this.handoff?.from;
  const current = from === root ? this.snapshots.get(from) : undefined;
  this.handoff = undefined;
  if (current) { this.snapshots.delete(root); this.restore(current); this.changed(); return false; }
  // Only a painted root has state worth keeping; a half-loaded switch target
  // the user moved away from is dropped and read again when it comes back.
  if (!from) this.snapshots.set(this.root.path, this.capture());
  const saved = this.snapshots.get(root);
  if (saved) { this.snapshots.delete(root); this.restore(saved); }
  else { this.handoff = { from: from ?? this.root.path }; this.restore({ root: makeNode(root, true), gitFiles: new Map(), dirtyDirectories: new Set(), deletedChildren: new Map(), gitError: false, offset: 0 }); }
  this.changed(); return true;
 }
 private restore(state: RootState): void {
  this.root = state.root; this.root.expanded = true;
  this.gitFiles = state.gitFiles; this.dirtyDirectories = state.dirtyDirectories;
  this.deletedChildren = state.deletedChildren; this.gitError = state.gitError; this.offset = state.offset;
  this.rows = []; this.geometryValid = false;
 }
 /** The root on screen: the last painted root until a deferred switch answers. */
 get paintedRoot(): string { return (this.painted()?.root ?? this.root).path; }
 activate(): void { if (!this.disposed) { if (this.root.state === "idle") this.load(this.root); else this.refresh(); } }
 deactivate(): void {
  const clear = (node: Node) => { node.generation++; node.queued = false; node.refreshing = false; if (node.state === "loading") node.state = "idle"; for (const child of node.children) clear(child); };
  clear(this.root);
 }
 setProjectRoot(root: string | undefined): void { if (!this.disposed && root !== this.projectRoot) { this.projectRoot = root; this.geometryValid = false; this.changed(); } }
 refresh(): void {
  if (this.disposed) return;
  const visit = (node: Node) => {
   if (!node.expanded) return;
   if (!node.virtual) { if (node.state === "loading" || node.refreshing) node.queued = true; else this.load(node); }
   for (const child of node.children) if (child.directory) visit(child);
  };
  visit(this.root);
 }
 private load(node: Node): void {
  const background = node.state === "ready";
  if (background) node.refreshing = true; else { node.state = "loading"; this.changed(); }
  const generation = ++node.generation;
  let request: Promise<Entry[]>;
  try { request = this.read(node.path); } catch { request = Promise.reject(new Error("read failed")); }
  void request.then(entries => {
   if (this.disposed || generation !== node.generation || !node.expanded) return;
   const previous = new Map(node.children.map(child => [child.path, child]));
   node.children = entries.map(entry => {
    const path = join(node.path, entry.name); const directory = entry.isDirectory() && !entry.isSymbolicLink(); const old = previous.get(path);
    if (old && old.directory === directory && !old.virtual) { previous.delete(path); return old; }
    return makeNode(path, directory);
   });
   for (const removed of previous.values()) this.cancel(removed);
   this.reconcile(node); node.refreshing = false; node.refreshError = false; node.state = "ready"; this.geometryValid = false;
   if (node === this.root) this.handoff = undefined;
   this.changed();
   if (node.queued) { node.queued = false; this.load(node); }
  }, () => {
   if (this.disposed || generation !== node.generation || !node.expanded) return;
   node.refreshing = false; if (background) node.refreshError = true; else node.state = "error";
   this.geometryValid = false;
   if (node === this.root) this.handoff = undefined;
   this.changed();
   if (node.queued) { node.queued = false; this.load(node); }
  });
 }
 get ready(): boolean { return this.root.state === "ready" || this.root.state === "error"; }
 render(width: number): string[] { return this.paint(width); }
 renderSidebar(width: number, viewport: number): string[] { return this.paint(width, Math.max(0, Math.floor(viewport))); }
 private paint(width: number, viewport?: number): string[] {
  const painted = this.painted();
  const root = painted?.root ?? this.root, gitFiles = painted?.gitFiles ?? this.gitFiles, dirty = painted?.dirtyDirectories ?? this.dirtyDirectories, gitError = painted?.gitError ?? this.gitError;
  const lines: string[] = []; const nodes: Array<Node | undefined> = []; const inner = Math.max(0, width - PANEL_ROW_INDENT);
  const items: Array<{ node?: Node; ancestors: boolean[]; more?: boolean; text?: string; role?: string }> = [];
  const add = (prefix: string, text: string, node?: Node, role = "text", badge?: [string, string]) => {
   let content = this.theme.fg("muted", prefix);
   if (badge) {
    const label = truncateToWidth(text, Math.max(0, inner - visibleWidth(prefix) - 2), "…");
    content += this.theme.fg(badge[1], label) + " ".repeat(Math.max(1, inner - visibleWidth(prefix) - visibleWidth(label) - 1)) + this.theme.fg(badge[1], badge[0]);
   } else content += this.theme.fg(role, text);
   lines.push(renderPanelRow(width, truncateToWidth(content, inner, "…"))); nodes.push(node);
  };
  const children = (node: Node, ancestors: boolean[]) => {
   if (node.state === "idle" || node.state === "loading") { items.push({ ancestors, text: "Loading…", role: "muted" }); return; }
   if (node.state === "error") { items.push({ ancestors, text: "Error reading directory", role: "error" }); return; }
   if (!node.children.length) { items.push({ ancestors, text: "Empty", role: "muted" }); return; }
   node.children.forEach((child, index) => {
    const more = index < node.children.length - 1;
    items.push({ node: child, ancestors, more });
    if (child.directory && child.expanded) children(child, [...ancestors, more]);
   });
  };
  if (gitError) items.push({ ancestors: [], text: "Could not refresh Git", role: "error" });
  children(root, []);
  const capacity = viewport === undefined ? items.length : Math.max(0, viewport - 1);
  this.bodyCount = items.length; this.bodyCapacity = capacity;
  const offset = Math.min(this.viewOffset, Math.max(0, items.length - capacity)); this.setViewOffset(offset);
  for (const item of items.slice(offset, offset + capacity)) {
   const indent = item.ancestors.map(more => more ? "│   " : "    ").join("");
   const child = item.node;
   if (!child) { add(indent, item.text!, undefined, item.role); continue; }
   const symbol = child.directory ? (child.expanded ? "📂" : "📁") : icon(child.name);
   const label = symbol + " ".repeat(Math.max(0, 2 - visibleWidth(symbol))) + " " + sanitizeTerminalText(child.name).replace(/\n/g, " ");
   const status = gitFiles.get(child.path); const badge: [string, string] | undefined = child.directory ? (dirty.has(child.path) ? ["●", "warning"] : undefined) : status ? badges[status] : undefined;
   add(indent + (item.more ? "├── " : "└── "), label, child, child.directory ? "accent" : "text", badge);
  }
  const shown = lines;
  const name = (path: string) => sanitizeTerminalText(basename(path) || parse(path).root || path).replace(/[\t\r\n]/g, " ");
  const current = name(root.path); const project = this.projectRoot ? name(this.projectRoot) : current;
  const hasError = (node: Node): boolean => Boolean(node.refreshError) || node.children.some(child => child.expanded && hasError(child));
  const title = (hasError(root) ? "Error reading directory · " : "") + (project === current ? current.toUpperCase() : `${project.toUpperCase()} · ${current.toUpperCase()}`);
  const header = renderPanelHeader(this.theme, width, { title, open: true }).replace("ERROR READING DIRECTORY", "Error reading directory");
  const rendered = [header, ...shown];
  const clipped = viewport === undefined ? rendered : rendered.slice(0, viewport);
  this.rows = [undefined, ...nodes].slice(0, clipped.length);
  this.geometryValid = true; return clipped;
 }
 handleMouse(event: TuiMouseEvent): { handled: boolean; render: boolean } | undefined {
  if (this.disposed || !this.geometryValid) return undefined;
  if (event.type === "wheel") {
   const next = Math.max(0, Math.min(Math.max(0, this.bodyCount - this.bodyCapacity), this.viewOffset + (event.wheelDelta ?? 0)));
   if (next !== this.viewOffset) { this.setViewOffset(next); this.geometryValid = false; this.changed(); }
   return { handled: true, render: true };
  }
  if (event.type !== "click" || event.button !== "left") return undefined;
  const node = this.rows[event.y]; if (!node) return undefined;
  if (!node.directory) { if (!this.openFile) return undefined; this.openFile(node.path, this.baseOf(node.path)); return { handled: true, render: true }; }
  this.geometryValid = false; node.expanded = !node.expanded;
  if (!node.expanded) this.cancel(node);
  else if (!node.virtual) this.load(node);
  this.changed(); return { handled: true, render: true };
 }
 invalidate(): void { this.geometryValid = false; }
 dispose(): void { this.disposed = true; this.rows = []; this.handoff = undefined; this.snapshots.clear(); }
}

/** Owns status-only Git work for one active sidebar session. */
export class SidebarTreeSession {
 private active = false;
 private disposed = false;
 private generation = 0;
 private inFlight = false;
 private queued = false;
 private tree: SidebarTree;
 private root: string;
 private git?: GitRunner;
 constructor(tree: SidebarTree, root: string, git?: GitRunner) { this.tree = tree; this.root = root; this.git = git; }
 setActive(active: boolean): void {
  if (this.disposed || active === this.active) return;
  this.active = active; this.generation++; this.queued = false; this.inFlight = false;
  if (!active) { this.tree.deactivate(); return; }
  this.tree.activate(); this.status();
 }
 setRoot(root: string, git?: GitRunner): void {
  if (this.disposed) return;
  if (root === this.root) {
   this.generation++; this.inFlight = false; this.queued = false; this.git = git;
   if (this.active) this.status();
   return;
  }
  this.generation++; this.inFlight = false; this.queued = false;
  this.root = root; this.git = git;
  // A cancelled switch is already on screen: no read and no second status.
  if (!this.tree.setRoot(root)) return;
  if (this.active) { this.tree.activate(); this.status(); }
 }
 refresh(): void { if (this.active && !this.disposed) { this.tree.refresh(); this.status(); } }
 private status(): void {
  if (!this.git || !this.active || this.disposed) return;
  if (this.inFlight) { this.queued = true; return; }
  this.inFlight = true;
  const version = this.generation;
  void Promise.resolve().then(() => {
   if (!this.active || this.disposed || version !== this.generation) return undefined;
   return this.git!(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  }).then(result => {
   if (!result || !this.active || this.disposed || version !== this.generation) return;
   if (result.code !== 0 || result.truncated || result.timedOut) { this.tree.setGitStatus(this.root, [], true); return; }
   const conflicts = new Set<string>();
   const records = result.stdout.split("\0");
   for (let i = 0; i < records.length; i++) {
    const record = records[i]!; const code = record.slice(0, 2);
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) conflicts.add(record.slice(3));
    if (code[0] === "R" || code[0] === "C") i++;
   }
   this.tree.setGitStatus(this.root, [...parsePorcelain(result.stdout)].map(([path, status]) => ({ path, status, conflict: conflicts.has(path) })), false);
  }, () => { if (this.active && !this.disposed && version === this.generation) this.tree.setGitStatus(this.root, [], true); }).finally(() => {
   if (!this.active || this.disposed || version !== this.generation) return;
   this.inFlight = false;
   if (this.queued) { this.queued = false; this.status(); }
  });
 }
 dispose(): void { this.setActive(false); this.disposed = true; this.tree.dispose(); }
}
