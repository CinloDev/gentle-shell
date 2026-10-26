import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Gentle Design helpers: argument parsing, the designs already written under
// design/<slug>/design.json, and the usage text. Pure apart from reading the
// session cwd, so the command stays a thin wrapper.

export const DESIGN_SKILL_NAME = "gentle-design";

/** Subcommands owned by later phases (canvas, design system, handoff). */
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
}

/** Designs under <cwd>/design/*: a directory counts when it has a design.json; an unreadable title falls back to the slug. */
export function listDesigns(cwd: string): DesignSummary[] {
	let entries;
	try {
		entries = readdirSync(join(cwd, "design"), { withFileTypes: true });
	} catch {
		return [];
	}
	const designs: DesignSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let manifest: string;
		try {
			manifest = readFileSync(join(cwd, "design", entry.name, "design.json"), "utf8");
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
		designs.push({ slug: entry.name, title });
	}
	return designs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export const DESIGN_HELP =
	"Design HTML artboards with any model: /gentle:design <brief> starts a design run. Subcommands: open [slug], stop, sync, implement <slug>/<artboard>.";

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
