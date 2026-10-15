import { execFileSync } from "node:child_process";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// Harness roadmap T4 (R1): ODD slices delivery at about 400 authored changed
// lines, but the model had to estimate the count. After each parent commit the
// runtime reports it from Git, so the slicing decision reads a number.

export const SLICE_LINES = 400;

// Generated files that do not count as authored lines.
const GENERATED = [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/, /\.min\.(js|css)$/];

const COMMIT = /(^|[;&|(]\s*|\s)git(\s+-[Cc]\s+\S+)*\s+commit(\s|$)/;

export function isGitCommitCommand(command: string): boolean {
	return COMMIT.test(command) && !/(^|[;&|]\s*)echo\s[^;&|]*git/.test(command);
}

/** The directory the commit runs in: `git -C <dir>`, else a leading `cd <dir> &&`, else the session cwd. */
export function commitTargetDirectory(command: string, cwd: string): string {
	const gitDir = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(?:-[Cc]\s+\S+\s+)*commit\b/.exec(command)?.[1];
	const cdDir = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command)?.[1];
	const unquote = (value: string) => value.replace(/^["']|["']$/g, "");
	const base = cdDir ? resolve(cwd, unquote(cdDir)) : cwd;
	return gitDir ? resolve(base, unquote(gitDir)) : base;
}

type Git = (args: string[], cwd: string) => string | undefined;

const runGit: Git = (args, cwd) => {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
};

function defaultBranch(cwd: string, git: Git): string | undefined {
	const remote = git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (remote) return remote;
	return ["main", "master"].find((name) => git(["rev-parse", "--verify", "-q", `refs/heads/${name}`], cwd) !== undefined);
}

/** One line for the parent after a commit on a feature branch, or undefined when there is no slice to report. */
export function commitSliceReport(cwd: string, git: Git = runGit): string | undefined {
	const branch = git(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
	const target = branch === undefined ? undefined : defaultBranch(cwd, git);
	if (!branch || !target || branch === target || `origin/${branch}` === target) return undefined;
	const base = git(["merge-base", "HEAD", target], cwd);
	const commits = base ? Number(git(["rev-list", "--count", `${base}..HEAD`], cwd)) : 0;
	if (!base || !(commits > 0)) return undefined;
	let lines = 0;
	for (const row of (git(["diff", "--numstat", "--no-renames", base, "HEAD"], cwd) ?? "").split("\n")) {
		const [added, deleted, path] = row.split("\t");
		if (!path || added === "-" || GENERATED.some((pattern) => pattern.test(path))) continue;
		lines += Number(added) + Number(deleted);
	}
	const head = `Commit slice: ${lines} authored changed lines in ${commits} commit${commits === 1 ? "" : "s"} on ${branch} since ${target} (lock files excluded).`;
	return lines > SLICE_LINES
		? `${head} Past the ~${SLICE_LINES}-line slice: apply the feature's delivery strategy before the next commit (record the slice boundary in the feature document).`
		: `${head} ${SLICE_LINES - lines} lines left before the ~${SLICE_LINES}-line slice.`;
}

/** tool_result patch for a successful parent `git commit`: the slice line appended, structured content kept. */
export function commitSliceToolResult(event: Pick<ToolResultEvent, "input" | "isError" | "content" | "structuredContent">, cwd: string, git: Git = runGit): ToolResultEventResult | undefined {
	const command = (event.input as { command?: unknown } | undefined)?.command;
	if (event.isError !== false || typeof command !== "string" || !isGitCommitCommand(command)) return undefined;
	const report = commitSliceReport(commitTargetDirectory(command, cwd), git);
	if (!report) return undefined;
	return {
		content: [...event.content, { type: "text", text: `\n${report}` }],
		...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
	};
}
