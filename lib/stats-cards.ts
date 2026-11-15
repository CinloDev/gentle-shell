import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow, sectionGap } from "./shell-panel.ts";
import { renderStatsRows, type SessionStats } from "./shell-stats.ts";
import type { EcosystemVersionRow } from "./ecosystem-versions.ts";
import type { Density } from "./visual-customization-policy.ts";

// Gentle Shell STAT-tab cards: the live session, tools and ecosystem versions.
// The host owns the memoized session collector and activation-gated version
// detection; this module only paints the plain snapshot it is handed. No
// filesystem or network reads happen here.

export type StatsCardsSnapshot = {
	/** The live session, from the host's per-leaf memoized collector. */
	session?: { stats: SessionStats; subscription?: boolean };
	/** Detected ecosystem versions; absent until the host's readers answer. */
	ecosystem?: readonly EcosystemVersionRow[];
};

export type StatsCardsTheme = { fg(role: string, text: string): string };
export type StatsCardId = "session" | "tools" | "ecosystem";
export type StatsCardsState = { collapsed?: ReadonlySet<StatsCardId>; hovered?: StatsCardId };
export type StatsCardsFrame = {
	rows: string[];
	groups: Array<{ start: number; end: number }>;
	headers: Array<{ id: StatsCardId; row: number }>;
};

/** Wide enough for "Gentle Shell" plus the space that separates it from its version. */
const VERSION_LABEL_WIDTH = 13;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One row per ecosystem entry: the version, and how it was obtained. */
function ecosystemBody(rows: readonly EcosystemVersionRow[], theme: StatsCardsTheme, width: number): string[] {
	return rows.map(entry => {
		const label = theme.fg("muted", entry.label.padEnd(VERSION_LABEL_WIDTH));
		// An absent version keeps its column so the panel reads as a table, never as a broken row.
		const version = entry.version === undefined ? theme.fg("muted", "—") : theme.fg("text", entry.version);
		return renderPanelRow(width, `${label}${version}`, theme.fg("muted", entry.source));
	});
}

/** Important tools lead; uncommon failures keep their identities, successes share one row. */
function toolsBody(stats: SessionStats, theme: StatsCardsTheme, width: number): string[] {
	const important = ["bash", "write", "read", "edit"];
	const tools = stats.tools;
	const named = [
		...important.flatMap(name => tools.filter(tool => tool.name === name)),
		...tools.filter(tool => !important.includes(tool.name) && tool.errors > 0).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
	];
	const other = tools.filter(tool => !important.includes(tool.name) && tool.errors === 0).reduce((sum, tool) => sum + tool.calls, 0);
	if (other) named.push({ name: "other", calls: other, errors: 0 });
	return named.flatMap(tool => {
		const calls = plural(tool.calls, "call");
		const failure = tool.errors ? theme.fg("warning", `${tool.errors} failed`) : "";
		const numbers = `${calls}${failure ? ` · ${failure}` : ""}`;
		if (visibleWidth(tool.name) + 2 + visibleWidth(numbers) <= width - PANEL_ROW_INDENT)
			return [renderPanelRow(width, `${theme.fg("text", tool.name)}  ${numbers}`)];
		// Keep the identity (including its provider prefix) on its own bounded row.
		// Never let clipping swallow the whole failure marker after a long name.
		const rows = [renderPanelRow(width, theme.fg("text", truncateToWidth(tool.name, width - PANEL_ROW_INDENT, "…")))];
		if (visibleWidth(numbers) <= width - PANEL_ROW_INDENT) rows.push(renderPanelRow(width, numbers));
		else {
			rows.push(renderPanelRow(width, calls));
			if (failure) rows.push(renderPanelRow(width, failure));
		}
		return rows;
	});
}

/** STAT-tab rows in order: session, tools and ecosystem. */
export function buildStatsCards(snapshot: StatsCardsSnapshot, theme: StatsCardsTheme, width: number, density?: Density, state: StatsCardsState = {}): StatsCardsFrame {
	const frame: StatsCardsFrame = { rows: [], groups: [], headers: [] };
	if (width < 16) return frame;
	const muted = (text: string) => renderPanelRow(width, theme.fg("muted", text));
	const sessionBody = snapshot.session ? renderStatsRows(snapshot.session.stats, theme, width, snapshot.session.subscription, { includeTools: false }) : [muted("No session yet")];
	const versionRows = snapshot.ecosystem ? ecosystemBody(snapshot.ecosystem, theme, width) : [muted("Detecting versions…")];
	const detected = snapshot.ecosystem ? `${snapshot.ecosystem.filter(entry => entry.version !== undefined).length}/${snapshot.ecosystem.length}` : "";
	// Like MAIN Status and PROFILE, density gaps stay outside the card ranges so a
	// transparent surface can frame each card on its own.
	const gap = sectionGap(density) ? [" ".repeat(Math.max(0, width))] : [];
	const card = (id: StatsCardId, title: string, count: string, body: string[]) => {
		if (frame.groups.length) frame.rows.push(...gap);
		const start = frame.rows.length;
		frame.headers.push({ id, row: start });
		frame.rows.push(renderPanelHeader(theme as never, width, { title, count, open: !state.collapsed?.has(id), hovered: state.hovered === id }));
		if (!state.collapsed?.has(id)) frame.rows.push(...body.map(row => truncateToWidth(row, width, "…")));
		frame.groups.push({ start, end: frame.rows.length });
	};
	card("session", "Session", "", sessionBody);
	const stats = snapshot.session?.stats;
	const toolsCount = stats ? `${plural(stats.toolCalls, "call")}${stats.toolErrors ? ` · ${stats.toolErrors} failed` : ""}` : "";
	// A compact summary retains both counters even in the minimum supported rail.
	const toolsSummary = stats && visibleWidth(toolsCount) > width - 10 ? `${stats.toolCalls}${stats.toolErrors ? ` · ${stats.toolErrors}!` : " calls"}` : toolsCount;
	card("tools", "Tools", toolsSummary, stats ? (stats.toolCalls ? toolsBody(stats, theme, width) : [muted("No tool calls yet")]) : [muted("No session yet")]);
	card("ecosystem", "Ecosystem", detected, versionRows);
	return frame;
}
