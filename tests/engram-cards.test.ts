import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import { stripAnsi } from "../lib/terminal-theme.ts";
import {
	buildEngramCards,
	deriveEngramCloudSnapshot,
	engramCardGroups,
	engramCardsDigest,
	parseEngramHealth,
	parseEngramObservationList,
	parseEngramStats,
	renderEngramCards,
	engramDashboardUrl,
	parseEngramEnrollment,
	type EngramCardId,
	type EngramCardsSnapshot,
} from "../lib/engram-cards.ts";

const theme = { fg: (_role: string, text: string) => text };
const plain = (rows: string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));
const NOW = 1_788_600_000_000;

const enrolled: EngramCardsSnapshot = {
	daemonAvailable: true,
	local: { online: true, port: 7437 },
	observations: 183,
	sessions: 633,
	project: "gentle-shell",
	today: 1,
	week: 25,
	latest: [
		{ title: "Plan engram-session-card: rama y documentación de tareas creadas", type: "decision", createdAt: NOW - 597 * 60_000 },
		{ title: "Track trial main integration after TREE", type: "decision", createdAt: NOW - 1190 * 60_000 },
	],
	cloud: { server: "https://engram.cinlodev.com", sync: "synced", lastSyncAt: NOW - 60_000, deferred: 0 },
	now: NOW + 60_000,
};

const cardIds: EngramCardId[] = ["engram", "cloud"];

test("engram card frames align headers and groups for every collapse combination and empty state", () => {
	const snapshots: EngramCardsSnapshot[] = [
		enrolled,
		{ daemonAvailable: false },
		{},
	];
	for (const snapshot of snapshots) for (const density of ["comfortable", "compact", "minimal"] as const) for (const width of [12, 16, 30, 60]) for (let mask = 0; mask < 4; mask++) {
		const collapsed = new Set(cardIds.filter((_id, index) => mask & (1 << index)));
		const frame = buildEngramCards(snapshot, theme, width, density, { collapsed });
		assert.deepEqual(renderEngramCards(snapshot, theme, width, density, { collapsed }), frame.rows);
		assert.deepEqual(engramCardGroups(snapshot, density, { collapsed }, width).groups, frame.groups);
		if (width < 16) { assert.deepEqual(frame, { rows: [], groups: [], headers: [], actions: [] }); continue; }
		const expected: EngramCardId[] = [...(snapshot.daemonAvailable === false ? [] : ["engram" as const]), ...(snapshot.cloud ? ["cloud" as const] : [])];
		assert.deepEqual(frame.headers.map(header => header.id), expected);
		assert.equal(frame.groups.length, expected.length);
		if (!expected.length) continue;
		frame.groups.forEach((group, index) => {
			assert.equal(frame.headers[index].row, group.start);
			assert.match(frame.rows[group.start], new RegExp(`${collapsed.has(expected[index]) ? "▸" : "▾"} ENGRAM`));
			if (width >= 30) assert.match(frame.rows[group.start], new RegExp(`${expected[index] === "cloud" ? "ENGRAM CLOUD" : "ENGRAM\\s"}`));
			assert.equal(group.end - group.start === 1, collapsed.has(expected[index]));
			if (index) assert.equal(group.start - frame.groups[index - 1].end, density === "comfortable" ? 1 : 0);
		});
		assert.equal(frame.groups.at(-1)!.end, frame.rows.length);
		assert.ok(frame.rows.every(row => visibleWidth(row) <= width));
	}
});

