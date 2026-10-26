import { join } from "node:path";
import { formatDesignComment, listDesignEntries, formatDesignCommentBatch, startDesignCanvasServer, type DesignCanvasServer, type DesignCanvasServerOptions } from "./design-canvas-server.ts";
import { createDesignCommentStore, DesignCommentsError, type StoredDesignComment } from "./design-comments.ts";
import { openInBrowser, type OpenInBrowserResult } from "./design-open-browser.ts";

// Gentle Design helpers: argument parsing, the designs already written under
// design/<slug>/design.json, the usage text, the per-session canvas that
// open/stop drive, and the comments tool. The extension stays a thin wrapper.

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

/** Designs under <cwd>/design, through the listing the canvas server uses (same containment rule). */
export function listDesigns(cwd: string): DesignSummary[] {
	return listDesignEntries(join(cwd, "design")).map(({ slug, title, mtime }) => ({ slug, title, mtime }));
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

/** One canvas server per session; comment messages go to `deliver`, whose failure the server reports as HTTP 500. */
export function createDesignCanvas(deliver: (message: string) => void | Promise<void>, deps: DesignCanvasDeps = {}): DesignCanvas {
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
			const server = startServer({
				designRoot: root,
				onComment: (comment) => deliver(formatDesignComment(comment)),
				onComments: (batch) => deliver(formatDesignCommentBatch(batch)),
			});
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

export const DESIGN_COMMENTS_TOOL_NAME = "gentle_design_comments";

export type DesignCommentsToolParams = { action: "list" | "resolve"; slug?: string; file?: string; ids?: string[] };
export type DesignCommentsToolResult = { text: string; details: { comments: Array<StoredDesignComment & { slug: string }> } | { slug: string; resolved: string[]; unknown: string[] } };

function describeComment(slug: string, comment: StoredDesignComment): string[] {
	return [
		`- [${comment.id}] design/${slug}/${comment.file}`,
		`  Element: ${comment.selector}`,
		`  Excerpt: ${comment.excerpt ? JSON.stringify(comment.excerpt) : "(none)"}`,
		`  Comment: ${comment.comment.split("\n").join("\n           ")}`,
	];
}

/** list: open comments (all designs, or one design and artboard); resolve: mark ids of one design resolved. */
export async function runDesignCommentsTool(cwd: string, params: DesignCommentsToolParams): Promise<DesignCommentsToolResult> {
	const store = createDesignCommentStore(join(cwd, "design"));
	const failure = (slug: string, error: unknown) => error instanceof DesignCommentsError && error.code === "invalid-file"
		? new Error(`design/${slug}/comments.json cannot be read: ${error.message}. Fix the file by hand; it is never overwritten.`)
		: error;
	if (params.action === "resolve") {
		if (typeof params.slug !== "string" || !params.slug) throw new Error("resolve needs the design slug.");
		const ids = params.ids ?? [];
		if (ids.length === 0) throw new Error("resolve needs at least one comment id in ids.");
		const { updated, unknown } = await store.setStatus(params.slug, ids, "resolved").catch((error: unknown) => { throw failure(params.slug!, error); });
		const resolved = updated.map((comment) => comment.id);
		const lines = [`Resolved ${resolved.length} comment${resolved.length === 1 ? "" : "s"} in design/${params.slug}${resolved.length ? `: ${resolved.join(", ")}` : ""}.`];
		if (unknown.length) lines.push(`Unknown ids: ${unknown.join(", ")}.`);
		return { text: lines.join("\n"), details: { slug: params.slug, resolved, unknown } };
	}
	const slugs = params.slug ? [params.slug] : listDesigns(cwd).map((design) => design.slug);
	const found: Array<StoredDesignComment & { slug: string }> = [];
	const problems: string[] = [];
	for (const slug of slugs) {
		try {
			for (const comment of await store.listOpen(slug, params.file)) found.push({ slug, ...comment });
		} catch (error) {
			// One design's broken file must not hide the others, unless it was asked for by name.
			if (params.slug) throw failure(slug, error);
			problems.push(`design/${slug}/comments.json: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const scope = params.slug ? `design/${params.slug}${params.file ? `/${params.file}` : ""}` : "design/";
	const lines = found.length === 0
		? [`No open comments in ${scope}.`]
		: [`Open design comments in ${scope} (${found.length}):`, ...found.flatMap((comment) => describeComment(comment.slug, comment)), "", `After applying a comment, resolve it with ${DESIGN_COMMENTS_TOOL_NAME} (action "resolve", slug, ids).`];
	if (problems.length) lines.push("", "Unreadable comment files:", ...problems.map((problem) => `- ${problem}`));
	return { text: lines.join("\n"), details: { comments: found } };
}
