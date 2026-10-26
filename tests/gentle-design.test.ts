import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleDesign, { DESIGN_COMMAND_NAME } from "../extensions/gentle-design.ts";
import { formatDesignComment, formatDesignCommentBatch, startDesignCanvasServer, type DesignCanvasServer, type DesignCanvasServerOptions, type DesignComment } from "../lib/design-canvas-server.ts";
import type { OpenInBrowserResult } from "../lib/design-open-browser.ts";
import { __testing } from "../extensions/skill-registry.ts";

// /gentle:design wiring: a brief starts one design run through the
// gentle-design skill; open/no arguments show the canvas for a design in the
// session cwd; stop and session shutdown close it; canvas comments reach the
// session; sync runs the skill's design-system mode; implement hands an
// artboard off to code.

const SKILL_PATH = fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));

type Registration = { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> };
type Sent = { content: unknown; options: unknown };
type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type Tool = { name: string; description: string; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ToolResult> };

function fakePi(skillLoaded = true) {
	const commands = new Map<string, Registration>();
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Sent[] = [];
	const pi = {
		registerCommand: (name: string, registration: Registration) => commands.set(name, registration),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getCommands: () => (skillLoaded ? [{ name: "skill:gentle-design", source: "skill" }] : []),
		sendUserMessage: (content: unknown, options?: unknown) => sent.push({ content, options }),
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, {});
	};
	return { pi, sent, emit, command: () => commands.get(DESIGN_COMMAND_NAME)!, tool: (name: string) => tools.get(name) };
}

function fakeContext(cwd: string, idle = true) {
	const notices: Array<{ message: string; level?: string }> = [];
	const state = { idle };
	const ctx = {
		hasUI: true,
		cwd,
		isIdle: () => state.idle,
		sessionManager: { getCwd: () => cwd },
		ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
	} as unknown as ExtensionContext;
	return { ctx, notices, state };
}

const scratchDirs: string[] = [];
test.after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-test-"));
	scratchDirs.push(dir);
	return dir;
}

function writeDesign(cwd: string, slug: string, title: string, mtimeSeconds?: number) {
	mkdirSync(join(cwd, "design", slug), { recursive: true });
	const manifest = join(cwd, "design", slug, "design.json");
	writeFileSync(manifest, JSON.stringify({ title, brief: "b", artboards: [{ file: "01-a.html", title: "A", tradeoff: "t", width: 800, height: 600 }] }));
	writeFileSync(join(cwd, "design", slug, "01-a.html"), "<h1>A</h1>");
	if (mtimeSeconds !== undefined) utimesSync(manifest, mtimeSeconds, mtimeSeconds);
}

const unexpectedServer = async (): Promise<DesignCanvasServer> => { throw new Error("no canvas server expected"); };
const unexpectedBrowser = async (): Promise<OpenInBrowserResult> => { throw new Error("no browser expected"); };

/** Fake canvas server factory: records starts, closes and the comment callback. */
function fakeCanvas(opened: OpenInBrowserResult = { opened: true }) {
	const starts: DesignCanvasServerOptions[] = [];
	const opens: string[] = [];
	let closes = 0;
	const startServer = async (options: DesignCanvasServerOptions): Promise<DesignCanvasServer> => {
		starts.push(options);
		const base = "http://127.0.0.1:4100/tok/";
		return { port: 4100, token: "tok", url: options.initialSlug ? `${base}d/${options.initialSlug}/` : base, close: async () => { closes++; } };
	};
	const openBrowser = async (url: string) => { opens.push(url); return opened; };
	return { startServer, openBrowser, starts, opens, closes: () => closes };
}

test("registers /gentle:design with help text naming the brief form and every subcommand", () => {
	const { pi, command } = fakePi();
	gentleDesign(pi);
	assert.equal(DESIGN_COMMAND_NAME, "gentle:design");
	const description = command().description;
	for (const word of ["<brief>", "open", "stop", "sync", "implement"]) assert.ok(description.includes(word), `help names ${word}`);
});

test("a brief sends exactly one message that runs the gentle-design skill with that brief", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi);
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("  a pricing page for a note-taking app  ", ctx);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].content, "/skill:gentle-design a pricing page for a note-taking app");
	assert.deepEqual(sent[0].options, { expandPromptTemplates: true });
	assert.deepEqual(notices, []);
});

test("without the skill loaded, the message points the model at the bundled skill file", async () => {
	const { pi, sent, command } = fakePi(false);
	gentleDesign(pi);
	await command().handler("a login screen", fakeContext(scratchCwd()).ctx);
	assert.equal(sent.length, 1);
	const content = String(sent[0].content);
	assert.ok(!content.startsWith("/"), "a plain message, not a slash command");
	assert.ok(content.includes(SKILL_PATH), "names the skill file by absolute path");
	assert.ok(content.includes("a login screen"));
});

test("while the agent is busy the design run is queued as a follow-up", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi);
	await command().handler("a dashboard", fakeContext(scratchCwd(), false).ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { expandPromptTemplates: true, deliverAs: "followUp" });
});

