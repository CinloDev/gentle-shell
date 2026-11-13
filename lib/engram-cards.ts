import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow, sectionGap } from "./shell-panel.ts";
import { updatedAgo } from "./shell-usage.ts";
import type { Density } from "./visual-customization-policy.ts";

// Gentle Shell MEM-tab cards: read-only Engram snapshots. The host polls the
// local daemon only while the tab is visible and hands this module a plain
// snapshot per frame — this module only paints it and parses payloads. No
// filesystem, network or CLI work ever happens here, matching the pure
// painters the rest of the rail depends on. Two independent cards (L17/L18):
// ENGRAM for the local daemon and ENGRAM CLOUD for cloud sync. Each is its own
// collapsible card — collapse belongs to card titles only, so inner groupings
// are plain always-visible label rows (L20). Visibility = preference ∧
// availability: the host hides a card whose preference is off; this module
// hides a card whose data source does not exist. Painted data stays useful:
// identity in the title, project as a data row, numbers in the accent color,
// never ports, versions, server URLs or ellipsis markers (rows cut clean).

export type EngramLocalSnapshot = {
	/** True when the daemon answered /health with status ok. */
	online: boolean;
	/** The daemon port the host probed (127.0.0.1 by default), for the offline reason. */
	port: number;
};

export type EngramCloudSync = "synced" | "pending" | "unenrolled" | "disabled" | "error";

export type EngramCloudSnapshot = {
	/** Cloud server base URL from cloud.json, when configured. */
	server?: string;
	/** Derived project-scoped sync state; see deriveEngramCloudSnapshot. */
	sync: EngramCloudSync;
	/** Human-readable reason from the daemon, when the state is blocked. */
	reason?: string;
	/** Epoch ms of the last successful sync, when reported. */
	lastSyncAt?: number;
	/** Chunks the daemon could not push yet, when reported. */
	deferred: number;
};

export type EngramObservationSnapshot = {
	title: string;
	type: string;
	createdAt: number;
};

export type EngramCardsSnapshot = {
	/** undefined while the first probe is pending; false when the daemon never answered. */
	daemonAvailable?: boolean;
	/** Local daemon probe result; present once the daemon answered at least once. */
	local?: EngramLocalSnapshot;
	/** Project-scoped counts from /stats?project=…; absent when unknown. */
	observations?: number;
	sessions?: number;
	/** The repository project the counts belong to, when known. */
	project?: string;
	/** Observations created since local midnight, from the cached observation list. */
	today?: number;
	/** Observations created in the last seven days. */
	week?: number;
	/** Newest observations first, already capped by the host. */
	latest?: EngramObservationSnapshot[];
	/** Cloud snapshot; absent when no cloud.json exists, so the card vanishes. */
	cloud?: EngramCloudSnapshot;
	/** Host clock for the shared ago-label policy; no clock or polling here. */
	now?: number;
};

export type EngramCardId = "engram" | "cloud";
export type EngramFoldId = EngramCardId;
export type EngramCardsState = {
	collapsed?: ReadonlySet<EngramCardId>;
	hovered?: EngramCardId;
	/** Preference-hidden cards paint nothing at all; the host derives this from the tabs policy. */
	hidden?: ReadonlySet<EngramCardId>;
};
export type EngramCardsFrame = {
	rows: string[];
	/** Top-level card ranges only; the rail's cardGroups consume these. */
	groups: Array<{ start: number; end: number }>;
	headers: Array<{ id: EngramCardId; row: number }>;
	/** Click targets that are not card headers, in the same logical row space. */
	actions: Array<{ id: "open-dashboard" | "enroll"; row: number }>;
};

export type EngramCardsTheme = { fg(role: string, text: string): string };

/**
 * Pure parse of `engram cloud status --project <name>` stdout: the daemon's
 * /sync/status is global and stays healthy while projects are unenrolled, so
 * per-project enrollment comes from this CLI line (L24). undefined = unknown.
 */
