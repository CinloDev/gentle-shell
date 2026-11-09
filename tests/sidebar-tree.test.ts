import assert from "node:assert/strict";
import test from "node:test";
import { SidebarTree, SidebarTreeSession } from "../lib/sidebar-tree.ts";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const entry = (name: string, directory = false, symlink = false) => ({ name, isDirectory: () => directory, isSymbolicLink: () => symlink });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const click = (y: number) => ({ type: "click", button: "left", x: 1, y, width: 50, height: 20, screenX: 1, screenY: y, shift: false, alt: false, ctrl: false } as const);
const toggle = (tree: SidebarTree, name: string) => { const lines = tree.render(50); assert.ok(lines.some(line => line.includes(name))); tree.handleMouse(click(lines.findIndex(line => line.includes(name)))); };

test("switching roots rejects stale directory and status results and uses the selected root", async () => {
 const reads: Array<{ path: string; resolve: (entries: ReturnType<typeof entry>[]) => void }> = [];
 const statuses: Array<{ root: string; resolve: (result: { code: number; stdout: string }) => void }> = [];
 const tree = new SidebarTree("/wt", theme, () => {}, path => new Promise(resolve => reads.push({ path, resolve })));
 const runner = (root: string) => async () => new Promise<{ code: number; stdout: string }>(resolve => statuses.push({ root, resolve }));
 const session = new SidebarTreeSession(tree, "/wt", runner("/wt"));
 session.setActive(true); await tick();
 session.setRoot("/main", runner("/main")); await tick();
 assert.deepEqual(reads.map(x => x.path), ["/wt", "/main"]);
 assert.deepEqual(statuses.map(x => x.root), ["/wt", "/main"]);
 reads[1]!.resolve([entry("main")]); statuses[1]!.resolve({code: 0, stdout: " M main\0"}); await tick();
 reads[0]!.resolve([entry("stale")]); statuses[0]!.resolve({code: 0, stdout: "?? stale\0"}); await tick();
 assert.match(tree.render(40).join("\n"), /main\s+M/); assert.doesNotMatch(tree.render(40).join("\n"), /stale/);
 session.setActive(false); session.setRoot("/wt", runner("/wt")); await tick(); assert.equal(reads.length, 2); assert.equal(statuses.length, 2);
 session.dispose();
});

test("disposing a pending target read rejects its late completion", async () => {
 let finish!: (entries: ReturnType<typeof entry>[]) => void; let notices = 0;
 const target = new SidebarTree("/main", theme, () => notices++, () => new Promise(resolve => { finish = resolve; }));
 const session = new SidebarTreeSession(target, "/main"); session.setActive(true);
 assert.match(target.render(40).join("\n"), /Loading/); session.dispose(); const before = notices;
 finish([entry("late")]); await tick(); assert.equal(notices, before); assert.doesNotMatch(target.render(40).join("\n"), /late/);
});

test("repeated render performs no directory or Git reads, including error frames", async () => {
 let reads = 0, gitCalls = 0;
 const tree = new SidebarTree("/repo", theme, () => {}, async () => { reads++; throw new Error("denied"); });
 const session = new SidebarTreeSession(tree, "/repo", async () => { gitCalls++; return { code: 1, stdout: "" }; });
 session.setActive(true); await tick(); assert.match(tree.render(40).join("\n"), /Error reading directory/);
 const before = [reads, gitCalls]; for (let i = 0; i < 10; i++) { tree.render(40); tree.renderSidebar(40, 8); }
 await tick(); assert.deepEqual([reads, gitCalls], before); session.dispose();
});

test("returning to a root paints its own snapshot immediately while refreshing", async () => {
 const tree = new SidebarTree("/wt", theme, () => {}, async path => [entry(path === "/wt" ? "worktree-file" : "main-file")]);
 const session = new SidebarTreeSession(tree, "/wt"); session.setActive(true); await tick();
 session.setRoot("/main"); await tick(); assert.match(tree.render(40).join("\n"), /main-file/);
 session.setRoot("/wt"); const frame = tree.render(40).join("\n");
 assert.match(frame, /worktree-file/); assert.doesNotMatch(frame, /main-file|Loading/); session.dispose();
});

test("switching to an unvisited root keeps the painted root until its read completes", async () => {
	const reads: Array<{ path: string; resolve: (entries: ReturnType<typeof entry>[]) => void }> = [];
	const tree = new SidebarTree("/wt", theme, () => {}, path => new Promise(resolve => reads.push({ path, resolve })));
	const session = new SidebarTreeSession(tree, "/wt"); session.setActive(true); await tick();
	reads[0]!.resolve([entry("worktree-file")]); await tick();
	session.setRoot("/main"); await tick();
	const pending = tree.render(40).join("\n");
	assert.match(pending, /worktree-file/); assert.doesNotMatch(pending, /Loading/);
	reads[1]!.resolve([entry("main-file")]); await tick();
	const frame = tree.render(40).join("\n");
	assert.match(frame, /main-file/); assert.doesNotMatch(frame, /worktree-file|Loading/);
	session.dispose();
});

