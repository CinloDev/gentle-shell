import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionScratchExtension, SCRATCH_COMMAND_USAGE } from "../extensions/session-scratch.ts";
import { gitArtifactTargets, LEDGER_VERSION, SCRATCH_PREFIX, type ScratchLedger } from "../lib/session-scratch.ts";

// Session scratch and artifact ledger (odd/tasks/session-scratch-ledger.md):
// the runtime owns the parent session's TMPDIR and the clones/worktrees it
// creates, records them in a per-session ledger, and removes only what it
// created and recorded. Every fixture lives under one private test root.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> };

interface Fixture { root: string; base: string; configHome: string; cwd: string; work: string }

function fixture(t: TestContext): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-session-scratch-test-")));
	const fx = { root, base: join(root, "tmp"), configHome: join(root, "config"), cwd: join(root, "project"), work: join(root, "work") };
	for (const path of [fx.base, fx.configHome, fx.cwd, fx.work]) mkdirSync(path, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return fx;
}

interface Options { sessionId?: string; child?: boolean; hasUI?: boolean; confirm?: boolean; isProcessAlive?: (pid: number) => boolean; now?: () => number; platform?: NodeJS.Platform; tmp?: string }

function session(fx: Fixture, options: Options = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const notes: string[] = [];
	const confirms: string[] = [];
	const env: NodeJS.ProcessEnv = { TMPDIR: options.tmp ?? fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome, ...(options.child ? { GENTLE_PI_AGENTS_CHILD: "1" } : {}) };
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	createSessionScratchExtension({ env, isProcessAlive: options.isProcessAlive, now: options.now, platform: options.platform })(pi);
	const ctx = {
		cwd: fx.cwd,
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionId: () => options.sessionId ?? "s-1" },
		ui: {
			notify: (message: string) => { notes.push(message); },
			confirm: async (title: string, message: string) => { confirms.push(`${title}\n${message}`); return options.confirm ?? true; },
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => await handlers.get(name)?.(event, ctx);
	return {
		env, handlers, commands, notes, confirms, ctx,
		start: (reason = "startup") => emit("session_start", { type: "session_start", reason }),
		shutdown: (reason = "quit") => emit("session_shutdown", { type: "session_shutdown", reason }),
		bash: (command: string, isError = false, toolName = "bash") => emit("tool_result", { type: "tool_result", toolName, toolCallId: "c1", input: { command }, content: [], isError }),
		run: async (args: string) => { await commands.get("gentle:scratch")!.handler(args, ctx); return notes.at(-1) ?? ""; },
	};
}

const ledgerFile = (fx: Fixture, sessionId: string) => join(fx.configHome, "scratch", `${sessionId}.json`);
const readLedger = (fx: Fixture, sessionId: string) => JSON.parse(readFileSync(ledgerFile(fx, sessionId), "utf8")) as ScratchLedger;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function origin(fx: Fixture): string {
	const path = join(fx.work, "origin");
	mkdirSync(path);
	git(path, "init", "-q");
	writeFileSync(join(path, "a.txt"), "a\n");
	git(path, "add", "a.txt");
	git(path, "commit", "-q", "-m", "init");
	return path;
}

function writeForeignLedger(fx: Fixture, ledger: Partial<ScratchLedger> & { sessionId: string }): void {
	mkdirSync(join(fx.configHome, "scratch"), { recursive: true });
	const full: ScratchLedger = { version: LEDGER_VERSION, pid: 999_999, processStartedAt: new Date(0).toISOString(), cwd: fx.cwd, scratchDir: null, artifacts: [], ...ledger };
	writeFileSync(ledgerFile(fx, ledger.sessionId), JSON.stringify(full));
}

const later = () => Date.now() + 2 * 3_600_000;

// S2

test("S2: a primary session points TMPDIR at a private session scratch under the inherited one", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { sessionId: "abc/../1" });
	await s.start();
	const scratch = s.env.TMPDIR!;
	assert.equal(dirname(scratch), fx.base);
	assert.match(basename(scratch), new RegExp(`^${SCRATCH_PREFIX}abc-1-`));
	assert.ok(statSync(scratch).isDirectory());
	if (process.platform !== "win32") assert.equal(statSync(scratch).mode & 0o777, 0o700);
	assert.equal(s.env.TMP, undefined, "TMP/TEMP are only set on win32");
});

