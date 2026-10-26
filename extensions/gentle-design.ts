import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DESIGN_HELP, DESIGN_SKILL_NAME, designRunMessage, designUsage, listDesigns, parseDesignArgs } from "../lib/gentle-design.ts";

// Gentle Design: /gentle:design <brief> runs the bundled gentle-design skill,
// which writes self-contained HTML artboards under design/<slug>/ with
// whatever model the session uses. No arguments print usage and the designs
// already in the session cwd. open/stop/sync/implement are reserved for the
// canvas, design-system, and handoff phases.

export const DESIGN_COMMAND_NAME = "gentle:design";

export interface GentleDesignDeps {
	/** Absolute path of the bundled skill, named in the message when Pi has not loaded it. */
	skillPath?: string;
}

export default function gentleDesign(pi: ExtensionAPI, deps: GentleDesignDeps = {}): void {
	const skillPath = deps.skillPath ?? fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));

	const handle = async (args: string, ctx: ExtensionContext) => {
		const parsed = parseDesignArgs(args);
		if (parsed.kind === "usage") {
			ctx.ui.notify(designUsage(listDesigns(ctx.cwd)), "info");
			return;
		}
		if (parsed.kind === "subcommand") {
			ctx.ui.notify(`/gentle:design ${parsed.name} is not available yet.`, "warning");
			return;
		}
		// sendUserMessage expands /skill:<name> only when Pi loaded that skill;
		// an unknown skill command would reach the model verbatim.
		const loaded = pi.getCommands().some((command) => command.name === `skill:${DESIGN_SKILL_NAME}`);
		const content = designRunMessage(parsed.brief, { loaded, path: skillPath });
		pi.sendUserMessage(content, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" });
	};

	pi.registerCommand(DESIGN_COMMAND_NAME, { description: DESIGN_HELP, handler: handle });
}
