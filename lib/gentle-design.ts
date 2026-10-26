import { join } from "node:path";
import { formatDesignComment, hasSystemTokens, listDesignEntries, formatDesignCommentBatch, readDesignManifest, resolveSystemBoard, startDesignCanvasServer, type DesignArtboard, type DesignCanvasServer, type DesignCanvasServerOptions } from "./design-canvas-server.ts";
import { createDesignCommentStore, DesignCommentsError, type StoredDesignComment } from "./design-comments.ts";
import { openInBrowser, type OpenInBrowserResult } from "./design-open-browser.ts";

// Gentle Design helpers: argument parsing, the designs already written under
// design/<slug>/design.json, the usage text, the per-session canvas that
// open/stop drive, and the comments tool. The extension stays a thin wrapper.

export const DESIGN_SKILL_NAME = "gentle-design";

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

/** Whether design/system.html exists, so the canvas can open on the system board alone. */
export function hasSystemBoard(cwd: string): boolean {
	return resolveSystemBoard(join(cwd, "design")) !== undefined;
}

export const DESIGN_HELP =
	"Design HTML artboards with any model: /gentle:design <brief> starts a design run; no arguments open the latest design (or the system board alone) on the local canvas. Subcommands: open [slug], stop, sync (write design/system.md and design/system.html from the project's design sources; the canvas shows that system board first), implement <slug>/<artboard> (hand an artboard off to the project's real stack, also from the canvas Implement button).";

/** What /gentle:design sync asks the skill to do; it rides designRunMessage like a brief. */
export const DESIGN_SYNC_REQUEST =
	'sync the project design system: follow "Design system sync" to read the project\'s design sources and write design/system.md and design/system.html.';

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

export type DesignImplementInput = {
	slug: string;
	artboard: Pick<DesignArtboard, "file" | "title" | "tradeoff">;
	/** The design's valid ODD feature document, when design.json links one. */
	feature?: string;
	/** Whether design/system.md exists. */
	systemTokens: boolean;
	/** The open comments on this artboard. */
	comments: ReadonlyArray<Pick<StoredDesignComment, "id" | "selector" | "excerpt" | "comment">>;
};

/** The handoff message for one artboard (S8); the command and the canvas button both send exactly this. */
export function designImplementMessage(input: DesignImplementInput): string {
	const path = `design/${input.slug}/${input.artboard.file}`;
	const lines = [
		`Implement the design artboard ${path}`,
		"",
		`Artboard: ${path}`,
		`Title: ${input.artboard.title}`,
	];
	if (input.artboard.tradeoff) lines.push(`Tradeoff: ${input.artboard.tradeoff}`);
	lines.push(
		"",
		"Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's existing components and styles, and do not copy the artboard HTML verbatim.",
	);
	if (input.systemTokens) lines.push("Take colors, typography, spacing, radius and shadows from design/system.md, the project's token source.");
	if (input.comments.length > 0) {
		lines.push("", `Open comments on this artboard (${input.comments.length}); apply each one in the implementation:`);
		input.comments.forEach((comment, index) => {
			lines.push(
				`${index + 1}. Comment id: ${comment.id}`,
				`   Element: ${comment.selector}`,
				`   Excerpt: ${comment.excerpt ? JSON.stringify(comment.excerpt) : "(none)"}`,
				"   Comment:",
				...comment.comment.split("\n").map((line) => `   ${line}`),
			);
		});
		const ids = input.comments.map((comment) => JSON.stringify(comment.id)).join(", ");
		lines.push(`When they are applied, resolve them with the ${DESIGN_COMMENTS_TOOL_NAME} tool (action "resolve", slug "${input.slug}", ids [${ids}]).`);
	}
	lines.push(
		"",
		input.feature
			? `This design belongs to an ODD feature: track this implementation in ${input.feature} (add or reopen its task there and log this handoff).`
			: "This design is not linked to an ODD feature document: size it under the project's ODD rules as usual.",
		"This handoff itself commits nothing.",
	);
	return lines.join("\n");
}

/** `warnings` name what design.json dropped (an invalid feature link), so the command can report it. */
export type DesignImplementPlan = { kind: "send"; message: string; warnings: string[] } | { kind: "refuse"; notice: DesignNotice };

function implementTargets(cwd: string): string[] {
	const targets: string[] = [];
	for (const design of listDesigns(cwd)) {
		try {
			for (const artboard of readDesignManifest(join(cwd, "design"), design.slug).artboards) targets.push(`${design.slug}/${artboard.file}`);
		} catch {
			// An unreadable design has no artboard to hand off.
		}
	}
	return targets;
}