test("no arguments and no designs prints usage only and sends nothing", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi);
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("", ctx);
	assert.equal(sent.length, 0);
	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /\/gentle:design <brief>/);
	assert.doesNotMatch(notices[0].message, /Designs in this project/);
});

test("a whitespace-only brief behaves like no arguments", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi);
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler(" \t\n ", ctx);
	assert.equal(sent.length, 0);
	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /\/gentle:design <brief>/);
});

test("open starts one canvas server on design/, opens the slug URL and notifies it; a second open reuses it", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "pricing-page", "Pricing page");
	writeDesign(cwd, "login", "Login screen");
	const { pi, sent, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("open pricing-page", ctx);
	assert.equal(canvas.starts.length, 1);
	assert.equal(canvas.starts[0].designRoot, join(cwd, "design"));
	assert.deepEqual(canvas.opens, ["http://127.0.0.1:4100/tok/d/pricing-page/"]);
	assert.deepEqual(notices, [{ message: "Design canvas: http://127.0.0.1:4100/tok/d/pricing-page/", level: "info" }]);
	await command().handler("open login", ctx);
	assert.equal(canvas.starts.length, 1, "the running server is reused");
	assert.deepEqual(canvas.opens.at(-1), "http://127.0.0.1:4100/tok/d/login/");
	assert.equal(notices.at(-1)!.message, "Design canvas: http://127.0.0.1:4100/tok/d/login/");
	assert.equal(sent.length, 0);
});

test("when the browser cannot open, the URL is still printed with a manual hint", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const { pi, command } = fakePi();
	const canvas = fakeCanvas({ opened: false, error: "spawn xdg-open ENOENT" });
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("open login", ctx);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.equal(notices[0].message, "Design canvas: http://127.0.0.1:4100/tok/d/login/\nThe browser could not be opened (spawn xdg-open ENOENT). Open the URL manually.");
});

test("an unknown or invalid slug warns with the available slugs and starts nothing", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "pricing-page", "Pricing page", 2000);
	writeDesign(cwd, "login", "Login screen", 1000);
	mkdirSync(join(cwd, "design", "no-manifest"), { recursive: true });
	mkdirSync(join(cwd, "design", "broken"), { recursive: true });
	writeFileSync(join(cwd, "design", "broken", "design.json"), "{not json");
	utimesSync(join(cwd, "design", "broken", "design.json"), 500, 500);
	for (const slug of ["missing", "../login", "Login", "no-manifest", "a b"]) {
		const { pi, command } = fakePi();
		const canvas = fakeCanvas();
		gentleDesign(pi, canvas);
		const { ctx, notices } = fakeContext(cwd);
		await command().handler(`open ${slug}`, ctx);
		assert.equal(canvas.starts.length, 0, slug);
		assert.deepEqual(canvas.opens, [], slug);
		assert.equal(notices.length, 1, slug);
		assert.equal(notices[0].level, "warning", slug);
		assert.equal(notices[0].message, `No design "${slug}" in design/. Available: pricing-page, login, broken.`, slug);
	}
});

test("open without designs warns with usage and starts nothing", async () => {
	const { pi, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("open", ctx);
	assert.equal(canvas.starts.length, 0);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
	assert.match(notices[0].message, /No designs in design\/ yet/);
	assert.match(notices[0].message, /\/gentle:design <brief>/);
});

test("open <slug> without designs keeps the same no-designs warning as open", async () => {
	const { pi, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const cwd = scratchCwd();
	const bare = fakeContext(cwd);
	await command().handler("open", bare.ctx);
	const named = fakeContext(cwd);
	await command().handler("open foo", named.ctx);
	assert.equal(canvas.starts.length, 0);
	assert.deepEqual(named.notices, bare.notices);
});

test("no arguments with designs opens the most recent design by design.json mtime", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "alpha", "Alpha", 1000);
	writeDesign(cwd, "zeta", "Zeta", 3000);
	writeDesign(cwd, "beta", "Beta", 2000);
	for (const args of ["", "open"]) {
		const { pi, sent, command } = fakePi();
		const canvas = fakeCanvas();
		gentleDesign(pi, canvas);
		const { ctx, notices } = fakeContext(cwd);
		await command().handler(args, ctx);
		assert.deepEqual(canvas.opens, ["http://127.0.0.1:4100/tok/d/zeta/"], JSON.stringify(args));
		assert.equal(notices.length, 1);
		assert.equal(notices[0].message, "Design canvas: http://127.0.0.1:4100/tok/d/zeta/");
		assert.equal(sent.length, 0);
	}
});

test("stop closes the running canvas, and reports when none is running", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const { pi, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("stop", ctx);
	assert.deepEqual(notices.at(-1), { message: "No design canvas is running.", level: "info" });
	await command().handler("open login", ctx);
	await command().handler("stop", ctx);
	assert.equal(canvas.closes(), 1);
	assert.deepEqual(notices.at(-1), { message: "Design canvas stopped.", level: "info" });
	await command().handler("stop", ctx);
	assert.equal(notices.at(-1)!.message, "No design canvas is running.");
	await command().handler("open login", ctx);
	assert.equal(canvas.starts.length, 2, "open after stop starts a fresh server");
});