test("cancelling a deferred switch keeps the painted root without another read or status", async () => {
	const reads: string[] = []; const statuses: string[] = [];
	const pending: Array<(entries: ReturnType<typeof entry>[]) => void> = [];
	const tree = new SidebarTree("/wt", theme, () => {}, path => { reads.push(path); return path === "/wt" ? Promise.resolve([entry("worktree-file")]) : new Promise<ReturnType<typeof entry>[]>(resolve => pending.push(resolve)); });
	const runner = (name: string) => async () => { statuses.push(name); return { code: 0, stdout: "" }; };
	const session = new SidebarTreeSession(tree, "/wt", runner("wt")); session.setActive(true); await tick();
	session.setRoot("/main", runner("main")); await tick();
	assert.deepEqual(reads, ["/wt", "/main"]); assert.deepEqual(statuses, ["wt", "main"]);
	session.setRoot("/wt", runner("wt-again")); await tick();
	assert.deepEqual(reads, ["/wt", "/main"]); assert.deepEqual(statuses, ["wt", "main"]);
	assert.equal(tree.paintedRoot, "/wt"); assert.match(tree.render(40).join("\n"), /worktree-file/); assert.doesNotMatch(tree.render(40).join("\n"), /Loading/);
	pending[0]!([entry("stale")]); await tick();
	assert.doesNotMatch(tree.render(40).join("\n"), /stale/); session.dispose();
});

