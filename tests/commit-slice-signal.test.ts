import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { commitSliceReport, commitSliceToolResult, commitTargetDirectory, isGitCommitCommand } from "../lib/commit-slice-signal.ts";

// Harness roadmap T4 (R1): the ~400-line slice rule lived in the prompt and the
// model had to estimate line counts. After each parent commit the runtime now
// reports the authored changed lines on the branch, so slicing reads a number.

function repo(t: TestContext): { dir: string; git: (...args: string[]) => string; commitFile: (path: string, lines: number) => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "commit-slice-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	const commitFile = (path: string, lines: number) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
		git("add", "--", path);
		git("commit", "-q", "-m", `add ${path}`);
	};
	git("init", "-q", "-b", "main");
	commitFile("README.md", 3);
	return { dir, git, commitFile };
}

test("isGitCommitCommand recognizes commits inside shell commands, nothing else", () => {
	for (const command of ["git commit -m 'feat: x'", "git add -A && git commit -qm x", "cd pkg && git -C . commit --amend --no-edit", "git -c user.name=a commit -m x"]) {
		assert.equal(isGitCommitCommand(command), true, command);
	}
	for (const command of ["git status", "git log --grep commit", "echo git commit", "npm test", "git commit-tree abc"]) {
		assert.equal(isGitCommitCommand(command), false, command);
	}
});

// R1 review advisory: any `echo ... git` segment hid a real commit elsewhere in
// the command, while text that only mentioned `git commit` counted as one.
test("isGitCommitCommand counts a git invocation that starts a shell segment, not text that mentions one", () => {
	for (const command of ["echo 'staging git files' && git commit -m x", "echo git status; git commit -m x", "GIT_AUTHOR_DATE=now git commit -m x", "(cd pkg && git commit -m x)", "git add -A\ngit commit -m x", "git commit -m 'feat: git commit counting'"]) {
		assert.equal(isGitCommitCommand(command), true, command);
	}
	for (const command of ["printf 'run git commit now'", "gh pr create --body \"then git commit -m x\"", "grep -rn 'git commit' docs", "echo \"git commit -m x\""]) {
		assert.equal(isGitCommitCommand(command), false, command);
	}
});

test("commitTargetDirectory follows git -C and a leading cd", () => {
	assert.equal(commitTargetDirectory("git commit -m x", "/work/repo"), "/work/repo");
	assert.equal(commitTargetDirectory("git -C ../other commit -m x", "/work/repo"), "/work/other");
	assert.equal(commitTargetDirectory("cd /tmp/x && git commit -m x", "/work/repo"), "/tmp/x");
});

test("a feature branch reports authored changed lines since the default branch, lock files excluded", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/slice");
	commitFile("src/a.ts", 120);
	commitFile("pnpm-lock.yaml", 900);
	commitFile("tests/a.test.ts", 30);
	const report = await commitSliceReport(dir);
	assert.match(report ?? "", /^Commit slice: 150 authored changed lines in 3 commits on feat\/slice since main/);
	assert.match(report ?? "", /250 lines left before the ~400-line slice/);
});

test("past ~400 lines the report says to apply the delivery strategy before the next commit", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/big");
	commitFile("src/big.ts", 450);
	assert.match(await commitSliceReport(dir) ?? "", /450 authored changed lines in 1 commit on feat\/big since main\b.*Past the ~400-line slice: apply the feature's delivery strategy before the next commit/);
});

// R1 review advisory: the report ran git synchronously in the parent's
// tool_result handler, so the interface froze for as long as git took.
test("the parent keeps running while git computes the report", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/async");
	commitFile("src/a.ts", 10);
	let ran = false;
	setImmediate(() => { ran = true; });
	const report = await commitSliceReport(dir);
	assert.equal(ran, true, "the event loop ran while git answered");
	assert.match(report ?? "", /^Commit slice: 10 authored changed lines in 1 commit on feat\/async/);
});

// R1 review advisory: a failed or timed-out `git diff` read as an empty diff
// and reported "0 authored changed lines"; no number beats a wrong one.
test("a failed diff reports nothing instead of zero lines", async () => {
	const answers: Record<string, string | undefined> = {
		"symbolic-ref -q --short HEAD": "feat/slice",
		"symbolic-ref -q --short refs/remotes/origin/HEAD": "origin/main",
		"merge-base HEAD origin/main": "base",
		"rev-list --count base..HEAD": "2",
		"diff --numstat --no-renames base HEAD": "12\t3\tsrc/a.ts",
	};
	const git = async (args: string[]) => answers[args.join(" ")];
	assert.match(await commitSliceReport("/repo", git) ?? "", /^Commit slice: 15 authored changed lines in 2 commits/);
	delete answers["diff --numstat --no-renames base HEAD"];
	assert.equal(await commitSliceReport("/repo", git), undefined);
});

// R1 review advisory: a background job's result arrives when the job starts,
// before its commit exists, so its slice line would describe the old HEAD.
test("only a foreground bash commit carries the slice line", async () => {
	const git = async (args: string[]) => ({
		"symbolic-ref -q --short HEAD": "feat/slice",
		"symbolic-ref -q --short refs/remotes/origin/HEAD": "origin/main",
		"merge-base HEAD origin/main": "base",
		"rev-list --count base..HEAD": "1",
		"diff --numstat --no-renames base HEAD": "5\t0\tsrc/a.ts",
	} as Record<string, string>)[args.join(" ")];
	const event = (toolName: string) => ({ toolName, input: { command: "git commit -m x" }, isError: false, content: [{ type: "text" as const, text: "ok" }], structuredContent: undefined });
	assert.match(JSON.stringify((await commitSliceToolResult(event("bash"), "/repo", git))?.content), /Commit slice: 5 authored changed lines/);
	assert.equal(await commitSliceToolResult(event("bash_background"), "/repo", git), undefined);
	assert.equal(await commitSliceToolResult(event("monitor"), "/repo", git), undefined);
});

test("commits on the default branch, outside Git, or with nothing ahead report nothing", async (t) => {
	const { dir, git, commitFile } = repo(t);
	commitFile("src/direct.ts", 10);
	assert.equal(await commitSliceReport(dir), undefined, "the default branch has no slice");
	git("switch", "-q", "-c", "feat/empty");
	assert.equal(await commitSliceReport(dir), undefined, "nothing ahead of the default branch");
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "commit-slice-plain-")));
	t.after(() => rmSync(plain, { recursive: true, force: true }));
	assert.equal(await commitSliceReport(plain), undefined, "outside Git");
});
