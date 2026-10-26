import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleDesign, { DESIGN_COMMAND_NAME } from "../extensions/gentle-design.ts";
import { __testing } from "../extensions/skill-registry.ts";

// /gentle:design wiring: a brief starts one design run through the
// gentle-design skill; no arguments print usage plus the designs already in
// the session cwd; reserved subcommands send nothing yet.

const SKILL_PATH = fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));

type Registration = { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> };
type Sent = { content: unknown; options: unknown };

function fakePi(skillLoaded = true) {
	const commands = new Map<string, Registration>();
	const sent: Sent[] = [];
	const pi = {
		registerCommand: (name: string, registration: Registration) => commands.set(name, registration),
		getCommands: () => (skillLoaded ? [{ name: "skill:gentle-design", source: "skill" }] : []),
		sendUserMessage: (content: unknown, options?: unknown) => sent.push({ content, options }),
		on: () => {},
	} as unknown as ExtensionAPI;
	return { pi, sent, command: () => commands.get(DESIGN_COMMAND_NAME)! };
}

function fakeContext(cwd: string, idle = true) {
	const notices: Array<{ message: string; level?: string }> = [];
	const ctx = {
		hasUI: true,
		cwd,
		isIdle: () => idle,
		sessionManager: { getCwd: () => cwd },
		ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
	} as unknown as ExtensionContext;
	return { ctx, notices };
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

function writeDesign(cwd: string, slug: string, title: string) {
	mkdirSync(join(cwd, "design", slug), { recursive: true });
	writeFileSync(join(cwd, "design", slug, "design.json"), JSON.stringify({ title, brief: "b", artboards: [] }));
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

test("no arguments lists the designs found under design/*/design.json and sends nothing", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "pricing-page", "Pricing page");
	writeDesign(cwd, "login", "Login screen");
	mkdirSync(join(cwd, "design", "no-manifest"), { recursive: true });
	mkdirSync(join(cwd, "design", "broken"), { recursive: true });
	writeFileSync(join(cwd, "design", "broken", "design.json"), "{not json");
	const { pi, sent, command } = fakePi();
	gentleDesign(pi);
	const { ctx, notices } = fakeContext(cwd);
	await command().handler("", ctx);
	assert.equal(sent.length, 0);
	assert.equal(notices.length, 1);
	const message = notices[0].message;
	assert.match(message, /\/gentle:design <brief>/);
	assert.match(message, /Pricing page \(pricing-page\)/);
	assert.match(message, /Login screen \(login\)/);
	assert.doesNotMatch(message, /no-manifest/);
	assert.match(message, /broken/, "an unreadable manifest still lists its slug");
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

test("reserved subcommands report that they are not available yet and send nothing", async () => {
	for (const subcommand of ["open", "stop", "sync", "implement", "open pricing-page", "implement login/01-split.html"]) {
		const { pi, sent, command } = fakePi();
		gentleDesign(pi);
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