test("session shutdown closes the canvas server", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const { pi, emit, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(canvas.closes(), 0, "nothing to close yet");
	await command().handler("open login", fakeContext(cwd).ctx);
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(canvas.closes(), 1);
});

test("a canvas comment reaches the session, as a follow-up while the agent is busy", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const { pi, sent, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, state } = fakeContext(cwd);
	await command().handler("open login", ctx);
	const comment: DesignComment = { id: "abc123", slug: "login", file: "01-a.html", selector: "body > h1", excerpt: "A", comment: "Bigger" };
	await canvas.starts[0].onComment(comment);
	assert.deepEqual(sent.at(-1), { content: formatDesignComment(comment), options: undefined });
	state.idle = false;
	await canvas.starts[0].onComment(comment);
	assert.deepEqual(sent.at(-1), { content: formatDesignComment(comment), options: { deliverAs: "followUp" } });
	assert.equal(sent.length, 2);
	const batch = [comment, { ...comment, id: "def456", comment: "Smaller" }];
	await canvas.starts[0].onComments!(batch);
	assert.deepEqual(sent.at(-1), { content: formatDesignCommentBatch(batch), options: { deliverAs: "followUp" } });
	assert.equal(sent.length, 3, "a batch is one message");
});

test("integration: a comment POSTed to the real canvas server sends one session message", async (t) => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const { pi, sent, emit, command } = fakePi();
	const opens: string[] = [];
	gentleDesign(pi, { openBrowser: async (url) => { opens.push(url); return { opened: true }; } });
	t.after(() => emit("session_shutdown", { type: "session_shutdown", reason: "quit" }));
	await command().handler("open login", fakeContext(cwd).ctx);
	assert.equal(opens.length, 1);
	const url = new URL(opens[0]);
	assert.equal(url.hostname, "127.0.0.1");
	const token = url.pathname.split("/")[1];
	const body = JSON.stringify({ slug: "login", file: "01-a.html", selector: "body > h1", excerpt: " A ", comment: "Make it red" });
	const status = await new Promise<number>((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: url.port, path: `/${token}/api/comments`, method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end(body);
	});
	assert.equal(status, 202);
	const stored = JSON.parse(readFileSync(join(cwd, "design", "login", "comments.json"), "utf8")).comments;
	assert.equal(stored.length, 1);
	assert.notEqual(stored[0].sentAt, null);
	assert.deepEqual(sent, [{ content: formatDesignComment({ id: stored[0].id, slug: "login", file: "01-a.html", selector: "body > h1", excerpt: "A", comment: "Make it red" }), options: undefined }]);
});

function writeLinkedDesign(cwd: string, slug: string, feature?: unknown) {
	mkdirSync(join(cwd, "design", slug), { recursive: true });
	writeFileSync(join(cwd, "design", slug, "design.json"), JSON.stringify({
		title: "Login screen",
		brief: "b",
		...(feature === undefined ? {} : { feature }),
		artboards: [
			{ file: "01-split.html", title: "Split layout", tradeoff: "Calm; less room for the form", width: 1440, height: 900 },
			{ file: "02-card.html", title: "Centered card", tradeoff: "Focused; generic", width: 1440, height: 900 },
		],
	}));
	writeFileSync(join(cwd, "design", slug, "01-split.html"), "<h1>Split</h1>");
	writeFileSync(join(cwd, "design", slug, "02-card.html"), "<h1>Card</h1>");
}

test("implement sends one handoff message with the artboard, tokens, open comments and feature link", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "odd/tasks/login-page.md");
	writeFileSync(join(cwd, "design", "system.md"), "# Tokens");
	seedComments(cwd, "login", [
		{ id: "open01", file: "01-split.html", comment: "Make the headline shorter" },
		{ id: "done01", file: "01-split.html", status: "resolved" },
		{ id: "other1", file: "02-card.html" },
	]);
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("implement login/01-split.html", ctx);
	assert.deepEqual(notices, []);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].options, undefined);
	const content = String(sent[0].content);
	for (const part of ["design/login/01-split.html", "Split layout", "Calm; less room for the form", "real stack", "visual spec", "existing components", "verbatim", "design/system.md", "open01", "body > h1", "\"A\"", "Make the headline shorter", "gentle_design_comments", "track this implementation in odd/tasks/login-page.md", "This handoff itself commits nothing."]) {
		assert.ok(content.includes(part), `the message names ${part}`);
	}
	for (const absent of ["done01", "other1", "ODD rules as usual"]) assert.ok(!content.includes(absent), `the message omits ${absent}`);
});

