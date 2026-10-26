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
// session; sync and implement send nothing yet.

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
