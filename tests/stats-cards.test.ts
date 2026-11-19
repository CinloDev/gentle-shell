import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildStatsCards, type StatsCardId, type StatsCardsSnapshot } from "../lib/stats-cards.ts";
import { describeEcosystemVersions } from "../lib/ecosystem-versions.ts";
import { collectSessionStats, renderStatsRows, type SessionStats } from "../lib/shell-stats.ts";

const theme = { fg: (_role: string, text: string) => text };
const plain = (rows: string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));

const session: SessionStats = {
	cost: 1.5, input: 12_000, output: 3_000, cacheRead: 40_000, cacheWrite: 8_000,
	turns: 6, toolCalls: 9, toolErrors: 1, spanMs: 3_600_000, cacheHitRate: 0.66,
	models: [{ model: "sonnet", turns: 6, tokens: 63_000, cost: 1.5 }],
	tools: [{ name: "bash", calls: 5, errors: 0 }, { name: "read", calls: 3, errors: 0 }, { name: "rare", calls: 1, errors: 1 }],
};
const ecosystem = describeEcosystemVersions({ packageVersion: "4.7.0", piVersion: "1.0.0" });
const full: StatsCardsSnapshot = { session: { stats: session }, ecosystem };

test("SESSION preserves shared collector rows and session, model and subagent cost suffixes in both subscription states", () => {
	const stats = {
		...collectSessionStats([
			{ type: "message", message: { role: "assistant", model: "provider/sonnet", usage: { input: 100, output: 200, cacheRead: 600, cacheWrite: 300, cost: { total: 1.5 } } } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
		]),
		subagents: { runs: 2, tokens: 3000, cost: 0.25 },
	};
	for (const subscription of [false, true]) {
		const frame = buildStatsCards({ session: { stats, subscription } }, theme, 80);
		const group = frame.groups[0];
		const rows = frame.rows.slice(group.start + 1, group.end);
		assert.deepEqual(rows, renderStatsRows(stats, theme, 80, subscription, { includeTools: false }));
		for (const label of ["spent", "sonnet", "agents"]) {
			const row = rows.find(row => row.includes(label));
			assert.ok(row, label);
			assert.equal(row.includes(" sub"), subscription, `${label} uses MAIN cost suffix`);
		}
		assert.match(rows.join("\n"), /cache\s+60% hit · 600 read/);
		assert.doesNotMatch(rows.join("\n"), /tools|calls|failed/);
	}
});

test("STAT contains only session, tools and ecosystem for populated and empty snapshots", () => {
	for (const snapshot of [full, {}]) {
		const frame = buildStatsCards(snapshot, theme, 50);
		assert.deepEqual(frame.headers.map(header => header.id), ["session", "tools", "ecosystem"]);
		assert.equal(frame.groups.length, 3);
		assert.doesNotMatch(plain(frame.rows).join("\n"), /HISTORY|Scanning history/);
	}
});

test("STAT frames align headers and groups for every collapse combination, density and width", () => {
	const ids: StatsCardId[] = ["session", "tools", "ecosystem"];
	// A 16-column rail truncates the title and keeps the right column, by design;
	// the exact headings are asserted at rail width in the card tests below.
	const titles: Record<StatsCardId, RegExp> = { session: /▾ SESS/, tools: /▾/, ecosystem: /▾ ECOS/ };
	for (const snapshot of [full, {}]) for (const density of ["comfortable", "compact", "minimal"] as const) for (const width of [12, 16, 30, 50]) for (let mask = 0; mask < (1 << ids.length); mask++) {
		const collapsed = new Set(ids.filter((_id, index) => mask & (1 << index)));
		const frame = buildStatsCards(snapshot, theme, width, density, { collapsed });
		if (width < 16) { assert.deepEqual(frame, { rows: [], groups: [], headers: [] }); continue; }
		assert.deepEqual(frame.headers.map(header => header.id), ids);
		frame.groups.forEach((group, index) => {
			assert.equal(frame.headers[index].row, group.start);
			const painted = plain([frame.rows[group.start]])[0]!;
			assert.match(painted, collapsed.has(ids[index]) ? /▸/ : titles[ids[index]]);
			assert.equal(group.end - group.start === 1, collapsed.has(ids[index]));
			if (index) assert.equal(group.start - frame.groups[index - 1].end, density === "comfortable" ? 1 : 0);
		});
		assert.equal(frame.groups.at(-1)!.end, frame.rows.length);
		assert.ok(frame.rows.every(row => visibleWidth(row) <= Math.max(width, 16)), `row fits ${width}`);
	}
});

test("STAT cards preserve session and tool facts without repeating them", () => {
	// Padding is not the fact under test: collapse it so labels, values and order are.
	const rows = plain(buildStatsCards(full, theme, 50, "compact").rows).map(row => row.trim().replace(/\s+/g, " "));
	const ecosystemStart = rows.findIndex(row => /▾ ECOSYSTEM/.test(row));
	const toolsStart = rows.findIndex(row => /▾ TOOLS/.test(row));
	const sessionCard = rows.slice(0, toolsStart);
	assert.match(sessionCard.join("\n"), /spent\s+\$1\.50/);
	assert.match(sessionCard.join("\n"), /tokens\s+in 12k · out 3\.0k/);
	assert.match(sessionCard.join("\n"), /cache\s+66% hit · 40k read/);
	assert.doesNotMatch(sessionCard.join("\n"), /tools|calls|failed/i);
	assert.deepEqual(rows.slice(toolsStart, ecosystemStart), ["▾ TOOLS 9 calls · 1 failed", "bash 5 calls", "read 3 calls", "rare 1 call · 1 failed"]);
	assert.match(sessionCard.join("\n"), /sonnet/);
});

test("TOOLS keeps important order, every failing identity, successful other sums and narrow failure signals", () => {
	const tools = [
		{ name: "zeta", calls: 2, errors: 1 }, { name: "read", calls: 3, errors: 0 },
		{ name: "alpha", calls: 4, errors: 2 }, { name: "edit", calls: 1, errors: 1 },
		{ name: "ok-a", calls: 2, errors: 0 }, { name: "write", calls: 1, errors: 0 },
		{ name: "bash", calls: 5, errors: 0 }, { name: "ok-b", calls: 3, errors: 0 },
		{ name: "unknown", calls: 1, errors: 1 }, { name: "provider/" + "long".repeat(20), calls: 1, errors: 1 },
	];
	const snapshot = { session: { stats: { ...session, tools, toolCalls: 23, toolErrors: 7 } } };
	const frame = buildStatsCards(snapshot, theme, 160, "compact");
	const group = frame.groups[1];
	assert.deepEqual(frame.rows.slice(group.start + 1, group.end).map(row => row.trim()), [
		"bash  5 calls", "write  1 call", "read  3 calls", "edit  1 call · 1 failed",
		"alpha  4 calls · 2 failed", `provider/${"long".repeat(20)}  1 call · 1 failed`, "unknown  1 call · 1 failed", "zeta  2 calls · 1 failed", "other  5 calls",
	]);
	for (const width of [16, 24, 30, 50]) {
		const narrow = buildStatsCards(snapshot, theme, width, "compact");
		const body = narrow.rows.slice(narrow.groups[1].start + 1, narrow.groups[1].end);
		assert.equal(body.filter(row => /\d failed/.test(row)).length, 5, `every failure marker survives at ${width}`);
		assert.ok(narrow.rows.every(row => visibleWidth(row) <= width));
		assert.match(body.join("\n"), /provider\//, "prefix survives bounded name truncation");
		const collapsed = buildStatsCards(snapshot, theme, width, "compact", { collapsed: new Set(["tools"]), hovered: "tools" });
		const header = collapsed.rows[collapsed.groups[1].start];
		assert.match(header, /7 failed|7!/, "collapsed failure summary survives");
		assert.match(header, /23/, "collapsed call total survives");
	}
});

test("STAT ecosystem rows report the detected version and its source, never an invented one", () => {
	const rows = plain(buildStatsCards(full, theme, 60).rows).map(row => row.trim().replace(/\s+/g, " "));
	assert.deepEqual(rows.slice(rows.findIndex(row => /▾ ECOSYSTEM/.test(row))), [
		"▾ ECOSYSTEM 2/2",
		"Pi 1.0.0 runtime",
		"Gentle Shell 4.7.0 package",
	]);
	for (const version of ["3.7.0", undefined]) {
		const enabled = { ...full, ecosystem: describeEcosystemVersions({ packageVersion: "4.7.0", piVersion: "1.0.0", engramEnabled: true, engramRunningVersion: version }) };
		const painted = plain(buildStatsCards(enabled, theme, 60).rows).map(row => row.trim().replace(/\s+/g, " "));
		assert.deepEqual(painted.slice(painted.findIndex(row => /▾ ECOSYSTEM/.test(row))), [
			`▾ ECOSYSTEM ${version ? "3" : "2"}/3`,
			"Pi 1.0.0 runtime",
			"Gentle Shell 4.7.0 package",
			version ? "Engram 3.7.0 running" : "Engram — unavailable",
		]);
	}
});

test("STAT loading states keep every card painted while the readers answer", () => {
	const rows = plain(buildStatsCards({}, theme, 50).rows);
	assert.match(rows.join("\n"), /▾ SESSION\s+No session yet/);
	assert.match(rows.join("\n"), /▾ TOOLS\s+No session yet/);
	assert.match(rows.join("\n"), /▾ ECOSYSTEM\s+Detecting versions…/);
	// A settled empty session and ecosystem are real answers, not loading states.
	const empty = plain(buildStatsCards({ session: { stats: { ...session, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: undefined, turns: 0, toolCalls: 0, toolErrors: 0, spanMs: 0, models: [], tools: [] } }, ecosystem: [] }, theme, 50).rows);
	assert.match(empty.join("\n"), /No tool calls yet/);
	assert.doesNotMatch(empty.join("\n"), /No session yet|Detecting versions|Scanning|cache/);
});

test("STAT long names and narrow rails clip inside the column budget", () => {
	const long = { model: "provider/" + "model-".repeat(12), turns: 2, tokens: 10, cost: 0.1 };
	const snapshot: StatsCardsSnapshot = {
		session: { stats: { ...session, models: [long] } },
		ecosystem: describeEcosystemVersions({ packageVersion: "4.7.0", piVersion: "1".repeat(80) }),
	};
	for (const width of [16, 24, 50]) for (const row of buildStatsCards(snapshot, theme, width, "compact").rows) assert.ok(visibleWidth(row) <= Math.max(width, 16), `${width}: ${row}`);
});