test("session starts work only on activation, coalesces status and ignores stale results", async () => {
 const requests: Array<(value: {code: number; stdout: string}) => void> = [];
 const args: string[][] = []; let reads = 0;
 const tree = new SidebarTree("/repo", theme, () => {}, async () => { reads++; return [entry("file")]; });
 const session = new SidebarTreeSession(tree, "/repo", async input => { args.push(input); return new Promise(resolve => requests.push(resolve)); });
 tree.render(40); assert.equal(reads, 0); assert.equal(args.length, 0);
 session.setActive(true); await tick(); assert.equal(reads, 1); assert.equal(args.length, 1);
 session.refresh(); session.refresh(); assert.equal(args.length, 1);
 requests.shift()!({code: 0, stdout: "UU file\0"}); await tick();
 assert.match(tree.render(40).join("\n"), /file\s+!/); assert.equal(args.length, 2);
 session.setActive(false); requests.shift()!({code: 0, stdout: "?? stale\0"}); await tick();
 assert.doesNotMatch(tree.render(40).join("\n"), /stale/);
 assert.deepEqual(args[0], ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
 session.dispose();
});

test("deactivation or disposal before the status microtask never starts Git", async () => {
 for (const action of ["deactivate", "dispose"] as const) {
  let calls = 0;
  const tree = new SidebarTree("/repo", theme, () => {}, async () => []);
  const session = new SidebarTreeSession(tree, "/repo", async () => { calls++; return { code: 0, stdout: "" }; });
  session.setActive(true);
  if (action === "deactivate") session.setActive(false); else session.dispose();
  await tick(); assert.equal(calls, 0, action); session.dispose();
 }
});

test("viewport formats only displayed entries while retaining scrolling and badges", async () => {
 let formatted = 0;
 const countingTheme = { ...theme, fg: (_role: string, text: string) => { formatted++; return text; } };
 const tree = new SidebarTree("/repo", countingTheme, () => {}, async () => Array.from({ length: 1000 }, (_, i) => entry(`file${String(i).padStart(4, "0")}`)));
 tree.activate(); await tick(); tree.setGitStatus("/repo", [{ path: "file0999", status: "modified" }], false);
 formatted = 0; tree.renderSidebar(40, 8); assert.ok(formatted < 100, `formatted ${formatted} fragments`);
 tree.handleMouse({ ...click(2), type: "wheel", button: "none", wheelDelta: 1000 });
 const lines = tree.renderSidebar(40, 8); assert.match(lines.join("\n"), /file0999\s+M/);
 tree.dispose();
});

test("loads on activation and expansion, sorts and never traverses symlinks or reads during render", async () => {
 const calls: string[] = [];
 const tree = new SidebarTree("/repo", theme, () => {}, async path => { calls.push(path); return path === "/repo" ? [entry("z"), entry("link", true, true), entry("dir", true)] : [entry("child")]; });
 tree.render(50); assert.deepEqual(calls, []); tree.activate(); await tick();
 let text = tree.render(50).join("\n"); assert.ok(text.indexOf("dir") < text.indexOf("link"));
 toggle(tree, "link"); assert.deepEqual(calls, ["/repo"]); toggle(tree, "dir"); await tick();
 text = tree.render(50).join("\n"); assert.match(text, /child/); assert.deepEqual(calls, ["/repo", "/repo/dir"]); tree.dispose();
});

test("git badges, deleted paths, directory summaries and failed status retention", async () => {
 const tree = new SidebarTree("/repo", theme, () => {}, async () => [entry("m"), entry("u"), entry("a"), entry("r"), entry("conflict")]);
 tree.activate(); await tick();
 tree.setGitStatus("/repo", [{path:"m",status:"modified"},{path:"u",status:"untracked"},{path:"a",status:"added"},{path:"r",status:"renamed"},{path:"conflict",status:"modified",conflict:true},{path:"gone/deep/file",status:"deleted"}], false);
 let text = tree.render(50).join("\n"); for (const [name, badge] of [["m","M"],["u","U"],["a","A"],["r","R"],["conflict","!"]]) assert.match(text, new RegExp(`${name}\\s+\\${badge}`));
 assert.match(text, /gone\s+●/); toggle(tree, "gone"); toggle(tree, "deep"); assert.match(tree.render(50).join("\n"), /file\s+D/);
 tree.setGitStatus("/repo", [], true); text = tree.render(50).join("\n"); assert.match(text, /Could not refresh Git/); assert.match(text, /file\s+D/);
 tree.setGitStatus("/repo", [], false); assert.doesNotMatch(tree.render(50).join("\n"), /gone|Could not refresh Git/); tree.dispose();
});

test("refresh coalesces, preserves content on error and recovers", async () => {
 const pending: Array<{ resolve: (value: ReturnType<typeof entry>[]) => void; reject: (error: Error) => void }> = [];
 const tree = new SidebarTree("/repo", theme, () => {}, () => new Promise((resolve, reject) => pending.push({resolve, reject})));
 tree.activate(); pending.shift()!.resolve([entry("old")]); await tick(); tree.refresh(); tree.refresh(); assert.equal(pending.length, 1);
 assert.match(tree.render(50).join("\n"), /old/); pending.shift()!.reject(new Error("denied")); await tick();
 assert.match(tree.render(50).join("\n"), /old/); assert.match(tree.render(50).join("\n"), /Error reading directory/);
 assert.equal(pending.length, 1); pending.shift()!.resolve([entry("new")]); await tick(); assert.match(tree.render(50).join("\n"), /new/); tree.dispose();
});

test("removed directory rejects pending success and error, including queued refresh", async () => {
 for (const rejectLate of [false, true]) {
  let finish!: (entries: ReturnType<typeof entry>[]) => void;
  let fail!: (error: Error) => void;
  let rootReads = 0; let childReads = 0; let notices = 0;
  const tree = new SidebarTree("/repo", theme, () => notices++, path => {
   if (path === "/repo") return Promise.resolve(++rootReads === 1 ? [entry("dir", true)] : []);
   childReads++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  tree.activate(); await tick(); toggle(tree, "dir"); tree.refresh(); await tick();
  assert.doesNotMatch(tree.render(50).join("\n"), /dir/);
  const before = notices;
  if (rejectLate) fail(new Error("late")); else finish([entry("late")]);
  await tick(); assert.equal(notices, before); assert.equal(childReads, 1);
  assert.doesNotMatch(tree.render(50).join("\n"), /late|Error/); tree.dispose();
 }
});

test("real directory symlinks and directories replaced by symlinks are not expanded", async t => {
 const root = await mkdtemp(join(tmpdir(), "sidebar-tree-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, "dir")); await mkdir(join(root, "target"));
 await writeFile(join(root, "target", "secret"), "secret");
 await symlink(join(root, "target"), join(root, "link"));
 let notify!: () => void;
 let changed = new Promise<void>(resolve => { notify = resolve; });
 const tree = new SidebarTree(root, theme, () => notify());
 t.after(() => tree.dispose()); tree.activate(); await changed;
 // The first notification is loading; wait for the asynchronous read to complete.
 while (tree.render(50).join("\n").includes("Loading")) { changed = new Promise(resolve => { notify = resolve; }); await changed; }
 toggle(tree, "link"); assert.doesNotMatch(tree.render(50).join("\n"), /secret/);
 await rename(join(root, "dir"), join(root, "old")); await symlink(join(root, "target"), join(root, "dir"));
 changed = new Promise(resolve => { notify = resolve; }); toggle(tree, "dir"); await changed;
 while (tree.render(50).join("\n").includes("Loading")) { changed = new Promise(resolve => { notify = resolve; }); await changed; }
 assert.match(tree.render(50).join("\n"), /Error reading directory/);
 assert.doesNotMatch(tree.render(50).join("\n"), /secret/);
});

test("re-expansion refreshes cached children while retaining the snapshot", async () => {
 let finish!: (entries: ReturnType<typeof entry>[]) => void; let calls = 0;
 const tree = new SidebarTree("/repo", theme, () => {}, async path => {
  if (path === "/repo") return [entry("dir", true)];
  if (++calls === 1) return [entry("old")];
  return new Promise(resolve => { finish = resolve; });
 });
 tree.activate(); await tick(); toggle(tree, "dir"); await tick(); toggle(tree, "dir"); toggle(tree, "dir");
 assert.equal(calls, 2); assert.match(tree.render(50).join("\n"), /old/);
 finish([entry("new")]); await tick(); assert.match(tree.render(50).join("\n"), /new/); tree.dispose();
});

test("ancestor replaced by symlink is rejected before reading a nested directory", async t => {
 const root = await mkdtemp(join(tmpdir(), "sidebar-tree-ancestor-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, "dir", "nested"), { recursive: true }); await mkdir(join(root, "target", "nested"), { recursive: true });
 await writeFile(join(root, "target", "nested", "secret"), "secret");
 const tree = new SidebarTree(root, theme, () => {}); t.after(() => tree.dispose());
 const wait = async (text: string) => { for (let i = 0; i < 200 && !tree.render(50).join("\n").includes(text); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
 tree.activate(); await wait("dir"); toggle(tree, "dir"); await wait("nested");
 await rename(join(root, "dir"), join(root, "old")); await symlink(join(root, "target"), join(root, "dir"));
 toggle(tree, "nested"); await wait("Error reading directory");
 assert.match(tree.render(50).join("\n"), /Error reading directory/); assert.doesNotMatch(tree.render(50).join("\n"), /secret/);
});

test("initial read failure is visible and retry succeeds", async () => {
 let calls = 0;
 const tree = new SidebarTree("/repo", theme, () => {}, async () => { if (++calls === 1) throw new Error("denied"); return [entry("recovered")]; });
 tree.activate(); await tick(); assert.match(tree.render(50).join("\n"), /Error reading directory/);
 tree.refresh(); await tick(); assert.match(tree.render(50).join("\n"), /recovered/); assert.equal(calls, 2); tree.dispose();
});

test("viewport scroll, hit testing, resizing and clipping in both panel styles", async t => {
 const previous = cardStyle(); t.after(() => setCardStyle(previous));
 const painted = { ...theme, bg: (_role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
 for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
  setCardStyle(style); const calls: string[] = [];
  const tree = new SidebarTree("/repo", painted, () => {}, async path => { calls.push(path); return path === "/repo" ? Array.from({ length: 12 }, (_, i) => entry(`dir${String(i).padStart(2, "0")}`, true)) : [entry("child")]; });
  t.after(() => tree.dispose()); tree.activate(); await tick();
  for (const height of [0, 1, 2, 3, 4]) assert.ok(tree.renderSidebar(40, height).length <= height);
  tree.renderSidebar(40, 7); tree.handleMouse({ ...click(2), type: "wheel", button: "none", wheelDelta: 5 });
  const lines = tree.renderSidebar(40, 7); assert.match(lines.join("\n"), /dir05/);
  const row = lines.findIndex(line => line.includes("dir05")); assert.ok(row >= 0); tree.handleMouse(click(row)); await tick();
  assert.deepEqual(calls, ["/repo", "/repo/dir05"]);
  assert.match(tree.renderSidebar(40, 30).join("\n"), /dir00/);
  for (let width = 1; width <= 40; width++) assert.ok(tree.renderSidebar(width, 7).every(line => visibleWidth(line) <= width));
 }
});

test("collapsed and disposed trees reject stale asynchronous results", async () => {
 const pending: Array<(entries: ReturnType<typeof entry>[]) => void> = []; let notices = 0;
 const tree = new SidebarTree("/repo", theme, () => notices++, async path => path === "/repo" ? [entry("dir", true)] : new Promise(resolve => pending.push(resolve)));
 tree.activate(); await tick(); toggle(tree, "dir"); toggle(tree, "dir"); toggle(tree, "dir"); assert.equal(pending.length, 2);
 pending[1]!([entry("fresh")]); await tick(); pending[0]!([entry("stale")]); await tick(); assert.match(tree.render(50).join("\n"), /fresh/); assert.doesNotMatch(tree.render(50).join("\n"), /stale/);
 tree.refresh(); const before = notices; tree.dispose(); pending[2]!([entry("late")]); await tick(); assert.equal(notices, before); assert.doesNotMatch(tree.render(50).join("\n"), /late/);
});
