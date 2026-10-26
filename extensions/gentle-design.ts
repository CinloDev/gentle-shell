import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DESIGN_COMMENTS_TOOL_NAME, DESIGN_HELP, DESIGN_SKILL_NAME, DESIGN_SYNC_REQUEST, createDesignCanvas, designRunMessage, designUsage, listDesigns, parseDesignArgs, runDesignCommentsTool, type DesignCanvasDeps, type DesignCommentsToolParams } from "../lib/gentle-design.ts";

// Gentle Design: /gentle:design <brief> runs the bundled gentle-design skill,
// which writes self-contained HTML artboards under design/<slug>/ with
// whatever model the session uses. open (and no arguments, when designs
// exist) shows them on a loopback canvas whose comments come back to the
// session and persist in design/<slug>/comments.json; stop and session
// shutdown close it. The gentle_design_comments tool lets any model list and
// resolve those comments. sync runs the skill's design-system mode, which
// writes design/system.md and design/system.html; implement is reserved for
// the handoff phase.

export const DESIGN_COMMAND_NAME = "gentle:design";

const DesignCommentsParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("resolve")], { description: "list: open comments; resolve: mark comments resolved after applying them" }),
	slug: Type.Optional(Type.String({ description: "Design slug (directory under design/); required for resolve" })),
	file: Type.Optional(Type.String({ description: "Artboard file within the design, such as 01-calm.html (list only)" })),
	ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500, description: "Comment ids to resolve" })),
});

export interface GentleDesignDeps extends DesignCanvasDeps {
	/** Absolute path of the bundled skill, named in the message when Pi has not loaded it. */
	skillPath?: string;
}

/** A stale or replaced context counts as busy, so a comment is queued rather than interrupting. */
function isIdle(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.isIdle() ?? true;
	} catch {
		return false;
	}
}

export default function gentleDesign(pi: ExtensionAPI, deps: GentleDesignDeps = {}): void {
	const skillPath = deps.skillPath ?? fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));
	// Canvas comments arrive between commands; the last command's context answers whether the agent is busy.
	let latest: ExtensionContext | undefined;
	const canvas = createDesignCanvas((message) => {
		pi.sendUserMessage(message, isIdle(latest) ? undefined : { deliverAs: "followUp" });
	}, deps);

	const open = async (ctx: ExtensionContext, slug?: string) => {
		const notice = await canvas.open(ctx.cwd, slug);
		ctx.ui.notify(notice.message, notice.level);
	};

	// sendUserMessage expands /skill:<name> only when Pi loaded that skill;
	// an unknown skill command would reach the model verbatim.
	const runSkill = (request: string, ctx: ExtensionContext) => {
		const loaded = pi.getCommands().some((command) => command.name === `skill:${DESIGN_SKILL_NAME}`);
		const content = designRunMessage(request, { loaded, path: skillPath });
		pi.sendUserMessage(content, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" });
	};

	const handle = async (args: string, ctx: ExtensionContext) => {
		latest = ctx;
		const parsed = parseDesignArgs(args);
		if (parsed.kind === "usage") {
			if (listDesigns(ctx.cwd).length > 0) await open(ctx);
			else ctx.ui.notify(designUsage([]), "info");
			return;
		}
		if (parsed.kind === "subcommand") {
			if (parsed.name === "open") return open(ctx, parsed.rest || undefined);
			if (parsed.name === "stop") {
				ctx.ui.notify((await canvas.stop()) ? "Design canvas stopped." : "No design canvas is running.", "info");
				return;
			}
			if (parsed.name === "sync") return runSkill(DESIGN_SYNC_REQUEST, ctx);
			ctx.ui.notify(`/gentle:design ${parsed.name} is not available yet.`, "warning");
			return;
		}
		runSkill(parsed.brief, ctx);
	};

	pi.registerCommand(DESIGN_COMMAND_NAME, { description: DESIGN_HELP, handler: handle });
	pi.registerTool({
		name: DESIGN_COMMENTS_TOOL_NAME,
		label: "Design comments",
		description: "List the open canvas comments stored in design/<slug>/comments.json, or mark comments resolved once you have applied them.",
		promptSnippet: "List open gentle-design canvas comments and resolve them after applying them.",
		parameters: DesignCommentsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runDesignCommentsTool(ctx.cwd, params as DesignCommentsToolParams);
			return { content: [{ type: "text" as const, text: result.text }], details: result.details };
		},
	});
	pi.on("session_shutdown", async () => {
		latest = undefined;
		await canvas.stop();
	});
}
