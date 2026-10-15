import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { WRITER_CONTEXT_BACKSTOP_TOKENS, rejectUndocumentedWriterLaunch } from "../lib/bounded-writer-admission.ts";

// Pain-point iteration S16. Prompt rules alone did not stop small-task delegation: on a two-feature request the
// orchestrator still started two writers for ~35-line units (USD 0.36 vs 0.20 inline). A generic writer launch is
// now admitted only for a task of an existing ODD feature document, or when the parent's measured context reaches
// the context backstop.

const surfaces = "\n\n## Allowed edit surfaces\nsrc/budget.ts\n";

function workspace(withDocument: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "writer-admission-"));
	if (withDocument) {
		mkdirSync(join(root, "odd", "tasks"), { recursive: true });
		writeFileSync(join(root, "odd", "tasks", "ledger.md"), "# Ledger\n");
	}
	return root;
}

test("S16: a writer launch without a feature-document task is rejected with an inline instruction", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Implement annual budgets.${surfaces}` }, { root, contextTokens: 20_000 });
	assert.ok(denied?.block, "the launch must be blocked");
	assert.match(denied.reason, /write this unit inline yourself/);
	assert.match(denied.reason, /do not retry/);
	assert.match(denied.reason, /never create a feature document only to launch writers/);
});

test("S16: a writer naming a task of an existing feature document is admitted", (t) => {
	const root = workspace(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Spec: odd/tasks/ledger.md, T2, S3-S4. Read until ## Log.${surfaces}` };
	assert.equal(rejectUndocumentedWriterLaunch(input, { root, contextTokens: 20_000 }), undefined);
	const viaContext = { agent: "worker", task: `Implement it.${surfaces}`, context: "Spec: odd/tasks/ledger.md, T1" };
	assert.equal(rejectUndocumentedWriterLaunch(viaContext, { root, contextTokens: 20_000 }), undefined);
});

test("S16: a Spec reference to a missing document, or one escaping the root, is rejected", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const spec of ["odd/tasks/ledger.md", "odd/tasks/../../etc/passwd.md"]) {
		const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Spec: ${spec}, T1${surfaces}` }, { root, contextTokens: 20_000 });
		assert.ok(denied?.block, `${spec} must not admit a writer`);
	}
});

test("S16: the measured context backstop admits a writer without a document", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Implement annual budgets.${surfaces}` };
	assert.equal(rejectUndocumentedWriterLaunch(input, { root, contextTokens: WRITER_CONTEXT_BACKSTOP_TOKENS }), undefined);
	assert.ok(rejectUndocumentedWriterLaunch(input, { root, contextTokens: null })?.block, "unknown context usage does not admit");
});

test("S16: previous behavior holds for non-writers and Judgment Day fix agents", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const agent of ["gentle-ai-explore", "gentle-ai-verify", "jd-fix-agent"]) {
		assert.equal(rejectUndocumentedWriterLaunch({ agent, task: "Read src/budget.ts" }, { root, contextTokens: 0 }), undefined, agent);
	}
});

type ToolCallHandler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;

function launchThroughHook(input: Record<string, unknown>, cwd: string, tokens: number) {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = { on(name: string, handler: ToolCallHandler) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	return handlers.get("tool_call")!({ toolName: "subagent_run", input }, {
		cwd, hasUI: false, ui: { confirm: async () => true },
		getContextUsage: () => ({ tokens, contextWindow: 272_000, percent: Math.round((tokens / 272_000) * 100) }),
	} as unknown as ExtensionContext);
}

test("S16: the orchestrator tool_call hook blocks an undocumented writer and admits a documented one", async (t) => {
	const bare = workspace(false);
	const documented = workspace(true);
	t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(documented, { recursive: true, force: true }); });
	const blocked = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Implement annual budgets.${surfaces}` }, bare, 20_000);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /write this unit inline yourself/);
	const admitted = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Spec: odd/tasks/ledger.md, T1. Read until ## Log.${surfaces}` }, documented, 20_000);
	assert.equal(admitted?.block, undefined);
	const explorer = await launchThroughHook({ agent: "gentle-ai-explore", mode: "task", task: "Map src/budget.ts" }, bare, 20_000);
	assert.equal(explorer?.block, undefined, "read-only subagents are unaffected");
});
