import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleDesign, { DESIGN_COMMAND_NAME } from "../extensions/gentle-design.ts";
import { formatDesignComment, type DesignCanvasServer, type DesignCanvasServerOptions, type DesignComment } from "../lib/design-canvas-server.ts";
import type { OpenInBrowserResult } from "../lib/design-open-browser.ts";
import { __testing } from "../extensions/skill-registry.ts";

// /gentle:design wiring: a brief starts one design run through the
// gentle-design skill; open/no arguments show the canvas for a design in the
// session cwd; stop and session shutdown close it; canvas comments reach the
// session; sync and implement send nothing yet.

const SKILL_PATH = fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));

type Registration = { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> };
type Sent = { content: unknown; options: unknown };

function fakePi(skillLoaded = true) {
	const commands = new Map<string, Registration>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const sent: Sent[] = [];
	const pi = {
		registerCommand: (name: string, registration: Registration) => commands.set(name, registration),
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
	return { pi, sent, emit, command: () => commands.get(DESIGN_COMMAND_NAME)! };
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
	const comment: DesignComment = { slug: "login", file: "01-a.html", selector: "body > h1", excerpt: "A", comment: "Bigger" };
	await canvas.starts[0].onComment(comment);
	assert.deepEqual(sent.at(-1), { content: formatDesignComment(comment), options: undefined });
	state.idle = false;
	await canvas.starts[0].onComment(comment);
	assert.deepEqual(sent.at(-1), { content: formatDesignComment(comment), options: { deliverAs: "followUp" } });
	assert.equal(sent.length, 2);
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
	assert.deepEqual(sent, [{ content: formatDesignComment({ slug: "login", file: "01-a.html", selector: "body > h1", excerpt: "A", comment: "Make it red" }), options: undefined }]);
});

test("sync and implement stay reserved and send nothing", async () => {
	for (const subcommand of ["sync", "implement", "implement login/01-split.html"]) {
		const { pi, sent, command } = fakePi();
		gentleDesign(pi, { startServer: unexpectedServer, openBrowser: unexpectedBrowser });
		const { ctx, notices } = fakeContext(scratchCwd());
		await command().handler(subcommand, ctx);
		assert.equal(sent.length, 0, subcommand);
		assert.equal(notices.length, 1, subcommand);
		assert.match(notices[0].message, new RegExp(`/gentle:design ${subcommand.split(" ")[0]} is not available yet`));
	}
});

test("skills/design/SKILL.md is named gentle-design and documents the manifest fields", () => {
	const source = readFileSync(SKILL_PATH, "utf8");
	assert.equal(__testing.parseFrontmatter(source).name, "gentle-design");
	for (const field of ["design.json", "\"title\"", "\"brief\"", "\"artboards\"", "\"file\"", "\"tradeoff\"", "\"width\"", "\"height\"", "design/system.md", "Copy as prompt"]) {
		assert.ok(source.includes(field), `SKILL.md mentions ${field}`);
	}
});
