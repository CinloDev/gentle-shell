import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost } from "./shell-bar.ts";
import { PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow, sectionGap } from "./shell-panel.ts";
import { paintGauge, type GaugePaint } from "./shell-gauge.ts";
import { groupUsageLimits, updatedAgo, type ProviderUsage } from "./shell-usage.ts";
import type { Density } from "./visual-customization-policy.ts";

// Gentle Shell PROFILE-tab cards: four read-only session snapshots. The host
// builds one plain snapshot per frame from memory — the profile reader's bound
// snapshot, the memoized session stats and the parsed profiles file — and this
// module only paints it. No filesystem, network or Git work ever happens here,
// matching the bound readers the rest of the rail depends on.

export type ProfileCardsSnapshot = {
	/** The active profile's display label ("name (session)") with its tier, when one is active. */
	profile?: { label: string; tier?: string };
	/** The live per-frame model and context data; absent when no model is loaded. */
	model?: { id: string; provider: string; effort?: string; contextPercent?: number; costTotal: number };
	/** The configured profile's role→model routing rows, in declaration order; effort is the role's thinking level when set. */
	routing: Array<{ role: string; model: string; effort?: string }>;
	/** All cached providers, without assuming a provider identifies a profile. */
	quotas?: readonly ProviderUsage[];
	/** Host clock for the shared reset-label policy; no clock or polling here. */
	now?: number;
	/** Already-resolved host gauge styling; painting never reads theme files. */
	gauge?: GaugePaint;
};

export type ProfileCardsTheme = { fg(role: string, text: string): string };

const TIER_LABEL: Record<string, string> = { standard: "Standard", fast: "Fast" };
const LINK = "→";

/** Compact remaining time for the sidebar ("1h 0m", "3d 2h", "now"); the shared usage panel keeps its own "resets in" wording. */
function compactReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "now";
	if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
	return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export type ProfileCardId = "profile" | "model" | "quotas" | "routing";
export type ProfileCardsState = { collapsed?: ReadonlySet<ProfileCardId>; hovered?: ProfileCardId };
export type ProfileCardsFrame = {
	rows: string[];
	groups: Array<{ start: number; end: number }>;
	headers: Array<{ id: ProfileCardId; row: number }>;
	/** Click targets that are not card headers, in the same logical row space. */
	actions: Array<{ id: "fetch-quotas"; row: number }>;
	/** Body rows that open the existing /gentle:profiles modal with the default preselection. */
	entries: Array<{ id: "open-profiles"; row: number }>;
	/** Role rows that open the modal focused on that routing row (orchestrator or agent). */
	roles: Array<{ id: "open-profiles-role"; row: number; role: string }>;
};

/** One-letter effort marker for the routing rows' right edge; empty when the role defines no effort. */
const EFFORT_LETTER: Record<string, string> = { off: "o", minimal: "n", low: "l", medium: "m", high: "h", xhigh: "x", max: "M" };