test("S2: on win32 TMP and TEMP follow the session scratch", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { platform: "win32" });
	await s.start();
	assert.equal(s.env.TMP, s.env.TMPDIR);
	assert.equal(s.env.TEMP, s.env.TMPDIR);
	await s.shutdown();
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(s.env.TMP, undefined);
	assert.equal(s.env.TEMP, undefined);
});

test("S2: a child session creates no scratch, ledger, capture, or command", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { child: true });
	await s.start();
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(s.commands.has("gentle:scratch"), false);
	assert.equal(s.handlers.size, 0);
	assert.deepEqual(readdirSync(fx.base), []);
	assert.equal(existsSync(join(fx.configHome, "scratch")), false);
	// Parent control: the same fixture in a primary session does create one.
	const parent = session(fx);
	await parent.start();
	assert.notEqual(parent.env.TMPDIR, fx.base);
	await parent.shutdown();
});

test("S2: when the scratch cannot be created the session keeps the inherited TMPDIR", async (t) => {
	const fx = fixture(t);
	const missing = join(fx.root, "missing");
	const s = session(fx, { tmp: missing });
	await s.start();
	assert.equal(s.env.TMPDIR, missing);
	assert.equal(existsSync(missing), false);
});

test("S2/S5: reload keeps the same scratch; quit removes it and restores TMPDIR", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	const scratch = s.env.TMPDIR!;
	writeFileSync(join(scratch, "work.txt"), "x");
	await s.shutdown("reload");
	await s.start("reload");
	assert.equal(s.env.TMPDIR, scratch);
	assert.ok(existsSync(join(scratch, "work.txt")));
	await s.shutdown("quit");
	assert.equal(existsSync(scratch), false);
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(existsSync(ledgerFile(fx, "s-1")), false, "a ledger without artifacts is deleted");
});

test("S5: a session replacement removes the old scratch and the new session gets its own", async (t) => {
	const fx = fixture(t);
	let id = "first";
	const s = session(fx);
	(s.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => id;
	await s.start();
	const first = s.env.TMPDIR!;
	await s.shutdown("new");
	id = "second";
	await s.start("new");
	assert.equal(existsSync(first), false);
	assert.equal(dirname(s.env.TMPDIR!), fx.base, "the new scratch nests under the inherited TMPDIR, not the old scratch");
	assert.match(basename(s.env.TMPDIR!), /^gentle-pi-session-second-/);
	await s.shutdown();
});

// S3

test("S3: the ledger records the session, owning process, cwd and scratch, written atomically and privately", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	const ledger = readLedger(fx, "s-1");
	assert.equal(ledger.version, LEDGER_VERSION);
	assert.equal(ledger.sessionId, "s-1");
	assert.equal(ledger.pid, process.pid);
	assert.ok(!Number.isNaN(Date.parse(ledger.processStartedAt)));
	assert.equal(ledger.cwd, fx.cwd);
	assert.equal(ledger.scratchDir, s.env.TMPDIR);
	assert.deepEqual(ledger.artifacts, []);
	assert.deepEqual(readdirSync(join(fx.configHome, "scratch")), ["s-1.json"], "no temp file is left after the rename");
	if (process.platform !== "win32") assert.equal(statSync(ledgerFile(fx, "s-1")).mode & 0o777, 0o600);
	await s.shutdown();
});

// S4

