import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Captured identity is a pure function of (session binding, cwd): the hot mode()
// path must not repeat filesystem/Git work per call, and publish must not repaint
// unchanged strings. Generation bumps and cwd changes must invalidate the cache.

const isolatedConfigHomes: string[] = [];
process.once("exit", () => { for (const home of isolatedConfigHomes) rmSync(home, { recursive: true, force: true }); });

function harness() {
	const home = mkdtempSync(join(tmpdir(), "yolo-capture-config-"));
	isolatedConfigHomes.push(home);
	let resolveCalls = 0, statusCalls = 0, widgetCalls = 0;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		events: { on: () => () => {} },
	} as unknown as ExtensionAPI;
	const controller = registerYoloSessionPolicy(pi, { GENTLE_PI_CONFIG_HOME: home }, {
		// Test seam: observe identity resolution without spawning Git.
		resolveIdentity: async () => { resolveCalls += 1; return undefined; },
	});
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => "capture-test" },
		ui: {
			notify() {},
			setStatus: () => { statusCalls += 1; },
			setWidget: () => { widgetCalls += 1; },
		},
	} as unknown as ExtensionContext;
	return {
		controller, ctx, commands,
		resolveCalls: () => resolveCalls,
		uiCalls: () => ({ status: statusCalls, widget: widgetCalls }),
	};
}

test("repeated mode() calls with no session change capture the identity only once", async () => {
	const h = harness();
	assert.equal(await h.controller.mode(h.ctx), "normal");
	assert.equal(h.resolveCalls(), 1);
	await h.controller.mode(h.ctx);
	await h.controller.mode(h.ctx);
	assert.equal(h.resolveCalls(), 1, "unchanged session and cwd reuse the captured identity");
});

test("after a mode change the next mode() re-captures and never answers the stale mode", async () => {
	const h = harness();
	assert.equal(await h.controller.mode(h.ctx), "normal");
	assert.equal(await h.controller.setMode("yolo", h.ctx), true);
	const resolveBefore = h.resolveCalls();
	assert.equal(await h.controller.mode(h.ctx), "yolo", "a generation bump re-reads the live mode");
	assert.equal(h.resolveCalls(), resolveBefore + 1, "the invalidated cache is re-captured, not reused");
});

test("publish writes UI only when the rendered strings change", async () => {
	const h = harness();
	await h.controller.mode(h.ctx);
	const first = h.uiCalls();
	assert.ok(first.status > 0 && first.widget > 0, "the first publication paints the status and widget");
	await h.controller.mode(h.ctx);
	assert.deepEqual(h.uiCalls(), first, "an unchanged mode() costs zero UI writes");
	await h.controller.setMode("yolo", h.ctx);
	const second = h.uiCalls();
	assert.ok(second.status > first.status && second.widget > first.widget, "an actual change still publishes");
	await h.controller.mode(h.ctx);
	assert.deepEqual(h.uiCalls(), second, "reading the settled mode does not repaint");
});

test("a cwd change re-captures and revokes instead of answering a stale workspace mode", async () => {
	const h = harness();
	assert.equal(await h.controller.setMode("yolo", h.ctx), true);
	const other = realpathSync(mkdtempSync(join(tmpdir(), "yolo-capture-cwd-")));
	try {
		Object.assign(h.ctx, { cwd: other });
		assert.equal(await h.controller.mode(h.ctx), "normal", "the new workspace never inherits the old binding");
		assert.equal(h.resolveCalls(), 2, "the cwd change forced a fresh capture");
		await h.controller.mode(h.ctx);
		assert.equal(h.resolveCalls(), 2, "the new workspace is then cached like any other");
	} finally { rmSync(other, { recursive: true, force: true }); }
});