/** PROFILE-tab rows in order: profile, model/context, quotas and routing. */
export function buildProfileCards(snapshot: ProfileCardsSnapshot, theme: ProfileCardsTheme, width: number, density?: Density, state: ProfileCardsState = {}): ProfileCardsFrame {
	const profile = snapshot.profile;
	const profileBody: string[] = [];
	if (profile) {
		profileBody.push(renderPanelRow(width, theme.fg("text", truncateToWidth(profile.label, Math.max(0, width - PANEL_ROW_INDENT), "…"))));
		const tier = profile.tier ? TIER_LABEL[profile.tier] ?? profile.tier : undefined;
		if (tier) profileBody.push(renderPanelRow(width, theme.fg("muted", tier)));
	} else {
		profileBody.push(renderPanelRow(width, theme.fg("muted", "No active profile")));
	}
	const model = snapshot.model;
	const modelBody: string[] = [];
	if (model) {
		modelBody.push(renderPanelRow(width, theme.fg("text", truncateToWidth(`${model.provider} · ${model.id}`, Math.max(0, width - PANEL_ROW_INDENT), "…"))));
		if (model.effort) modelBody.push(renderPanelRow(width, theme.fg("muted", `Effort: ${model.effort}`)));
		if (model.contextPercent !== undefined) {
			const right = model.costTotal > 0 ? formatCost(model.costTotal) : "";
			modelBody.push(renderPanelRow(width, theme.fg("accent", `Context ${Math.round(model.contextPercent)}%`), right));
		}
	} else {
		modelBody.push(renderPanelRow(width, theme.fg("muted", "No model.")));
	}
	const quotaBody: string[] = [];
	// Scope the card to what the profile actually uses: providers named by the
	// routing refs, and within them the named models; non-model windows (Codex
	// 5h/week) ride along. An unmatched or non-referenced provider falls back to
	// its full cached rows rather than hiding real data; a profile with no
	// routing shows everything, like before this scoping.
	const routed = new Map<string, Set<string>>();
	for (const entry of snapshot.routing) {
		const slash = entry.model.indexOf("/");
		if (slash <= 0 || slash === entry.model.length - 1) continue;
		const provider = entry.model.slice(0, slash);
		const id = entry.model.slice(slash + 1);
		(routed.get(provider) ?? routed.set(provider, new Set()).get(provider)!).add(id);
	}
	const scoped = snapshot.routing.length
		? (snapshot.quotas ?? []).filter(usage => routed.has(usage.provider))
		: snapshot.quotas ?? [];
	for (const usage of scoped) {
		const room = Math.max(0, width - PANEL_ROW_INDENT);
		const now = snapshot.now ?? usage.fetchedAt;
		quotaBody.push(renderPanelRow(width, theme.fg("text", truncateToWidth([usage.provider, usage.plan, updatedAgo(usage.fetchedAt, now)].filter(Boolean).join(" · "), room, "…"))));
		const limits = groupUsageLimits(usage.limits);
		const matched = limits.filter(limit => routed.get(usage.provider)?.has(limit.name));
		// Referenced provider whose named models match some rows: show just those
		// rows (plus window rows without a model name, like Codex 5h/week). No
		// matching model (renamed/absent id) falls back to the provider's full
		// cached rows instead of silently hiding real data.
		const visibleLimits = matched.length ? matched : limits;
		const rows = visibleLimits.flatMap(limit => limit.windows
			.filter(window => Number.isFinite(window.usedPercent) && (matched.length ? routed.get(usage.provider)!.has(limit.name) : true))
			.map(window => ({ name: [limit.name, window.label].filter(Boolean).join(" "), window, reset: compactReset(window.resetAt, now) })));
		// One provider owns one column grid. The gauge gets priority: names take
		// their natural width capped at half the row, the gauge claims up to its
		// 16-cell budget, and the compact reset suffix appears only when a
		// near-full gauge still fits. Never a clipped right-hand fact.
		const desiredName = Math.min(Math.floor(room / 2), Math.max(1, ...rows.map(row => visibleWidth(row.name))));
		const resetWidth = Math.max(0, ...rows.map(row => row.reset ? visibleWidth(` · ${row.reset}`) : 0));
		const fixed = 6; // two gauge separators plus a 4-column percentage
		let showReset = resetWidth > 0;
		let cells = Math.min(16, room - desiredName - fixed - (showReset ? resetWidth : 0));
		if (cells < 4 && showReset) { showReset = false; cells = Math.min(16, room - desiredName - fixed); }
		if (cells < 2) cells = 2;
		const nameWidth = Math.max(1, Math.min(desiredName, room - cells - fixed - (showReset ? resetWidth : 0)));
		for (const row of rows) {
			const label = truncateToWidth(row.name, nameWidth, "…");
			const name = label + " ".repeat(Math.max(0, nameWidth - visibleWidth(label)));
			const percent = `${Math.round(row.window.usedPercent)}%`.padStart(4);
			const tail = showReset && row.reset ? theme.fg("muted", ` · ${row.reset}`) : "";
			quotaBody.push(renderPanelRow(width, `${theme.fg("muted", name)} ${paintGauge(row.window.usedPercent, theme, cells, snapshot.gauge)} ${theme.fg("text", percent)}${tail}`));
		}
	}
	if (!quotaBody.length) {
		quotaBody.push(renderPanelRow(width, theme.fg("muted", snapshot.quotas?.length ? "No cached quotas match this profile's routing" : "Run /gentle:usage to fetch")));
		var quotaHint = true;
	}
	const routingBody: string[] = snapshot.routing.length
		? snapshot.routing.map(entry => {
			const arrow = ` ${LINK} `;
			// The panel owns indentation; reserve the arrow once, then share the rest.
			const room = Math.max(0, width - PANEL_ROW_INDENT - visibleWidth(arrow));
			const left = truncateToWidth(entry.role, Math.max(1, Math.min(room, Math.floor((room - 1) / 2))), "…");
			const right = truncateToWidth(entry.model, Math.max(1, room - visibleWidth(left)), "…");
				const effort = entry.effort ? EFFORT_LETTER[entry.effort] ?? entry.effort.slice(0, 1) : "";
			// The marker column is RESERVED on every row and the model column gets
			// whatever the row has left after the role and the reserved marker: a
			// FIXED per-row budget. Every model truncates to that same width (…
			// included), so all rows share one … column and the effort letter (or
			// its space) sits in the same right-edge column on every row, and the
			// outer row clip can never discard the marker.
			const reserve = 2; // one gap column + the marker column
			const modelBudget = Math.max(1, room - visibleWidth(left) - reserve);
			const modelText = truncateToWidth(entry.model, modelBudget, "…");
			const pad = " ".repeat(Math.max(0, modelBudget - visibleWidth(modelText) + 1));
			return renderPanelRow(width, `${theme.fg("text", left)}${theme.fg("muted", ` ${LINK} `)}${theme.fg("accent", modelText)}${pad}${effort ? theme.fg("warning", effort) : " "}`);
		})
		: [renderPanelRow(width, theme.fg("muted", "No routing rows"))];
	// Like MAIN Status, keep density gaps outside the card ranges. Transparent
	// chrome consumes the groups and owns its own neon/float spacing instead.
	const gap = sectionGap(density) ? [" ".repeat(Math.max(0, width))] : [];
	const frame: ProfileCardsFrame = { rows: [], groups: [], headers: [], actions: [], entries: [], roles: [] };
	if (width < 16) return frame;
	const card = (id: ProfileCardId, title: string, count: string, body: string[]) => {
		if (frame.groups.length) frame.rows.push(...gap);
		const start = frame.rows.length;
		frame.headers.push({ id, row: start });
		frame.rows.push(renderPanelHeader(theme as never, width, { title, count, open: !state.collapsed?.has(id), hovered: state.hovered === id }));
		if (!state.collapsed?.has(id)) {
		const bodyStart = frame.rows.length;
		frame.rows.push(...body.map(row => truncateToWidth(row, width, "…")));
		// Role rows carry their routing target: the model card's first row is the
		// orchestrator; each routing row is its own agent. The panel's open-time
		// state decides whether the named row still exists.
		if (id === "model" && model) frame.roles.push({ id: "open-profiles-role", row: bodyStart, role: "orchestrator" });
		if (id === "routing") {
			snapshot.routing.forEach((entry, index) => frame.roles.push({ id: "open-profiles-role", row: bodyStart + index, role: entry.role }));
		}
	}
		frame.groups.push({ start, end: frame.rows.length });
	};
	card("profile", "Profile", profile?.tier ? TIER_LABEL[profile.tier] ?? profile.tier : "", profileBody);
	// T5 scoped entry: the profile card's body rows open the existing modal; the
	// header row keeps collapsing. Absent profile has nothing to preselect.
	if (profile && !state.collapsed?.has("profile")) {
		const profileHeader = frame.headers[frame.headers.length - 1].row;
		for (let row = profileHeader + 1; row < frame.rows.length; row++) frame.entries.push({ id: "open-profiles", row });
	}
	card("model", "Model", "", modelBody);
	card("quotas", "Quotas", "", quotaBody);
	// The hint row is the one non-header click target: clicking it asks the
	// existing usage refresh owner for the scoped providers.
	if (quotaHint && !state.collapsed?.has("quotas")) frame.actions.push({ id: "fetch-quotas", row: frame.headers[frame.headers.length - 1].row + 1 });
	card("routing", "Routing", `${snapshot.routing.length}`, routingBody);
	return frame;
}

/**
 * Row ranges of the four cards, for a transparent rail that draws each card
 * with its own chrome; the host hands this straight to its rail's cardGroups.
 */
export function profileCardGroups(snapshot: ProfileCardsSnapshot, density?: Density, state: ProfileCardsState = {}, width = 60): { groups: Array<{ start: number; end: number }>; loose?: number[] } {
	return { groups: buildProfileCards(snapshot, { fg: (_role, text) => text }, width, density, state).groups };
}

export function renderProfileCards(snapshot: ProfileCardsSnapshot, theme: ProfileCardsTheme, width: number, density?: Density, state: ProfileCardsState = {}): string[] {
	return buildProfileCards(snapshot, theme, width, density, state).rows;
}