test("S4: clone and worktree destinations resolve against cd segments and git -C", () => {
	const cwd = "/w";
	const paths = (command: string) => gitArtifactTargets(command, cwd).map(({ kind, path }) => `${kind}:${path}`);
	assert.deepEqual(paths("git clone https://example.com/org/repo.git"), ["clone:/w/repo"]);
	assert.deepEqual(paths("git clone --depth 1 -b main git@github.com:org/tool.git dest"), ["clone:/w/dest"]);
	assert.deepEqual(paths("git clone --origin=up ../a/"), ["clone:/w/a"]);
	assert.deepEqual(paths("cd sub && git clone ../origin"), ["clone:/w/sub/origin"]);
	assert.deepEqual(paths("cd sub && git clone ../o here"), ["clone:/w/sub/here"]);
	assert.deepEqual(paths("git -C sub clone ../o d 2>&1 | tail -1"), ["clone:/w/sub/d"]);
	assert.deepEqual(paths("GIT_TERMINAL_PROMPT=0 git clone x/b.bundle"), ["clone:/w/b"]);
	assert.deepEqual(paths("git worktree add -b feat ../wt main"), ["worktree:/wt"]);
	assert.deepEqual(paths("git worktree add --detach wt2 HEAD; git worktree add -B x \"with space\""), ["worktree:/w/wt2", "worktree:/w/with space"]);
	for (const none of ["echo git clone x y", "git worktree list", "git clone", "git log --grep clone", "printf 'git worktree add z'"]) {
		assert.deepEqual(paths(none), [], none);
	}
});

test("S4: a successful foreground bash clone or worktree add is recorded with its command and time", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	const clone = `cd ${fx.work} && git clone -q ${source} copy`;
	git(fx.work, "clone", "-q", source, "copy");
	await s.bash(clone);
	git(source, "worktree", "add", "-q", "-b", "feat", join(fx.work, "wt"));
	await s.bash(`git -C ${source} worktree add -q -b feat ../wt`);
	const ledger = readLedger(fx, "s-1");
	assert.deepEqual(ledger.artifacts.map(({ kind, path, command }) => ({ kind, path, command })), [
		{ kind: "clone", path: join(fx.work, "copy"), command: clone },
		{ kind: "worktree", path: join(fx.work, "wt"), command: `git -C ${source} worktree add -q -b feat ../wt` },
	]);
	assert.ok(ledger.artifacts.every((artifact) => !Number.isNaN(Date.parse(artifact.recordedAt))));
	// The same path is recorded once.
	await s.bash(clone);
	assert.equal(readLedger(fx, "s-1").artifacts.length, 2);
	await s.shutdown();
	assert.equal(readLedger(fx, "s-1").scratchDir, null, "the ledger survives shutdown while artifacts remain");
});