test("engram local card paints colored data rows and plain section labels, never sub-headers", () => {
	const frame = buildEngramCards(enrolled, theme, 60);
	const text = plain(frame.rows).join("\n");
	// Identity is the card title, never the project name (L17/L18).
	assert.match(text, /▾ ENGRAM\s+Online/);
	assert.doesNotMatch(text, /GENTLE-SHELL\s+Online/);
	// Exactly one status dot and one disclosure glyph per painted card header:
	// section labels are plain rows, collapse belongs to card titles only (L20).
	assert.equal((text.match(/●/g) ?? []).length, 1);
	assert.deepEqual(frame.headers.map(header => header.id), ["engram", "cloud"]);
	assert.match(text, /● Online · 183 observations · 633 sessions/);
	assert.match(text, /Project: gentle-shell/);
	assert.match(text, /^\s*TODAY\s*$/m);
	assert.match(text, /1 memorized today · 25 this week/);
	assert.match(text, /^\s*LATEST OBSERVATIONS\s*$/m);
	assert.match(text, /Plan engram-session-card/);
	assert.match(text, /598m ago/);
	// Truncation cuts clean: no ellipsis marker anywhere (L20).
	assert.ok(frame.rows.every(row => !row.includes("…")));
	// Port and version are host detail, never data (L12).
	assert.doesNotMatch(text, /127\.0\.0\.1:7437/);
	assert.doesNotMatch(text, /v3\.6\.2/);
	// The colored theme paints the numbers with the accent role.
	const colored = buildEngramCards(enrolled, { fg: (role, t) => role === "accent" ? `\x1b[31m${t}\x1b[39m` : t }, 60);
	assert.match(colored.rows[1], /\x1b\[31m183\x1b\[39m/);
	// Section labels share the numbers' accent so they read as a different
	// kind of row; muted alone blends into the other labels (L23).
	const accentRow = (needle: string) => colored.rows.find(row => stripAnsi(row).trim() === needle);
	assert.match(accentRow("TODAY")!, /\x1b\[31mTODAY\x1b\[39m/);
	assert.match(accentRow("LATEST OBSERVATIONS")!, /\x1b\[31mLATEST OBSERVATIONS\x1b\[39m/);
});

test("engram cloud card paints a dashboard affordance row and vanishes without cloud.json", () => {
	const rows = plain(renderEngramCards(enrolled, theme as never, 60));
	const groups = engramCardGroups(enrolled, undefined, {}, 60).groups;
	const cloudText = rows.slice(groups[1].start, groups[1].end).join("\n");
	assert.match(cloudText, /Last sync 2m ago · nothing pending/);
	assert.match(cloudText, /↗ dashboard/);
	assert.doesNotMatch(cloudText, /Sync: Synced/);
	assert.doesNotMatch(cloudText, /engram\.cinlodev\.com/);
	assert.doesNotMatch(cloudText, /No cloud configured/);
	// The dashboard action points at the affordance row, not a computed offset.
	const frame = buildEngramCards(enrolled, theme, 60);
	const openRow = frame.actions.find(action => action.id === "open-dashboard")!.row;
	assert.match(stripAnsi(frame.rows[openRow]), /↗ dashboard/);
	// No cloud.json means no card at all, not a placeholder (L17/L18).
	const bare = buildEngramCards({ daemonAvailable: true, local: { online: true, port: 7437 } }, theme, 60);
	assert.deepEqual(bare.headers.map(header => header.id), ["engram"]);
	assert.equal(bare.groups.length, 1);
});

test("engram cards hidden by preference paint nothing at all", () => {
	const noCloud = buildEngramCards(enrolled, theme, 60, undefined, { hidden: new Set(["cloud"]) });
	assert.deepEqual(noCloud.headers.map(header => header.id), ["engram"]);
	assert.doesNotMatch(plain(noCloud.rows).join("\n"), /CLOUD/);
	const none = buildEngramCards(enrolled, theme, 60, undefined, { hidden: new Set(["engram", "cloud"]) });
	assert.deepEqual(none, { rows: [], groups: [], headers: [], actions: [] });
	// A collapsed card keeps only its header row.
	const collapsed = buildEngramCards(enrolled, theme, 60, undefined, { collapsed: new Set(["engram"]) });
	assert.match(stripAnsi(collapsed.rows[0]), /▸ ENGRAM/);
	assert.equal(collapsed.groups[0].end - collapsed.groups[0].start, 1);
});

test("engram availability, offline and sync problems paint their own rows", () => {
	const probing = plain(renderEngramCards({}, theme as never, 60)).join("\n");
	assert.match(probing, /Probing daemon…/);
	const gone = buildEngramCards({ daemonAvailable: false }, theme, 60);
	assert.deepEqual(gone.headers.map(header => header.id), []);
	const offline = plain(renderEngramCards({ daemonAvailable: true, local: { online: false, port: 7437 } }, theme as never, 60)).join("\n");
	assert.match(offline, /ENGRAM\s+Offline/);
	assert.match(offline, /Daemon 127\.0\.0\.1:7437 not responding/);
	const errored = plain(renderEngramCards({ ...enrolled, cloud: { server: "https://engram.cinlodev.com", sync: "error", lastSyncAt: NOW - 600_000, deferred: 3, reason: "connection refused" } }, theme as never, 60)).join("\n");
	assert.match(errored, /ENGRAM CLOUD\s+Error/);
	assert.match(errored, /⚠ 3 deferred/);
	assert.match(errored, /connection refused/);
});

test("engram unenrolled cloud shows the reason and a dedicated enroll action row", () => {
	const snapshot: EngramCardsSnapshot = {
		daemonAvailable: true,
		local: { online: true, port: 7437 },
		observations: 3,
		cloud: { server: "https://engram.cinlodev.com", sync: "unenrolled", reason: "project \"gentle-shell\" is not enrolled for cloud sync", deferred: 0 },
	};
	const frame = buildEngramCards(snapshot, theme, 60, "compact");
	const header = frame.headers[frame.headers.length - 1].row;
	const actions = frame.actions.filter(action => action.row > header);
	assert.deepEqual(actions.map(action => action.id), ["open-dashboard", "enroll"]);
	const enrollRow = frame.rows[actions.find(action => action.id === "enroll")!.row];
	assert.match(stripAnsi(enrollRow), /Enroll this project/);
	const collapsed = buildEngramCards(snapshot, theme, 60, "compact", { collapsed: new Set(["cloud"]) });
	const cloudHeader = collapsed.headers[collapsed.headers.length - 1].row;
	assert.deepEqual(collapsed.actions.filter(action => action.row > cloudHeader).map(action => action.id), []);
});

test("engram cards spend the full useful width on long text", () => {
	const colored = { fg: (_role: string, text: string) => `\x1b[36m${text}\x1b[39m` };
	for (const paint of [theme, colored]) for (const width of [16, 20, 30, 60]) {
		const snapshot: EngramCardsSnapshot = {
			daemonAvailable: true,
			local: { online: true, port: 7437 },
			observations: 99999,
			project: "配置-项目-".repeat(10),
			latest: [{ title: "configuration-observation-title-".repeat(8), type: "discovery", createdAt: NOW - 120_000 }],
			cloud: { server: "https://engram.cinlodev.com", sync: "pending", deferred: 0 },
		};
		const rows = renderEngramCards(snapshot, paint, width, "compact");
		assert.ok(rows.every(row => visibleWidth(row) <= width));
		const groups = engramCardGroups(snapshot, "compact", {}, width).groups;
		assert.match(stripAnsi(rows[groups[0].start]), /ENGRAM/);
		assert.match(stripAnsi(rows[groups[0].start + 1]), /● Online/);
		assert.match(stripAnsi(rows[groups[1].start + 1]), /Sync: Pending/);
		if (width >= 48) assert.match(stripAnsi(rows[groups[0].start + 1]), /99999 observations/);
	}
});

test("parseEngramHealth tolerates malformed payloads", () => {
	assert.deepEqual(parseEngramHealth(null, 7437), { online: false, port: 7437 });
	assert.deepEqual(parseEngramHealth("junk", 7437), { online: false, port: 7437 });
	assert.deepEqual(parseEngramHealth({ status: "ok", version: "3.6.2" }, 7437), { online: true, port: 7437 });
	assert.deepEqual(parseEngramHealth({ status: "degraded" }, 7437), { online: false, port: 7437 });
});

test("parseEngramStats tolerates malformed payloads", () => {
	assert.deepEqual(parseEngramStats({ total_observations: 183, total_sessions: 633 }), { observations: 183, sessions: 633 });
	assert.deepEqual(parseEngramStats({ total_observations: 3 }), { observations: 3, sessions: undefined });
	assert.deepEqual(parseEngramStats({ total_sessions: NaN }), { observations: undefined, sessions: undefined });
	assert.deepEqual(parseEngramStats(null), { observations: undefined, sessions: undefined });
	assert.deepEqual(parseEngramStats("junk"), { observations: undefined, sessions: undefined });
});

test("parseEngramObservationList derives today, week and the latest titles", () => {
	const list = [
		{ title: "this morning", type: "decision", created_at: "2026-11-13 06:21:24", junk: true },
		{ title: "last week", type: "discovery", created_at: "2026-11-07 06:00:00" },
		{ title: "older", type: "pattern", created_at: "2026-11-01 06:00:00" },
		{ title: 42, type: "decision", created_at: "2026-11-13 07:00:00" },
		{ title: "no date", type: "decision" },
	];
	const noon = new Date("2026-11-13T12:00:00").getTime();
	const parsed = parseEngramObservationList(list, noon);
	assert.equal(parsed.today, 1);
	assert.equal(parsed.week, 2);
	assert.deepEqual(parsed.latest?.map(item => item.title), ["this morning", "last week", "older"]);
	assert.equal(parseEngramObservationList(null, noon).latest, undefined);
	assert.equal(parseEngramObservationList("junk", noon).today, undefined);
	assert.deepEqual(parseEngramObservationList([], noon), { today: 0, week: 0, latest: [] });
});

test("deriveEngramCloudSnapshot orders disabled, unenrolled, error and healthy states", () => {
	const server = "https://engram.cinlodev.com";
	assert.equal(deriveEngramCloudSnapshot(undefined, { phase: "healthy" }, true), undefined, "no cloud.json means no cloud card");
	assert.deepEqual(deriveEngramCloudSnapshot(server, null, undefined), { server, sync: "pending", deferred: 0 });
	assert.deepEqual(deriveEngramCloudSnapshot(server, { enabled: false }, undefined), { server, sync: "disabled", deferred: 0 });
	assert.deepEqual(deriveEngramCloudSnapshot(server, { phase: "healthy", reason_code: "blocked_unenrolled", reason_message: "not enrolled" }, undefined), { server, sync: "unenrolled", reason: "not enrolled", deferred: 0 });
	assert.deepEqual(deriveEngramCloudSnapshot(server, { phase: "healthy", deferred_count: 3, last_sync_at: "2026-11-13T04:02:54.553-03:00" }, true), { server, sync: "synced", deferred: 3, lastSyncAt: Date.parse("2026-11-13T04:02:54.553-03:00") });
	const errored = deriveEngramCloudSnapshot(server, { phase: "backoff", last_error: "connection refused" }, true);
	assert.equal(errored?.sync, "error");
	const withTime = deriveEngramCloudSnapshot(server, { phase: "healthy", last_sync_at: "not-a-date" }, true);
	assert.equal(withTime?.lastSyncAt, undefined, "unparseable timestamps are dropped, not invented");
});

test("parseEngramEnrollment reads the CLI's project enrollment line", () => {
	assert.equal(parseEngramEnrollment("Project enrollment: not enrolled (gentle-shell)"), false);
	assert.equal(parseEngramEnrollment("Project enrollment: enrolled (gentle-shell)"), true);
	assert.equal(parseEngramEnrollment("Cloud status: configured\nProject enrollment: not enrolled (x)"), false);
	assert.equal(parseEngramEnrollment("garbage"), undefined);
	assert.equal(parseEngramEnrollment(""), undefined);
	// The noisy update-check stderr line must not decide enrollment.
	assert.equal(parseEngramEnrollment("Could not check for updates\nProject enrollment: not enrolled (x)"), false);
});

test("engramDashboardUrl lands on the cloud login, never the bare server", () => {
	assert.equal(engramDashboardUrl("https://engram.cinlodev.com"), "https://engram.cinlodev.com/dashboard/");
	assert.equal(engramDashboardUrl("https://engram.cinlodev.com/"), "https://engram.cinlodev.com/dashboard/");
	assert.equal(engramDashboardUrl("https://engram.cinlodev.com/extra"), "https://engram.cinlodev.com/extra/dashboard/");
});

test("engramCardsDigest changes only when painted data changes", () => {
	const base = engramCardsDigest(enrolled);
	assert.equal(engramCardsDigest({ ...enrolled }), base);
	assert.notEqual(engramCardsDigest({ ...enrolled, observations: 184 }), base);
	assert.notEqual(engramCardsDigest({ ...enrolled, today: 3 }), base);
	assert.notEqual(engramCardsDigest({ ...enrolled, daemonAvailable: false }), base);
	assert.notEqual(engramCardsDigest({ ...enrolled, cloud: { ...enrolled.cloud!, sync: "pending" } }), base);
});