function unknownTarget(cwd: string, reason: string): DesignImplementPlan {
	const targets = implementTargets(cwd);
	if (targets.length === 0) return { kind: "refuse", notice: { message: `${reason}\nNo designs in design/ yet.\n${designUsage([])}`, level: "warning" } };
	const shown = targets.length > 30 ? [...targets.slice(0, 30), `… ${targets.length - 30} more`] : targets;
	return { kind: "refuse", notice: { message: `${reason}\nUsage: /gentle:design implement <slug>/<artboard>. Available: ${shown.join(", ")}.`, level: "warning" } };
}

/** Validates `<slug>/<file>` against the design's manifest and builds its handoff message. */
export async function planDesignImplement(cwd: string, target: string): Promise<DesignImplementPlan> {
	const text = target.trim();
	const slash = text.indexOf("/");
	const slug = slash === -1 ? text : text.slice(0, slash);
	const file = slash === -1 ? "" : text.slice(slash + 1);
	if (!slug || !file) return unknownTarget(cwd, "Name the artboard to implement as <slug>/<artboard>.");
	if (!listDesigns(cwd).some((design) => design.slug === slug)) return unknownTarget(cwd, `No design "${slug}" in design/.`);
	const designRoot = join(cwd, "design");
	let artboard: DesignArtboard | undefined;
	let feature: string | undefined;
	let warnings: string[] = [];
	try {
		const manifest = readDesignManifest(designRoot, slug);
		artboard = manifest.artboards.find((candidate) => candidate.file === file);
		feature = manifest.feature;
		warnings = (manifest.warnings ?? []).map((warning) => `design/${slug}/design.json: ${warning}`);
	} catch (error) {
		return { kind: "refuse", notice: { message: error instanceof Error ? error.message : String(error), level: "warning" } };
	}
	if (!artboard) return unknownTarget(cwd, `No artboard "${file}" in design/${slug}/design.json.`);
	let comments: StoredDesignComment[];
	try {
		comments = await createDesignCommentStore(designRoot).listOpen(slug, artboard.file);
	} catch (error) {
		const reason = error instanceof DesignCommentsError && error.code === "invalid-file"
			? `design/${slug}/comments.json cannot be read: ${error.message}. Fix the file by hand; it is never overwritten.`
			: error instanceof Error ? error.message : String(error);
		return { kind: "refuse", notice: { message: reason, level: "warning" } };
	}
	return { kind: "send", message: designImplementMessage({ slug, artboard, feature, systemTokens: hasSystemTokens(designRoot), comments }), warnings };
}

export interface DesignCanvasDeps {
	startServer?: (options: DesignCanvasServerOptions) => Promise<DesignCanvasServer>;
	openBrowser?: (url: string) => Promise<OpenInBrowserResult>;
}

/** `url` is set once the canvas shows something; `opened` says whether the browser opened it. */
export type DesignOpenNotice = DesignNotice & { url?: string; opened?: boolean };

export interface DesignCanvas {
	/** Shows `slug`, or the most recent design, on the session's canvas server, starting it when needed. */
	open(cwd: string, slug?: string): Promise<DesignOpenNotice>;
	/** Closes the running server; false when none was running. */
	stop(): Promise<boolean>;
	/** The URL the running canvas last showed; undefined when none is running. */
	url(): string | undefined;
}

/** The canvas of `slug`, or the root canvas (system board only) when slug is null. */
function canvasUrl(server: DesignCanvasServer, slug: string | null): string {
	return new URL(slug === null ? `/${server.token}/` : `/${server.token}/d/${slug}/`, server.url).href;
}