test("S4: failed, missing, non-bash, and child results are not recorded", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "copy");
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} copy`, true);
	await s.bash(`cd ${fx.work} && git clone ${source} never-created`);
	await s.bash(`cd ${fx.work} && git clone ${source} copy`, false, "bg_start");
	assert.deepEqual(readLedger(fx, "s-1").artifacts, []);
	const child = session(fx, { child: true, sessionId: "child" });
	await child.start();
	await child.bash(`cd ${fx.work} && git clone ${source} copy`);
	assert.equal(existsSync(ledgerFile(fx, "child")), false);
	await s.shutdown();
});

test("S4: a clone into the session directory or an ancestor of it is never recorded", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	git(fx.cwd, "clone", "-q", source, ".");
	await s.bash(`git clone ${source} .`);
	await s.bash(`git clone ${source} ..`);
	assert.deepEqual(readLedger(fx, "s-1").artifacts, []);
	await s.shutdown();
});

// S5

test("S5: startup sweeps the scratch of dead sessions past the grace period and keeps their artifacts", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const deadA = session(fx, { sessionId: "dead-a" });
	await deadA.start();
	const scratchA = deadA.env.TMPDIR!;
	writeFileSync(join(scratchA, "left.txt"), "x");
	const deadB = session(fx, { sessionId: "dead-b" });
	await deadB.start();
	const scratchB = deadB.env.TMPDIR!;
	git(fx.work, "clone", "-q", source, "kept");
	await deadB.bash(`cd ${fx.work} && git clone ${source} kept`);
	// Neither session shut down (crash). A later session finds both owners dead.
	const next = session(fx, { sessionId: "next", isProcessAlive: () => false, now: later });
	await next.start();
	assert.equal(existsSync(scratchA), false);
	assert.equal(existsSync(scratchB), false);
	assert.equal(existsSync(ledgerFile(fx, "dead-a")), false);
	const b = readLedger(fx, "dead-b");
	assert.equal(b.scratchDir, null);
	assert.deepEqual(b.artifacts.map((artifact) => artifact.path), [join(fx.work, "kept")]);
	assert.ok(existsSync(join(fx.work, "kept", "a.txt")), "the sweep never removes artifacts");
	assert.ok(existsSync(next.env.TMPDIR!), "the sweep keeps the new session's own scratch");
	await next.shutdown();
});

test("S5: the sweep keeps scratch of live owners and of ledgers younger than the grace period", async (t) => {
	const fx = fixture(t);
	const other = session(fx, { sessionId: "other" });
	await other.start();
	const scratch = other.env.TMPDIR!;
	const live = session(fx, { sessionId: "live-check", isProcessAlive: () => true, now: later });
	await live.start();
	assert.ok(existsSync(scratch), "a live owning process keeps its scratch");
	const young = session(fx, { sessionId: "young-check", isProcessAlive: () => false });
	await young.start();
	assert.ok(existsSync(scratch), "a ledger younger than the grace period keeps its scratch");
	for (const s of [live, young, other]) await s.shutdown();
});

test("S5: the sweep refuses a symlinked scratch, a scratch outside the recorded prefix, and another session's prefix", async (t) => {
	const fx = fixture(t);
	const victim = join(fx.root, "victim");
	mkdirSync(victim);
	writeFileSync(join(victim, "keep.txt"), "precious");
	const link = join(fx.base, `${SCRATCH_PREFIX}evil-link-AAAAAA`);
	symlinkSync(victim, link, "dir");
	writeForeignLedger(fx, { sessionId: "evil-link", scratchDir: link });
	writeForeignLedger(fx, { sessionId: "evil-outside", scratchDir: victim });
	const otherPrefix = join(fx.base, `${SCRATCH_PREFIX}someone-else-BBBBBB`);
	mkdirSync(otherPrefix);
	writeFileSync(join(otherPrefix, "keep.txt"), "x");
	writeForeignLedger(fx, { sessionId: "evil-prefix", scratchDir: otherPrefix });
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: () => false, now: later });
	await s.start();
	assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "precious");
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.ok(existsSync(join(otherPrefix, "keep.txt")));
	for (const id of ["evil-link", "evil-outside", "evil-prefix"]) assert.ok(existsSync(ledgerFile(fx, id)), `${id} ledger is kept for the command`);
	await s.shutdown();
});

test("S5: shutdown keeps a scratch that holds a recorded clone", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	const scratch = s.env.TMPDIR!;
	git(scratch, "clone", "-q", source, "inside");
	await s.bash(`cd ${scratch} && git clone ${source} inside`);
	await s.shutdown();
	assert.ok(existsSync(join(scratch, "inside", "a.txt")));
	assert.equal(readLedger(fx, "s-1").scratchDir, scratch);
});

// S6

test("S6: list shows the session scratch with its size and the artifacts of this and dead sessions only", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "mine");
	git(fx.work, "clone", "-q", source, "dead");
	git(fx.work, "clone", "-q", source, "live");
	writeForeignLedger(fx, { sessionId: "dead-1", pid: 1_111_111, artifacts: [{ kind: "clone", path: join(fx.work, "dead"), command: "git clone", recordedAt: new Date().toISOString() }] });
	writeForeignLedger(fx, { sessionId: "live-1", pid: 2_222_222, artifacts: [{ kind: "clone", path: join(fx.work, "live"), command: "git clone", recordedAt: new Date().toISOString() }] });
	const s = session(fx, { isProcessAlive: (pid) => pid === 2_222_222 });
	await s.start();
	writeFileSync(join(s.env.TMPDIR!, "f.bin"), Buffer.alloc(2048));
	await s.bash(`cd ${fx.work} && git clone ${source} mine`);
	const out = await s.run("list");
	assert.match(out, new RegExp(`Session scratch: ${s.env.TMPDIR!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(2\\.0 KiB\\)`));
	assert.match(out, /clone .*\/work\/mine \(this session\)/);
	assert.match(out, /clone .*\/work\/dead \(session dead-1, ended\)/);
	assert.doesNotMatch(out, /work\/live/);
	assert.equal(await s.run(""), out, "no argument lists");
	await s.shutdown();
});

test("S6: clean removes scratch without asking and, after one confirmation, only clean recorded worktrees and pushed clones", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	const scratch = s.env.TMPDIR!;
	writeFileSync(join(scratch, "junk.txt"), "x");
	mkdirSync(join(scratch, "gentle-pi-subagent-tmp-live"));
	const add = async (args: string[], command: string) => { git(fx.work, ...args); await s.bash(`cd ${fx.work} && ${command}`); };
	await add(["clone", "-q", source, "pushed"], `git clone ${source} pushed`);
	await add(["clone", "-q", source, "unpushed"], `git clone ${source} unpushed`);
	git(join(fx.work, "unpushed"), "commit", "-q", "--allow-empty", "-m", "local");
	await add(["clone", "-q", source, "dirty-clone"], `git clone ${source} dirty-clone`);
	writeFileSync(join(fx.work, "dirty-clone", "new.txt"), "x");
	git(source, "worktree", "add", "-q", "-b", "clean-wt", join(fx.work, "wt-clean"));
	await s.bash(`cd ${source} && git worktree add -b clean-wt ../wt-clean`);
	git(source, "worktree", "add", "-q", "-b", "dirty-wt", join(fx.work, "wt-dirty"));
	await s.bash(`cd ${source} && git worktree add -b dirty-wt ../wt-dirty`);
	writeFileSync(join(fx.work, "wt-dirty", "a.txt"), "changed\n");
	git(fx.work, "clone", "-q", source, "unrecorded");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 1);
	assert.match(s.confirms[0], /pushed/);
	assert.match(s.confirms[0], /wt-clean/);
	assert.doesNotMatch(s.confirms[0], /work\/(unpushed|dirty-clone|wt-dirty)/);
	assert.equal(existsSync(join(fx.work, "pushed")), false);
	assert.equal(existsSync(join(fx.work, "wt-clean")), false);
	assert.doesNotMatch(git(source, "worktree", "list"), /wt-clean/, "the worktree is removed and pruned");
	assert.ok(existsSync(join(fx.work, "unpushed", "a.txt")));
	assert.ok(existsSync(join(fx.work, "dirty-clone", "new.txt")));
	assert.equal(readFileSync(join(fx.work, "wt-dirty", "a.txt"), "utf8"), "changed\n");
	assert.ok(existsSync(join(fx.work, "unrecorded", "a.txt")), "paths outside the recorded set are never touched");
	assert.match(out, /unpushed: commits not on any remote/);
	assert.match(out, /dirty-clone: uncommitted changes/);
	assert.match(out, /wt-dirty: uncommitted changes/);
	assert.equal(existsSync(join(scratch, "junk.txt")), false);
	assert.ok(existsSync(join(scratch, "gentle-pi-subagent-tmp-live")), "live subagent scratch is left to the runner");
	assert.ok(existsSync(scratch), "the session keeps its TMPDIR");
	assert.deepEqual(readLedger(fx, "s-1").artifacts.map((artifact) => basename(artifact.path)).sort(), ["dirty-clone", "unpushed", "wt-dirty"]);
	await s.shutdown();
});

test("S6: a declined confirmation keeps every artifact; without UI clean removes scratch only and reports artifacts", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "pushed");
	const declined = session(fx, { confirm: false });
	await declined.start();
	await declined.bash(`cd ${fx.work} && git clone ${source} pushed`);
	await declined.run("clean");
	assert.ok(existsSync(join(fx.work, "pushed", "a.txt")));
	await declined.shutdown();
	const headless = session(fx, { hasUI: false, sessionId: "headless" });
	await headless.start();
	writeFileSync(join(headless.env.TMPDIR!, "junk.txt"), "x");
	await headless.bash(`cd ${fx.work} && git clone ${source} pushed`);
	const out = await headless.run("clean");
	assert.equal(headless.confirms.length, 0);
	assert.ok(existsSync(join(fx.work, "pushed", "a.txt")));
	assert.equal(existsSync(join(headless.env.TMPDIR!, "junk.txt")), false);
	assert.match(out, /pushed/);
	await headless.shutdown();
});

test("S6: clean refuses a recorded clone replaced by a symlink and leaves live sessions alone", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "real");
	git(fx.work, "clone", "-q", source, "copy");
	const s = session(fx, { isProcessAlive: (pid) => pid === 3_333_333 });
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} copy`);
	renameSync(join(fx.work, "copy"), join(fx.work, "moved"));
	symlinkSync(join(fx.work, "real"), join(fx.work, "copy"), "dir");
	git(fx.work, "clone", "-q", source, "theirs");
	const liveScratch = join(fx.base, `${SCRATCH_PREFIX}live-2-CCCCCC`);
	mkdirSync(liveScratch);
	writeForeignLedger(fx, { sessionId: "live-2", pid: 3_333_333, scratchDir: liveScratch, artifacts: [{ kind: "clone", path: join(fx.work, "theirs"), command: "git clone", recordedAt: new Date().toISOString() }] });
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0, "nothing removable, nothing to confirm");
	assert.ok(lstatSync(join(fx.work, "copy")).isSymbolicLink());
	assert.ok(existsSync(join(fx.work, "real", "a.txt")));
	assert.ok(existsSync(join(fx.work, "theirs", "a.txt")));
	assert.ok(existsSync(liveScratch));
	assert.match(out, /copy: not the recorded directory/);
	await s.shutdown();
});