test("implement without system.md, comments or a valid feature falls back to the ODD rules", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "../outside.md");
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	await command().handler("implement login/02-card.html", fakeContext(cwd).ctx);
	assert.equal(sent.length, 1);
	const content = String(sent[0].content);
	assert.ok(content.includes("design/login/02-card.html"));
	assert.ok(content.includes("size it under the project's ODD rules as usual"));
	assert.ok(content.includes("This handoff itself commits nothing."));
	for (const absent of ["design/system.md", "track this implementation", "outside.md", "gentle_design_comments"]) assert.ok(!content.includes(absent), `the message omits ${absent}`);
});

test("implement reports an invalid feature link instead of dropping it silently", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "../outside.md");
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("implement login/02-card.html", ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(notices, [{ message: "design/login/design.json: feature must be a relative odd/tasks/<name>.md path; it was ignored", level: "warning" }]);
});

test("implement with a valid feature link reports nothing", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login");
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("implement login/01-split.html", ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(notices, []);
});

test("implement of an unknown design or artboard warns with the valid targets and sends nothing", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login");
	for (const args of ["implement", "implement login", "implement missing/01-split.html", "implement login/99-none.html", "implement login/../x.html"]) {
		const { pi, sent, command } = fakePi();
		gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
		const { ctx, notices } = fakeContext(cwd);
		await command().handler(args, ctx);
		assert.equal(sent.length, 0, args);
		assert.equal(notices.length, 1, args);
		assert.equal(notices[0].level, "warning", args);
		assert.match(notices[0].message, /login\/01-split\.html, login\/02-card\.html/, args);
	}
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("implement login/01-split.html", ctx);
	assert.equal(sent.length, 0);
	assert.match(notices[0].message, /No designs in design\/ yet/);
});

test("implement is queued as a follow-up while the agent is busy", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login");
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	await command().handler("implement login/01-split.html", fakeContext(cwd, false).ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
});

test("integration: the canvas Implement route sends the same text as the command", async (t) => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "odd/tasks/login-page.md");
	writeFileSync(join(cwd, "design", "system.md"), "# Tokens");
	seedComments(cwd, "login", [{ id: "open01", file: "01-split.html" }]);
	const { pi, sent, emit, command } = fakePi();
	const opens: string[] = [];
	gentleDesign(pi, { openBrowser: async (url) => { opens.push(url); return { opened: true }; } });
	t.after(() => emit("session_shutdown", { type: "session_shutdown", reason: "quit" }));
	const { ctx } = fakeContext(cwd);
	await command().handler("implement login/01-split.html", ctx);
	await command().handler("open login", ctx);
	const url = new URL(opens[0]);
	const token = url.pathname.split("/")[1];
	const status = await new Promise<number>((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: url.port, path: `/${token}/api/designs/login/implement`, method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end(JSON.stringify({ file: "01-split.html" }));
	});
	assert.equal(status, 202);
	assert.equal(sent.length, 2);
	assert.equal(sent[1].content, sent[0].content);
	assert.ok(String(sent[0].content).includes("open01"));
});