export function parseEngramEnrollment(stdout: string): boolean | undefined {
	const line = /Project enrollment:\s*([^\n]+)/.exec(stdout)?.[1]?.trim();
	if (!line) return undefined;
	if (line.startsWith("not enrolled")) return false;
	if (line.startsWith("enrolled")) return true;
	return undefined;
}

/**
 * The cloud dashboard lives under /dashboard/ on the configured server — the
 * bare server_url is not the login page (user-verified, L22). Idempotent: a
 * server already ending in /dashboard/ passes through unchanged.
 */
export function engramDashboardUrl(server: string): string {
	const base = server.replace(/\/+$/, "");
	return base.endsWith("/dashboard") ? `${base}/` : `${base}/dashboard/`;
}

/** Pure parse of a /health payload into the local card's snapshot; null body means offline. */
export function parseEngramHealth(body: unknown | null, port: number): EngramLocalSnapshot {
	return { online: body !== null && typeof body === "object" && (body as { status?: unknown }).status === "ok", port };
}

/** Pure parse of a /stats payload's project-scoped observation and session counts. */
export function parseEngramStats(body: unknown): { observations?: number; sessions?: number } {
	if (body === null || typeof body !== "object") return { observations: undefined, sessions: undefined };
	const record = body as { total_observations?: unknown; total_sessions?: unknown };
	const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	return { observations: count(record.total_observations), sessions: count(record.total_sessions) };
}

/**
 * Pure derivation of the local card's activity data from the daemon's
 * observation list (newest first is not assumed: it is re-sorted). Today is
 * local midnight of the host clock; week is the trailing seven days.
 */
export function parseEngramObservationList(body: unknown, now: number): { today?: number; week?: number; latest?: EngramObservationSnapshot[] } {
	if (!Array.isArray(body)) return { today: undefined, week: undefined, latest: undefined };
	const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
	const items: EngramObservationSnapshot[] = [];
	for (const raw of body) {
		if (raw === null || typeof raw !== "object") continue;
		const record = raw as { title?: unknown; type?: unknown; created_at?: unknown };
		if (typeof record.title !== "string" || !record.title) continue;
		const createdAt = typeof record.created_at === "string" && record.created_at ? Date.parse(record.created_at) : NaN;
		if (!Number.isFinite(createdAt)) continue;
		items.push({ title: record.title, type: typeof record.type === "string" ? record.type : "", createdAt });
	}
	items.sort((a, b) => b.createdAt - a.createdAt);
	return {
		today: items.filter(item => item.createdAt >= midnight.getTime()).length,
		week: items.filter(item => item.createdAt >= now - 7 * 86_400_000).length,
		latest: items,
	};
}

type EngramSyncPayload = {
	enabled?: unknown;
	phase?: unknown;
	reason_code?: unknown;
	reason_message?: unknown;
	last_error?: unknown;
	last_sync_at?: unknown;
	deferred_count?: unknown;
};

/**
 * Pure derivation of the cloud card's snapshot from cloud.json's server, the
 * daemon's /sync/status payload and the project's enrollment state. Order
 * matters: disabled and unenrolled win over phase, then errors, then health.
 */
export function deriveEngramCloudSnapshot(
	server: string | undefined,
	sync: EngramSyncPayload | null,
	enrolled: boolean | undefined,
): EngramCloudSnapshot | undefined {
	if (!server) return undefined;
	const cloud: EngramCloudSnapshot = { server, sync: "pending", deferred: 0 };
	if (sync) {
		if (sync.enabled === false) cloud.sync = "disabled";
		else if (sync.reason_code === "blocked_unenrolled" || enrolled === false) cloud.sync = "unenrolled";
		else if (sync.phase === "healthy") cloud.sync = "synced";
		else if (typeof sync.last_error === "string" && sync.last_error) cloud.sync = "error";
		if (typeof sync.reason_message === "string" && sync.reason_message) cloud.reason = sync.reason_message;
		if (typeof sync.deferred_count === "number" && Number.isFinite(sync.deferred_count) && sync.deferred_count > 0) cloud.deferred = sync.deferred_count;
		if (typeof sync.last_sync_at === "string" && sync.last_sync_at) {
			const parsed = Date.parse(sync.last_sync_at);
			if (Number.isFinite(parsed)) cloud.lastSyncAt = parsed;
		}
	}
	return cloud;
}