test("S6: clean keeps a detached worktree whose commits are on no branch", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	git(source, "worktree", "add", "-q", "--detach", join(fx.work, "detached"));
	await s.bash(`cd ${source} && git worktree add --detach ../detached`);
	git(join(fx.work, "detached"), "commit", "-q", "--allow-empty", "-m", "orphan");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0);
	assert.ok(existsSync(join(fx.work, "detached", "a.txt")));
	assert.match(out, /detached: commits on no branch/);
	await s.shutdown();
});

test("S6/S8: the command help names list and clean", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	assert.match(s.commands.get("gentle:scratch")!.description ?? "", /list\|clean/);
	assert.equal(await s.run("bogus"), SCRATCH_COMMAND_USAGE);
	assert.match(SCRATCH_COMMAND_USAGE, /^Usage: \/gentle:scratch \[list\|clean\]/);
	await s.shutdown();
});

test("S8: the reference documents the scratch dir, ledger, automatic cleanup, sweep rule, and the command help", () => {
	const reference = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	const section = reference.split("### Session scratch and artifact ledger\n")[1]?.split("\n### ")[0] ?? "";
	for (const term of [
		"`gentle-pi-session-<session id>-XXXXXX`", "`TMPDIR`", "`<config home>/scratch/<session id>.json`", "atomically",
		"`version`", "`sessionId`", "`pid`", "`processStartedAt`", "`cwd`", "`scratchDir`", "`artifacts`", "`git clone ... [<dir>]`", "`git worktree add ... <path>`",
		"At session shutdown", "older than one hour", "never follows symlinks",
		"`/gentle:scratch list`", "`/gentle:scratch clean`", "no uncommitted changes and no unpushed commits", "`git worktree remove`", "Without a UI",
	]) assert.ok(section.includes(term), `scratch reference missing ${term}`);
	assert.match(reference, /\| `\/gentle:scratch` +\| Lists \(`list`, the default\) or cleans \(`clean`\)/);
	for (const line of SCRATCH_COMMAND_USAGE.split("\n").slice(1)) {
		const [action] = line.trim().split(/\s+/);
		assert.ok(section.includes(`\`/gentle:scratch ${action}\``), `reference missing the ${action} action from the help`);
	}
});