test("with only design/system.html, no arguments and open start the canvas on the system board", async () => {
	const cwd = scratchCwd();
	mkdirSync(join(cwd, "design"), { recursive: true });
	writeFileSync(join(cwd, "design", "system.html"), "<h1>Tokens</h1>");
	for (const args of ["", "open"]) {
		const { pi, sent, command } = fakePi();
		const canvas = fakeCanvas();
		gentleDesign(pi, canvas);
		const { ctx, notices } = fakeContext(cwd);
		await command().handler(args, ctx);
		assert.equal(canvas.starts.length, 1, JSON.stringify(args));
		assert.deepEqual(canvas.opens, ["http://127.0.0.1:4100/tok/"], JSON.stringify(args));
		assert.deepEqual(notices, [{ message: "Design canvas: http://127.0.0.1:4100/tok/", level: "info" }]);
		assert.equal(sent.length, 0);
	}
	const { pi, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("open login", ctx);
	assert.equal(canvas.starts.length, 0, "a named design still has to exist");
	assert.equal(notices[0].level, "warning");
});

test("the skill documents the feature field and the ODD link rule", () => {
	const source = readFileSync(SKILL_PATH, "utf8");
	assert.ok(source.includes("\"feature\": \"odd/tasks/"), "the manifest example carries a feature link");
	const start = source.indexOf("ODD link");
	assert.ok(start !== -1, "SKILL.md has an ODD link rule");
	for (const part of ["odd/tasks/", "## Log", "standalone"]) assert.ok(source.includes(part), `SKILL.md mentions ${part}`);
});

function toolText(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

function seedComments(cwd: string, slug: string, comments: Array<{ id: string; file?: string; status?: string; comment?: string }>) {
	const entries = comments.map((entry) => ({
		id: entry.id,
		file: entry.file ?? "01-a.html",
		selector: "body > h1",
		excerpt: "A",
		comment: entry.comment ?? `comment ${entry.id}`,
		createdAt: "2026-10-26T10:00:00.000Z",
		status: entry.status ?? "open",
		sentAt: null,
		resolvedAt: entry.status === "resolved" ? "2026-10-26T11:00:00.000Z" : null,
	}));
	writeFileSync(join(cwd, "design", slug, "comments.json"), JSON.stringify({ version: 1, comments: entries }));
}

test("the gentle_design_comments tool lists open comments, by design and artboard", async () => {
	const cwd = scratchCwd();
	// Designs are listed most recent first.
	writeDesign(cwd, "login", "Login screen", 2000);
	writeDesign(cwd, "pricing", "Pricing", 1000);
	seedComments(cwd, "login", [{ id: "aaa111", comment: "Bigger title" }, { id: "bbb222", status: "resolved" }, { id: "ccc333", file: "02-b.html" }]);
	seedComments(cwd, "pricing", [{ id: "ddd444", comment: "Cheaper" }]);
	const { pi, tool } = fakePi();
	gentleDesign(pi);
	const comments = tool("gentle_design_comments");
	assert.ok(comments, "the tool is registered");
	assert.match(comments.description, /comments\.json/);
	const ctx = fakeContext(cwd).ctx;
	const all = await comments.execute("1", { action: "list" }, undefined, undefined, ctx);
	const text = toolText(all);
	for (const id of ["aaa111", "ccc333", "ddd444"]) assert.ok(text.includes(id), id);
	assert.ok(!text.includes("bbb222"), "resolved comments are not listed");
	assert.ok(text.includes("design/login/01-a.html") && text.includes("Bigger title"));
	assert.deepEqual((all.details as { comments: Array<{ id: string }> }).comments.map((entry) => entry.id), ["aaa111", "ccc333", "ddd444"]);
	const one = await comments.execute("2", { action: "list", slug: "login", file: "02-b.html" }, undefined, undefined, ctx);
	assert.deepEqual((one.details as { comments: Array<{ id: string }> }).comments.map((entry) => entry.id), ["ccc333"]);
	const none = await comments.execute("3", { action: "list", slug: "pricing", file: "09-z.html" }, undefined, undefined, ctx);
	assert.match(toolText(none), /No open comments/);
});

test("the gentle_design_comments tool resolves comments by id and writes comments.json", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	seedComments(cwd, "login", [{ id: "aaa111" }, { id: "bbb222" }]);
	const { pi, tool } = fakePi();
	gentleDesign(pi);
	const ctx = fakeContext(cwd).ctx;
	const result = await tool("gentle_design_comments")!.execute("1", { action: "resolve", slug: "login", ids: ["aaa111", "zzz999"] }, undefined, undefined, ctx);
	assert.match(toolText(result), /Resolved 1 comment/);
	assert.match(toolText(result), /zzz999/);
	const stored = JSON.parse(readFileSync(join(cwd, "design", "login", "comments.json"), "utf8")).comments;
	assert.equal(stored[0].status, "resolved");
	assert.notEqual(stored[0].resolvedAt, null);
	assert.equal(stored[1].status, "open");
	await assert.rejects(tool("gentle_design_comments")!.execute("2", { action: "resolve", slug: "login", ids: [] }, undefined, undefined, ctx), /ids/);
	await assert.rejects(tool("gentle_design_comments")!.execute("3", { action: "resolve", ids: ["aaa111"] }, undefined, undefined, ctx), /slug/);
	await assert.rejects(tool("gentle_design_comments")!.execute("4", { action: "resolve", slug: "missing", ids: ["aaa111"] }, undefined, undefined, ctx), /missing/);
	writeFileSync(join(cwd, "design", "login", "comments.json"), "{ broken");
	await assert.rejects(tool("gentle_design_comments")!.execute("5", { action: "list", slug: "login" }, undefined, undefined, ctx), /comments\.json/);
	assert.equal(readFileSync(join(cwd, "design", "login", "comments.json"), "utf8"), "{ broken");
});

// Advisory 8: the command and the canvas server list designs with one containment rule.
test("a symlinked design inside design/ is listed by the command and the server; one escaping it by neither", async (t) => {
	const cwd = scratchCwd();
	const outside = scratchCwd();
	writeDesign(cwd, "real", "Real design", 3000);
	// The link target lives inside design/ under a non-slug name, so only the link is a design.
	mkdirSync(join(cwd, "design", "_shelf", "kept"), { recursive: true });
	writeFileSync(join(cwd, "design", "_shelf", "kept", "design.json"), JSON.stringify({ title: "Linked", artboards: [{ file: "01-a.html", title: "A", width: 800, height: 600 }] }));
	writeFileSync(join(cwd, "design", "_shelf", "kept", "01-a.html"), "<h1>A</h1>");
	symlinkSync(join(cwd, "design", "_shelf", "kept"), join(cwd, "design", "linked"));
	writeDesign(outside, "away", "Away");
	symlinkSync(join(outside, "design", "away"), join(cwd, "design", "escaped"));
	const { pi, command } = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(pi, canvas);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("open linked", ctx);
	assert.deepEqual(canvas.opens, ["http://127.0.0.1:4100/tok/d/linked/"]);
	await command().handler("open escaped", ctx);
	assert.equal(canvas.opens.length, 1);
	assert.equal(notices.at(-1)!.level, "warning");
	assert.match(notices.at(-1)!.message, /Available: /);
	const available = notices.at(-1)!.message.replace(/^.*Available: /s, "").replace(/\.$/, "").split(", ").sort();
	assert.deepEqual(available, ["linked", "real"]);
	const server = await startDesignCanvasServer({ designRoot: join(cwd, "design"), onComment: () => {}, randomToken: () => "listing-token-0123456789" });
	t.after(() => server.close());
	const listed = await new Promise<string>((resolve, reject) => {
		httpRequest({ host: "127.0.0.1", port: server.port, path: "/listing-token-0123456789/api/designs" }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => { body += chunk; });
			res.on("end", () => resolve(body));
		}).on("error", reject).end();
	});
	assert.deepEqual(JSON.parse(listed).designs.map((design: { slug: string }) => design.slug).sort(), available);
});