/** Stable digest of the data that changes the painting, for the host's per-change memo. */
export function engramCardsDigest(snapshot: EngramCardsSnapshot): string {
	return JSON.stringify([snapshot.daemonAvailable, snapshot.local, snapshot.observations, snapshot.sessions, snapshot.project, snapshot.today, snapshot.week, snapshot.latest, snapshot.cloud, snapshot.now ?? null]);
}

const SYNC_LABEL: Record<EngramCloudSync, string> = {
	synced: "Synced",
	pending: "Pending",
	unenrolled: "Not enrolled",
	disabled: "Disabled",
	error: "Error",
};
const ONLINE = "●";
const LATEST_LIMIT = 5;
const DASH = "↗ dashboard";

/** MEM-tab rows: the local Engram card and, when configured, the cloud card. */
export function buildEngramCards(snapshot: EngramCardsSnapshot, theme: EngramCardsTheme, width: number, density?: Density, state: EngramCardsState = {}): EngramCardsFrame {
	const gap = sectionGap(density) ? [" ".repeat(Math.max(0, width))] : [];
	const frame: EngramCardsFrame = { rows: [], groups: [], headers: [], actions: [] };
	if (width < 16) return frame;
	const room = Math.max(0, width - PANEL_ROW_INDENT);
	const hidden = state.hidden ?? new Set<EngramCardId>();
	const open = (id: EngramCardId) => !state.collapsed?.has(id);
	const cut = (row: string) => truncateToWidth(row, width, "");
	// Cards share the panel-header contract: glyph, name, count, hover — the
	// same chrome PROFILE and GIT use. The painter closure runs only while the
	// card is open, so every body row lands inside its card's group range.
	const card = (id: EngramCardId, title: string, count: string, paint?: () => void) => {
		if (frame.groups.length) frame.rows.push(...gap);
		const start = frame.rows.length;
		frame.headers.push({ id, row: start });
		frame.rows.push(renderPanelHeader(theme as never, width, { title, count, open: open(id), hovered: state.hovered === id }));
		if (open(id)) paint?.();
		frame.groups.push({ start, end: frame.rows.length });
	};
	// Accent for the numbers, muted for labels — a little more color without
	// turning the card into a christmas tree (L20).
	const num = (value: number) => theme.fg("accent", `${value}`);
	const label = (text: string) => theme.fg("muted", text);
	// ENGRAM: the local daemon card. Hidden when the daemon never answered
	// (availability), explained when it answers offline, one status dot always.
	if (!hidden.has("engram") && snapshot.daemonAvailable !== false) {
		const local = snapshot.local;
		// The header paints before the body, so the count cannot depend on the paint closure.
		const count = !local ? "" : local.online ? "Online" : "Offline";
		card("engram", "Engram", count, () => {
			if (!local) {
				frame.rows.push(renderPanelRow(width, label("Probing daemon…")));
				return;
			}
			if (local.online) {
				const counts = [
					snapshot.observations === undefined ? "" : `${num(snapshot.observations)} observations`,
					snapshot.sessions === undefined ? "" : `${num(snapshot.sessions)} sessions`,
				].filter(Boolean).join(theme.fg("muted", " · "));
				frame.rows.push(renderPanelRow(width, `${theme.fg("accent", ONLINE)} ${theme.fg("text", `Online${counts ? ` · ${counts}` : ""}`)}`));
			} else {
				frame.rows.push(renderPanelRow(width, label(`Daemon 127.0.0.1:${local.port} not responding`)));
			}
			if (snapshot.project) frame.rows.push(renderPanelRow(width, `${label("Project: ")}${theme.fg("text", snapshot.project)}`));
			if (snapshot.today !== undefined) {
				frame.rows.push(renderPanelRow(width, theme.fg("accent", "TODAY")));
				frame.rows.push(renderPanelRow(width, `${num(snapshot.today)} ${label("memorized today")}${snapshot.week === undefined ? "" : `${theme.fg("muted", " · ")}${num(snapshot.week)} ${label("this week")}`}`));
			}
			if (snapshot.latest?.length) {
				frame.rows.push(renderPanelRow(width, theme.fg("accent", "LATEST OBSERVATIONS")));
				const now = snapshot.now;
				for (const item of snapshot.latest.slice(0, LATEST_LIMIT)) {
					const age = now === undefined ? "" : updatedAgo(item.createdAt, now).replace(/^updated /, "");
					// The title budget accounts for the age column, so fitPanelLine never
					// clips: the shared clip appends an ellipsis the cards must not show.
					const titleRoom = Math.max(1, width - visibleWidth(age) - (age ? 1 : 0) - PANEL_ROW_INDENT);
					frame.rows.push(renderPanelRow(width, theme.fg("text", truncateToWidth(item.title, titleRoom, "")), age ? label(age) : ""));
				}
			}
		});
	}
	// ENGRAM CLOUD: independent card, painted only when cloud.json exists.
	const cloud = snapshot.cloud;
	if (!hidden.has("cloud") && cloud) {
		// The daemon's last-sync timestamp is global: it only reads as this
		// project's progress while the project itself is synced (L24).
		const ago = cloud.lastSyncAt !== undefined && snapshot.now !== undefined && cloud.sync === "synced" ? `Last sync ${updatedAgo(cloud.lastSyncAt, snapshot.now).replace(/^updated /, "")}` : "";
		const syncRow = cloud.sync === "synced" && cloud.deferred === 0 ? `${ago || `Sync: ${SYNC_LABEL[cloud.sync]}`} · nothing pending`
			: ago || `Sync: ${SYNC_LABEL[cloud.sync]}`;
		const body = [renderPanelRow(width, label(syncRow))];
		if (cloud.deferred > 0) body.push(renderPanelRow(width, theme.fg("warning", `⚠ ${cloud.deferred} deferred`)));
		if (cloud.reason && cloud.sync !== "synced") body.push(renderPanelRow(width, label(truncateToWidth(cloud.reason, room, ""))));
		// The web affordance is its own accent row: sync state reads as data,
		// the way into the memories lives where a cursor can find it (L20).
		body.push(renderPanelRow(width, theme.fg("accent", DASH)));
		// Dedicated shortcut row for the enroll action: actions always point at a
		// real body row, never a computed offset, so earlier rows cannot shift it.
		if (cloud.sync === "unenrolled") body.push(renderPanelRow(width, theme.fg("accent", "+ Enroll this project")));
		card("cloud", "Engram cloud", SYNC_LABEL[cloud.sync], () => { frame.rows.push(...body); });
		// Click targets: the dashboard row opens the web; the enroll shortcut row
		// asks the host to run the enrollment (the host confirms first). A
		// collapsed card paints no body, so it owns no body-row actions.
		if (open("cloud")) {
			const header = frame.headers[frame.headers.length - 1].row;
			const dashRow = body.findIndex(row => row.includes(DASH));
			if (dashRow >= 0) frame.actions.push({ id: "open-dashboard", row: header + 1 + dashRow });
			const enrollRow = body.findIndex(row => row.includes("Enroll this project"));
			if (enrollRow >= 0) frame.actions.push({ id: "enroll", row: header + 1 + enrollRow });
		}
	}
	// One width pass over every painted row, cutting clean — no ellipsis (L20).
	frame.rows = frame.rows.map(cut);
	return frame;
}

/**
 * Row ranges of the visible cards, for a transparent rail that draws each card
 * with its own chrome; the host hands this straight to its rail's cardGroups.
 */
export function engramCardGroups(snapshot: EngramCardsSnapshot, density?: Density, state: EngramCardsState = {}, width = 60): { groups: Array<{ start: number; end: number }> } {
	return { groups: buildEngramCards(snapshot, { fg: (_role, text) => text }, width, density, state).groups };
}

export function renderEngramCards(snapshot: EngramCardsSnapshot, theme: EngramCardsTheme, width: number, density?: Density, state: EngramCardsState = {}): string[] {
	return buildEngramCards(snapshot, theme, width, density, state).rows;
}
