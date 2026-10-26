import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_SLUG, startDesignCanvasServer, type DesignCanvasServer, type DesignCanvasServerOptions, type DesignComment } from "./design-canvas-server.ts";
import { openInBrowser, type OpenInBrowserResult } from "./design-open-browser.ts";

// Gentle Design helpers: argument parsing, the designs already written under
// design/<slug>/design.json, the usage text, and the per-session canvas that
// open/stop drive. The command stays a thin wrapper over these.

export const DESIGN_SKILL_NAME = "gentle-design";

/** Subcommands; sync and implement belong to the design-system and handoff phases. */
export const DESIGN_SUBCOMMANDS = ["open", "stop", "sync", "implement"] as const;
export type DesignSubcommand = (typeof DESIGN_SUBCOMMANDS)[number];

export type DesignArgs =
	| { kind: "usage" }
	| { kind: "subcommand"; name: DesignSubcommand; rest: string }
	| { kind: "brief"; brief: string };

export function parseDesignArgs(args: string): DesignArgs {
	const text = args.trim();
	if (!text) return { kind: "usage" };
	const [head = "", ...rest] = text.split(/\s+/);
	const name = DESIGN_SUBCOMMANDS.find((subcommand) => subcommand === head);
	return name ? { kind: "subcommand", name, rest: rest.join(" ") } : { kind: "brief", brief: text };
}

export interface DesignSummary {
	slug: string;
	title: string;
	/** design.json modification time in milliseconds. */
	mtime: number;
}

/**
 * Designs under <cwd>/design/*, most recent design.json first: a kebab-case
 * directory counts when it has a design.json; an unreadable title falls back to the slug.
 */
export function listDesigns(cwd: string): DesignSummary[] {
	let entries;
	try {
		entries = readdirSync(join(cwd, "design"), { withFileTypes: true });
	} catch {
		return [];
	}
	const designs: DesignSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !DESIGN_SLUG.test(entry.name)) continue;
		const path = join(cwd, "design", entry.name, "design.json");
		let manifest: string;
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
			manifest = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		let title = entry.name;
		try {
			const parsed = JSON.parse(manifest) as { title?: unknown };
			if (typeof parsed.title === "string" && parsed.title.trim()) title = parsed.title.trim();
		} catch {
			// Keep the slug as the title.
		}
		designs.push({ slug: entry.name, title, mtime });
	}
	return designs.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
}

export const DESIGN_HELP =
	"Design HTML artboards with any model: /gentle:design <brief> starts a design run; no arguments open the latest design on the local canvas. Subcommands: open [slug], stop, sync, implement <slug>/<artboard>.";

export function designUsage(designs: readonly DesignSummary[]): string {
	const lines = ["Usage: /gentle:design <brief>", "Describe the goal, layout, content, and audience. Directions are written to design/<slug>/."];
	if (designs.length > 0) {
		lines.push("", "Designs in this project:");
		for (const design of designs) lines.push(`  ${design.title} (${design.slug})`);
	}
	return lines.join("\n");
}

/** The message that runs the skill: a skill command when Pi has it loaded, otherwise a pointer to the bundled file. */
export function designRunMessage(brief: string, skill: { loaded: boolean; path: string }): string {
	if (skill.loaded) return `/skill:${DESIGN_SKILL_NAME} ${brief}`;
	return `Read the ${DESIGN_SKILL_NAME} skill at ${skill.path} and follow it for this design brief:\n\n${brief}`;
}

export type DesignNotice = { message: string; level: "info" | "warning" | "error" };

export interface DesignCanvasDeps {
	startServer?: (options: DesignCanvasServerOptions) => Promise<DesignCanvasServer>;
	openBrowser?: (url: string) => Promise<OpenInBrowserResult>;
}

export interface DesignCanvas {
	/** Shows `slug`, or the most recent design, on the session's canvas server, starting it when needed. */
	open(cwd: string, slug?: string): Promise<DesignNotice>;
	/** Closes the running server; false when none was running. */
	stop(): Promise<boolean>;
}

function canvasUrl(server: DesignCanvasServer, slug: string): string {
	return new URL(`/${server.token}/d/${slug}/`, server.url).href;
}

/** One canvas server per session; comments go to `deliver`, whose failure the server reports as HTTP 500. */
export function createDesignCanvas(deliver: (comment: DesignComment) => void | Promise<void>, deps: DesignCanvasDeps = {}): DesignCanvas {
	const startServer = deps.startServer ?? startDesignCanvasServer;
	const openBrowser = deps.openBrowser ?? ((url: string) => openInBrowser(url));
	let running: { root: string; server: Promise<DesignCanvasServer> } | undefined;

	async function stop(): Promise<boolean> {
		const current = running;
		running = undefined;
		if (!current) return false;
		const server = await current.server.catch(() => undefined);
		await server?.close();
		return server !== undefined;
	}

	async function serverFor(root: string): Promise<DesignCanvasServer> {
		// A new session cwd means a different design root, so the old server goes.
		if (running && running.root !== root) await stop();
		if (!running) {
			const server = startServer({ designRoot: root, onComment: deliver });
			running = { root, server };
			server.catch(() => { if (running?.server === server) running = undefined; });
		}
		return running.server;
	}

	async function open(cwd: string, requested?: string): Promise<DesignNotice> {
		const designs = listDesigns(cwd);
		if (designs.length === 0) return { message: `No designs in design/ yet.\n${designUsage([])}`, level: "warning" };
		const slug = requested ?? designs[0].slug;
		if (!designs.some((design) => design.slug === slug)) {
			return { message: `No design "${slug}" in design/. Available: ${designs.map((design) => design.slug).join(", ")}.`, level: "warning" };
		}
		let server: DesignCanvasServer;
		try {
			server = await serverFor(join(cwd, "design"));
		} catch (error) {
			return { message: `The design canvas could not start: ${error instanceof Error ? error.message : String(error)}`, level: "error" };
		}
		const url = canvasUrl(server, slug);
		const result = await openBrowser(url);
		if (result.opened) return { message: `Design canvas: ${url}`, level: "info" };
		const reason = result.error ? ` (${result.error})` : "";
		return { message: `Design canvas: ${url}\nThe browser could not be opened${reason}. Open the URL manually.`, level: "warning" };
	}

	return { open, stop };
}