test("sync sends exactly one message that runs the gentle-design skill in sync mode", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("sync", ctx);
	assert.equal(sent.length, 1);
	const content = String(sent[0].content);
	assert.ok(content.startsWith("/skill:gentle-design sync "), content);
	for (const part of ["design/system.md", "design/system.html"]) assert.ok(content.includes(part), `names ${part}`);
	assert.deepEqual(sent[0].options, { expandPromptTemplates: true });
	assert.deepEqual(notices, []);
});

test("sync with extra words warns and sends nothing", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx, notices } = fakeContext(scratchCwd());
	await command().handler("sync only the buttons", ctx);
	assert.equal(sent.length, 0);
	assert.deepEqual(notices, [{ message: "/gentle:design sync takes no arguments.", level: "warning" }]);
});

test("sync is queued as a follow-up while the agent is busy", async () => {
	const { pi, sent, command } = fakePi();
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	await command().handler("sync", fakeContext(scratchCwd(), false).ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { expandPromptTemplates: true, deliverAs: "followUp" });
});

test("without the skill loaded, sync points the model at the bundled skill file", async () => {
	const { pi, sent, command } = fakePi(false);
	gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	await command().handler("sync", fakeContext(scratchCwd()).ctx);
	assert.equal(sent.length, 1);
	const content = String(sent[0].content);
	assert.ok(!content.startsWith("/"), "a plain message, not a slash command");
	assert.ok(content.includes(SKILL_PATH), "names the skill file by absolute path");
	assert.ok(content.includes("Design system sync"), "names the skill section to follow");
	assert.ok(content.includes("design/system.md"));
});

test("the skill's Design system sync section names both files and the self-check rule", () => {
	const source = readFileSync(SKILL_PATH, "utf8");
	const start = source.indexOf("## Design system sync");
	assert.ok(start !== -1, "SKILL.md has a Design system sync section");
	const section = source.slice(start, source.indexOf("\n## ", start + 1));
	for (const part of ["design/system.md", "design/system.html", "1440", "Self-check", "never edit"]) {
		assert.ok(section.includes(part), `the section mentions ${part}`);
	}
});

test("skills/design/SKILL.md is named gentle-design and documents the manifest fields", () => {
	const source = readFileSync(SKILL_PATH, "utf8");
	assert.equal(__testing.parseFrontmatter(source).name, "gentle-design");
	for (const field of ["design.json", "\"title\"", "\"brief\"", "\"artboards\"", "\"file\"", "\"tradeoff\"", "\"width\"", "\"height\"", "design/system.md", "Copy as prompt"]) {
		assert.ok(source.includes(field), `SKILL.md mentions ${field}`);
	}
});

// S11: the gentle_design tool reaches every /gentle:design action without the
// command, and a system-prompt hint makes the gentle-design flow the default.

function designTool(fake: ReturnType<typeof fakePi>) {
	const tool = fake.tool("gentle_design");
	assert.ok(tool, "the gentle_design tool is registered");
	return (params: unknown, ctx: ExtensionContext) => tool.execute("call", params, undefined, undefined, ctx);
}

test("the gentle_design tool description says when to use it and leaves briefs and sync to the skill", () => {
	const fake = fakePi();
	gentleDesign(fake.pi);
	const description = fake.tool("gentle_design")!.description;
	for (const part of ["list", "open", "stop", "implement", "canvas", "<slug>/<artboard>", "gentle-design skill", "sync"]) assert.ok(description.includes(part), `the description names ${part}`);
});