/** One canvas server per session; comment messages go to `deliver`, whose failure the server reports as HTTP 500. */
export function createDesignCanvas(deliver: (message: string) => void | Promise<void>, deps: DesignCanvasDeps = {}): DesignCanvas {
	const startServer = deps.startServer ?? startDesignCanvasServer;
	const openBrowser = deps.openBrowser ?? ((url: string) => openInBrowser(url));
	let running: { root: string; server: Promise<DesignCanvasServer>; url?: string } | undefined;

	async function stop(): Promise<boolean> {
		const current = running;
		running = undefined;
		if (!current) return false;
		const server = await current.server.catch(() => undefined);
		await server?.close();
		return server !== undefined;
	}

	async function serverFor(cwd: string): Promise<DesignCanvasServer> {
		const root = join(cwd, "design");
		// A new session cwd means a different design root, so the old server goes.
		if (running && running.root !== root) await stop();
		if (!running) {
			const server = startServer({
				designRoot: root,
				onComment: (comment) => deliver(formatDesignComment(comment)),
				onComments: (batch) => deliver(formatDesignCommentBatch(batch)),
				// The same plan as /gentle:design implement, so both send identical text.
				onImplement: async ({ slug, file }) => {
					const plan = await planDesignImplement(cwd, `${slug}/${file}`);
					if (plan.kind === "refuse") throw new Error(plan.notice.message);
					await deliver(plan.message);
				},
			});
			running = { root, server };
			server.catch(() => { if (running?.server === server) running = undefined; });
		}
		return running.server;
	}

	async function open(cwd: string, requested?: string): Promise<DesignOpenNotice> {
		const designs = listDesigns(cwd);
		// With only design/system.html, the canvas opens on the system board alone (L14).
		const systemOnly = designs.length === 0 && requested === undefined && hasSystemBoard(cwd);
		if (designs.length === 0 && !systemOnly) {
			return { message: `No designs in design/ yet.\n${designUsage([])}`, level: "warning" };
		}
		const slug = systemOnly ? null : requested ?? designs[0].slug;
		if (slug !== null && !designs.some((design) => design.slug === slug)) {
			return { message: `No design "${slug}" in design/. Available: ${designs.map((design) => design.slug).join(", ")}.`, level: "warning" };
		}
		let server: DesignCanvasServer;
		try {
			server = await serverFor(cwd);
		} catch (error) {
			return { message: `The design canvas could not start: ${error instanceof Error ? error.message : String(error)}`, level: "error" };
		}
		const url = canvasUrl(server, slug);
		if (running) running.url = url;
		const result = await openBrowser(url);
		if (result.opened) return { message: `Design canvas: ${url}`, level: "info", url, opened: true };
		const reason = result.error ? ` (${result.error})` : "";
		return { message: `Design canvas: ${url}\nThe browser could not be opened${reason}. Open the URL manually.`, level: "warning", url, opened: false };
	}

	return { open, stop, url: () => running?.url };
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

export const DESIGN_TOOL_NAME = "gentle_design";

/** Appended to the system prompt while the gentle-design skill is available (S11). */
export const DESIGN_PROMPT_HINT = [
	`Gentle Design: any request for a UI design, mockup, screen, landing page or visual directions uses the ${DESIGN_SKILL_NAME} skill by default; read the skill first when it is not loaded.`,
	`After writing or changing a design, open or refresh it on the canvas with the ${DESIGN_TOOL_NAME} tool (action "open" with the slug), unless the user said not to.`,
	"Designs stay under design/<slug>/.",
].join("\n");

export type DesignToolParams = { action: "list" | "open" | "stop" | "implement"; slug?: string; target?: string };
export type DesignToolDetails =
	| { designs: Array<{ slug: string; title: string; artboards: Array<{ file: string; title: string }>; error?: string }>; systemBoard: boolean; canvas: { running: boolean; url?: string } }
	| { url: string; opened: boolean }
	| { stopped: boolean }
	| { target: string; warnings: string[] };
/** `texts` become the tool's content parts; a refusal throws, so Pi flags the result as an error. */
export type DesignToolResult = { texts: string[]; details: DesignToolDetails };

function listDesignTool(cwd: string, canvas: DesignCanvas): DesignToolResult {
	const designRoot = join(cwd, "design");
	const designs = listDesigns(cwd).map(({ slug, title }) => {
		try {
			const artboards = readDesignManifest(designRoot, slug).artboards.map(({ file, title }) => ({ file, title }));
			return { slug, title, artboards };
		} catch (error) {
			return { slug, title, artboards: [], error: error instanceof Error ? error.message : String(error) };
		}
	});
	const systemBoard = hasSystemBoard(cwd);
	const url = canvas.url();
	const lines = designs.length === 0 ? ["No designs in design/ yet."] : [`Designs in design/ (${designs.length}):`];
	for (const design of designs) {
		lines.push(`- ${design.slug}: ${design.title}${design.error ? ` (design.json cannot be read: ${design.error})` : ""}`);
		for (const artboard of design.artboards) lines.push(`  - ${artboard.file}: ${artboard.title}`);
	}
	lines.push(systemBoard ? "System board: design/system.html (shown first on the canvas)." : "No system board (design/system.html).");
	lines.push(url ? `Canvas: running at ${url}` : "Canvas: not running.");
	return { texts: [lines.join("\n")], details: { designs, systemBoard, canvas: url ? { running: true, url } : { running: false } } };
}

/** The gentle_design tool: the /gentle:design actions on the session's canvas, without sending a user message. */
export async function runDesignTool(cwd: string, params: DesignToolParams, canvas: DesignCanvas): Promise<DesignToolResult> {
	if (params.action === "list") return listDesignTool(cwd, canvas);
	if (params.action === "stop") {
		const stopped = await canvas.stop();
		return { texts: [stopped ? "Design canvas stopped." : "No design canvas is running."], details: { stopped } };
	}
	if (params.action === "open") {
		const notice = await canvas.open(cwd, params.slug || undefined);
		if (notice.url === undefined) throw new Error(notice.message);
		return { texts: [notice.message], details: { url: notice.url, opened: notice.opened === true } };
	}
	const target = params.target ?? "";
	const plan = await planDesignImplement(cwd, target);
	if (plan.kind === "refuse") throw new Error(plan.notice.message);
	return { texts: [plan.message, ...plan.warnings.map((warning) => `Warning: ${warning}`)], details: { target: target.trim(), warnings: plan.warnings } };
}
