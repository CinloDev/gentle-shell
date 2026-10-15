import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { commitSliceReport, commitTargetDirectory, isGitCommitCommand } from "../lib/commit-slice-signal.ts";

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

test("commitTargetDirectory follows git -C and a leading cd", () => {
	assert.equal(commitTargetDirectory("git commit -m x", "/work/repo"), "/work/repo");
	assert.equal(commitTargetDirectory("git -C ../other commit -m x", "/work/repo"), "/work/other");
	assert.equal(commitTargetDirectory("cd /tmp/x && git commit -m x", "/work/repo"), "/tmp/x");
});

test("a feature branch reports authored changed lines since the default branch, lock files excluded", (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/slice");
	commitFile("src/a.ts", 120);
	commitFile("pnpm-lock.yaml", 900);
	commitFile("tests/a.test.ts", 30);
	const report = commitSliceReport(dir);
	assert.match(report ?? "", /^Commit slice: 150 authored changed lines in 3 commits on feat\/slice since main/);
	assert.match(report ?? "", /250 lines left before the ~400-line slice/);
});

test("past ~400 lines the report says to apply the delivery strategy before the next commit", (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/big");
	commitFile("src/big.ts", 450);
	assert.match(commitSliceReport(dir) ?? "", /450 authored changed lines in 1 commit on feat\/big since main\b.*Past the ~400-line slice: apply the feature's delivery strategy before the next commit/);
});

test("commits on the default branch, outside Git, or with nothing ahead report nothing", (t) => {
	const { dir, git, commitFile } = repo(t);
	commitFile("src/direct.ts", 10);
	assert.equal(commitSliceReport(dir), undefined, "the default branch has no slice");
	git("switch", "-q", "-c", "feat/empty");
	assert.equal(commitSliceReport(dir), undefined, "nothing ahead of the default branch");
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "commit-slice-plain-")));
	t.after(() => rmSync(plain, { recursive: true, force: true }));
	assert.equal(commitSliceReport(plain), undefined, "outside Git");
});