test("gentle_design list names each design with its artboards, the system board and the canvas state", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login");
	writeDesign(cwd, "pricing", "Pricing", 1000);
	utimesSync(join(cwd, "design", "login", "design.json"), 2000, 2000);
	writeFileSync(join(cwd, "design", "system.html"), "<h1>Tokens</h1>");
	const fake = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(fake.pi, canvas);
	const run = designTool(fake);
	const { ctx } = fakeContext(cwd);
	const result = await run({ action: "list" }, ctx);
	assert.equal(toolText(result), [
		"Designs in design/ (2):",
		"- login: Login screen",
		"  - 01-split.html: Split layout",
		"  - 02-card.html: Centered card",
		"- pricing: Pricing",
		"  - 01-a.html: A",
		"System board: design/system.html (shown first on the canvas).",
		"Canvas: not running.",
	].join("\n"));
	assert.deepEqual(result.details, {
		designs: [
			{ slug: "login", title: "Login screen", artboards: [{ file: "01-split.html", title: "Split layout" }, { file: "02-card.html", title: "Centered card" }] },
			{ slug: "pricing", title: "Pricing", artboards: [{ file: "01-a.html", title: "A" }] },
		],
		systemBoard: true,
		canvas: { running: false },
	});
	assert.equal(canvas.starts.length, 0, "list starts nothing");
	await run({ action: "open", slug: "pricing" }, ctx);
	const running = await run({ action: "list" }, ctx);
	assert.ok(toolText(running).endsWith("Canvas: running at http://127.0.0.1:4100/tok/d/pricing/"), toolText(running));
	assert.deepEqual((running.details as { canvas: unknown }).canvas, { running: true, url: "http://127.0.0.1:4100/tok/d/pricing/" });
	await run({ action: "stop" }, ctx);
	assert.deepEqual(((await run({ action: "list" }, ctx)).details as { canvas: unknown }).canvas, { running: false });
});

test("gentle_design list with no designs, and with only the system board", async () => {
	const fake = fakePi();
	gentleDesign(fake.pi, fakeCanvas());
	const run = designTool(fake);
	const cwd = scratchCwd();
	const empty = await run({ action: "list" }, fakeContext(cwd).ctx);
	assert.equal(toolText(empty), "No designs in design/ yet.\nNo system board (design/system.html).\nCanvas: not running.");
	assert.deepEqual(empty.details, { designs: [], systemBoard: false, canvas: { running: false } });
	mkdirSync(join(cwd, "design"), { recursive: true });
	writeFileSync(join(cwd, "design", "system.html"), "<h1>Tokens</h1>");
	const system = await run({ action: "list" }, fakeContext(cwd).ctx);
	assert.equal(toolText(system), "No designs in design/ yet.\nSystem board: design/system.html (shown first on the canvas).\nCanvas: not running.");
	assert.deepEqual(system.details, { designs: [], systemBoard: true, canvas: { running: false } });
});

test("gentle_design open starts the canvas once, returns its URL, and /gentle:design open reuses that server", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "pricing-page", "Pricing page", 2000);
	writeDesign(cwd, "login", "Login screen", 1000);
	const fake = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(fake.pi, canvas);
	const run = designTool(fake);
	const { ctx, notices } = fakeContext(cwd);
	const opened = await run({ action: "open", slug: "login" }, ctx);
	assert.equal(toolText(opened), "Design canvas: http://127.0.0.1:4100/tok/d/login/");
	assert.deepEqual(opened.details, { url: "http://127.0.0.1:4100/tok/d/login/", opened: true });
	assert.equal(canvas.starts.length, 1);
	const latest = await run({ action: "open" }, ctx);
	assert.deepEqual(latest.details, { url: "http://127.0.0.1:4100/tok/d/pricing-page/", opened: true }, "no slug opens the most recent design");
	await fake.command().handler("open login", ctx);
	assert.equal(canvas.starts.length, 1, "the command reuses the tool's server");
	assert.deepEqual(notices, [{ message: toolText(opened), level: "info" }], "the command shows the same notice text");
	await fake.command().handler("stop", ctx);
	assert.equal(canvas.closes(), 1);
	assert.equal(fake.sent.length, 0);
});

test("gentle_design open reports the manual URL when the browser cannot open", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const fake = fakePi();
	gentleDesign(fake.pi, fakeCanvas({ opened: false, error: "spawn xdg-open ENOENT" }));
	const result = await designTool(fake)({ action: "open", slug: "login" }, fakeContext(cwd).ctx);
	assert.equal(toolText(result), "Design canvas: http://127.0.0.1:4100/tok/d/login/\nThe browser could not be opened (spawn xdg-open ENOENT). Open the URL manually.");
	assert.deepEqual(result.details, { url: "http://127.0.0.1:4100/tok/d/login/", opened: false });
});

test("gentle_design open of an unknown slug fails naming the valid slugs and starts nothing", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "pricing-page", "Pricing page", 2000);
	writeDesign(cwd, "login", "Login screen", 1000);
	const fake = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(fake.pi, canvas);
	await assert.rejects(designTool(fake)({ action: "open", slug: "missing" }, fakeContext(cwd).ctx), { message: 'No design "missing" in design/. Available: pricing-page, login.' });
	await assert.rejects(designTool(fake)({ action: "open" }, fakeContext(scratchCwd()).ctx), /No designs in design\/ yet/);
	assert.equal(canvas.starts.length, 0);
});

test("gentle_design stop closes the canvas, and reports when none is running", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const fake = fakePi();
	const canvas = fakeCanvas();
	gentleDesign(fake.pi, canvas);
	const run = designTool(fake);
	const { ctx } = fakeContext(cwd);
	assert.equal(toolText(await run({ action: "stop" }, ctx)), "No design canvas is running.");
	await fake.command().handler("open login", ctx);
	const stopped = await run({ action: "stop" }, ctx);
	assert.equal(toolText(stopped), "Design canvas stopped.");
	assert.deepEqual(stopped.details, { stopped: true });
	assert.equal(canvas.closes(), 1);
	assert.deepEqual((await run({ action: "stop" }, ctx)).details, { stopped: false });
});

test("gentle_design implement returns the command's handoff text and sends no message", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "odd/tasks/login-page.md");
	writeFileSync(join(cwd, "design", "system.md"), "# Tokens");
	seedComments(cwd, "login", [{ id: "open01", file: "01-split.html" }]);
	const fake = fakePi();
	gentleDesign(fake.pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const { ctx } = fakeContext(cwd);
	const result = await designTool(fake)({ action: "implement", target: "login/01-split.html" }, ctx);
	assert.equal(fake.sent.length, 0, "the tool sends no user message");
	assert.equal(result.content.length, 1);
	await fake.command().handler("implement login/01-split.html", ctx);
	assert.equal(fake.sent.length, 1);
	assert.equal(result.content[0].text, fake.sent[0].content, "byte-identical to the command's message");
	assert.deepEqual(result.details, { target: "login/01-split.html", warnings: [] });
});

test("gentle_design implement fails on an unknown target and reports an invalid feature link", async () => {
	const cwd = scratchCwd();
	writeLinkedDesign(cwd, "login", "../outside.md");
	const fake = fakePi();
	gentleDesign(fake.pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
	const run = designTool(fake);
	const { ctx } = fakeContext(cwd);
	for (const target of ["login/99-none.html", "login", ""]) {
		await assert.rejects(run({ action: "implement", target }, ctx), /Available: login\/01-split\.html, login\/02-card\.html/, target);
	}
	await assert.rejects(run({ action: "implement" }, ctx), /<slug>\/<artboard>/);
	const result = await run({ action: "implement", target: "login/02-card.html" }, ctx);
	const warning = "design/login/design.json: feature must be a relative odd/tasks/<name>.md path; it was ignored";
	assert.ok(result.content[0].text.includes("size it under the project's ODD rules as usual"));
	assert.equal(result.content[1].text, `Warning: ${warning}`);
	assert.deepEqual(result.details, { target: "login/02-card.html", warnings: [warning] });
	assert.equal(fake.sent.length, 0);
});

const DESIGN_HINT = [
	"Gentle Design: any request for a UI design, mockup, screen, landing page or visual directions uses the gentle-design skill by default; read the skill first when it is not loaded.",
	'After writing or changing a design, open or refresh it on the canvas with the gentle_design tool (action "open" with the slug), unless the user said not to.',
	"Designs stay under design/<slug>/.",
].join("\n");

async function promptAfterStart(fake: ReturnType<typeof fakePi>, skills: Array<{ name: string }> = []) {
	const options = { appendSystemPrompt: "", skills };
	await fake.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "a login screen", systemPrompt: "", systemPromptOptions: options });
	return options.appendSystemPrompt;
}

test("the design hint is appended to the system prompt while the gentle-design skill is available", async () => {
	const loaded = fakePi(true);
	gentleDesign(loaded.pi, { env: {} });
	assert.equal(await promptAfterStart(loaded), DESIGN_HINT);
	const listed = fakePi(false);
	gentleDesign(listed.pi, { env: {} });
	assert.equal(await promptAfterStart(listed, [{ name: "gentle-design" }]), DESIGN_HINT, "a skill in the prompt's skill list counts as available");
	const options = { appendSystemPrompt: "Other block", skills: [] };
	await loaded.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: options });
	await loaded.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: options });
	assert.equal(options.appendSystemPrompt, `Other block\n\n${DESIGN_HINT}`, "appended once");
});

test("the design hint is absent without the skill and in child sessions", async () => {
	const missing = fakePi(false);
	gentleDesign(missing.pi, { env: {} });
	assert.equal(await promptAfterStart(missing, [{ name: "gentle-ai" }]), "");
	const child = fakePi(true);
	gentleDesign(child.pi, { env: { GENTLE_PI_AGENTS_CHILD: "1" } });
	assert.equal(await promptAfterStart(child, [{ name: "gentle-design" }]), "");
});

test("the skill triggers on natural-language design requests and opens the canvas after writing", () => {
	const source = readFileSync(SKILL_PATH, "utf8");
	const description = __testing.parseFrontmatter(source).description ?? "";
	for (const trigger of ["design", "mockup", "landing page", "UI directions"]) assert.ok(description.includes(trigger), `the description triggers on ${trigger}`);
	assert.ok(description.length <= 250, `description stays short (${description.length})`);
	const steps = source.slice(source.indexOf("## Execution Steps"), source.indexOf("\n## ", source.indexOf("## Execution Steps") + 1));
	assert.match(steps, /`gentle_design`[^\n]*"open"[^\n]*slug[^\n]*unless the user/);
	assert.match(source, /`\/gentle:design`[^\n]*optional shortcuts/);
});
