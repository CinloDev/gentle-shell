import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import { paintGauge } from "../lib/shell-gauge.ts";
import { parseCodexUsage, parseNanQuota } from "../lib/shell-usage.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { buildProfileCards, profileCardGroups, renderProfileCards, type ProfileCardId, type ProfileCardsSnapshot } from "../lib/profile-cards.ts";

const theme = { fg: (_role: string, text: string) => text };
const plain = (rows: string[]) => rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));

const full: ProfileCardsSnapshot = {
	quotas: [parseCodexUsage({ plan_type: "Plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }, 0)],
	profile: { label: "team (session)", tier: "standard" },
	model: { id: "claude-x/opus-9", provider: "anthropic", effort: "high", contextPercent: 42, costTotal: 0.25 },
	routing: [
		{ role: "explore", model: "gemini/flash" },
		{ role: "worker", model: "anthropic/sonnet" },
	],
};

test("profile card frames align headers and groups for every collapse combination and empty state", () => {
	const ids: ProfileCardId[] = ["profile", "model", "quotas", "routing"];
	for (const snapshot of [full, { routing: [] }]) for (const density of ["comfortable", "compact", "minimal"] as const) for (const width of [12, 16, 30, 60]) for (let mask = 0; mask < 16; mask++) {
		const collapsed = new Set(ids.filter((_id, index) => mask & (1 << index)));
		const frame = buildProfileCards(snapshot, theme, width, density, { collapsed });
		assert.deepEqual(renderProfileCards(snapshot, theme, width, density, { collapsed }), frame.rows);
		assert.deepEqual(profileCardGroups(snapshot, density, { collapsed }, width).groups, frame.groups);
		if (width < 16) { assert.deepEqual(frame, { rows: [], groups: [], headers: [], actions: [] }); continue; }
		assert.deepEqual(frame.headers.map(header => header.id), ids);
		frame.groups.forEach((group, index) => {
			assert.equal(frame.headers[index].row, group.start);
			assert.match(frame.rows[group.start], new RegExp(`${collapsed.has(ids[index]) ? "▸" : "▾"} ${ids[index].toUpperCase().slice(0, 4)}`));
			assert.equal(group.end - group.start === 1, collapsed.has(ids[index]));
			if (index) assert.equal(group.start - frame.groups[index - 1].end, density === "comfortable" ? 1 : 0);
		});
		assert.equal(frame.groups.at(-1)!.end, frame.rows.length);
		assert.deepEqual(buildProfileCards(snapshot, theme, width, density, { collapsed: new Set() }).rows, renderProfileCards(snapshot, theme, width, density));
	}
});

test("profile cards spend the full useful width on long identity and routing text", () => {
	const colored = { fg: (_role: string, text: string) => `\x1b[36m${text}\x1b[39m` };
	for (const paint of [theme, colored]) for (const width of [16, 20, 30, 60]) {
		const label = "配置-team-".repeat(12), id = "模型-model-".repeat(12);
		const snapshot: ProfileCardsSnapshot = { profile: { label }, model: { provider: "provider", id, costTotal: 0 }, routing: [{ role: "explore", model: id }, { role: "worker", model: "short" }] };
		const rows = renderProfileCards(snapshot, paint, width, "compact");
		const groups = profileCardGroups(snapshot, "compact", {}, width).groups;
		const fitted = (text: string) => `  ${text}${" ".repeat(width - 2 - visibleWidth(text))}`;
		assert.equal(rows[groups[0].start + 1], fitted(paint.fg("text", truncateToWidth(label, width - 2, "…"))));
		assert.equal(rows[groups[1].start + 1], fitted(paint.fg("text", truncateToWidth(`provider · ${id}`, width - 2, "…"))));
		const role = truncateToWidth("explore", Math.max(1, Math.floor((width - 6) / 2)), "…");
		// The marker column is reserved on every row (one gap + one marker char),
		// so the model budget shrinks by 2 and the row ends with the marker —
		// letter or space — in the same right-edge column.
		const model = truncateToWidth(id, width - 2 - visibleWidth(role) - 3 - 2, "…");
		const marker = " ";
		assert.equal(rows[groups[3].start + 1], fitted(`${paint.fg("text", role)}${paint.fg("muted", " → ")}${paint.fg("accent", model)}${marker}${marker}`));
		assert.ok(rows.every(row => visibleWidth(row) <= width));
		// Short route: model fits its budget, marker column is a reserved blank at
// width-2-1... the row is space-padded to width by the panel anyway.
if (width >= 20) assert.equal(plain([rows[groups[3].start + 2]])[0].trimEnd(), "  worker → short", "short route is unchanged");
	}
});

test("profile cards paint the active profile, model/context and routing rows", () => {
	const text = plain(renderProfileCards(full, theme as never, 60)).join("\n");
	assert.match(text, /PROFILE/);
	assert.match(text, /team \(session\)/);
	assert.match(text, /Standard/);
	assert.match(text, /MODEL/);
	assert.match(text, /anthropic .*opus-9/);
	assert.match(text, /high/i);
	assert.match(text, /42%/);
	assert.match(text, /\$0\.25/);
	assert.match(text, /ROUTING/);
	assert.match(text, /explore → gemini\/flash/);
	assert.match(text, /worker → anthropic\/sonnet/);
});

test("PROFILE quotas align responsive gauges and preserve percentages before reset suffixes", () => {
	const now = 1_788_600_000_000;
	for (const colored of [false, true]) for (const width of [16, 20, 30, 50, 70]) {
		const paint = colored ? { fg: (_role: string, text: string) => `\x1b[36m${text}\x1b[39m` } : theme;
		const snapshot: ProfileCardsSnapshot = { routing: [], now, quotas: [{ provider: "nan", plan: "Pro", fetchedAt: now - 60000, limits: [
			{ name: "模型-long", limitReached: false, windows: [{ label: "", usedPercent: 0, windowSeconds: null, resetAt: now + 3600000 }, { label: "week", usedPercent: 100, windowSeconds: null, resetAt: null }] },
			{ name: "bad", limitReached: false, windows: [{ label: "", usedPercent: NaN, windowSeconds: null, resetAt: null }, { label: "", usedPercent: Infinity, windowSeconds: null, resetAt: null }] },
		] }] };
		const frame = buildProfileCards(snapshot, paint, width, "compact");
		const body = frame.rows.slice(frame.groups[2].start + 1, frame.groups[2].end);
		const suffix = width >= 50 ? " · 1h 0m" : "";
		const room = width - 2;
		const names = ["模型-long", "模型-long week"];
		const desiredName = Math.min(Math.floor(room / 2), Math.max(...names.map(name => visibleWidth(name))));
		const fixed = 6;
		const resetWidth = width >= 50 ? " · 1h 0m".length : 0;
		let showReset = width >= 50;
		let cells = Math.min(16, room - desiredName - fixed - (showReset ? resetWidth : 0));
		if (cells < 4 && showReset) { showReset = false; cells = Math.min(16, room - desiredName - fixed); }
		if (cells < 2) cells = 2;
		const nameWidth = Math.max(1, Math.min(desiredName, room - cells - fixed - (showReset ? resetWidth : 0)));
		const fitted = (text: string) => `  ${text}${" ".repeat(width - 2 - visibleWidth(text))}`;
		assert.equal(body[0], fitted(paint.fg("text", truncateToWidth("nan · Pro · updated 1m ago", width - 2, "…"))));
		for (const [index, name, percent] of [[1, "模型-long", 0], [2, "模型-long week", 100]] as const) {
			const label = truncateToWidth(name, nameWidth, "…");
			const expected = `${paint.fg("muted", label + " ".repeat(nameWidth - visibleWidth(label)))} ${paintGauge(percent, paint, cells)} ${paint.fg("text", `${percent}%`.padStart(4))}${index === 1 && suffix ? paint.fg("muted", suffix) : ""}`;
			assert.equal(body[index], fitted(expected), `width ${width}, row ${index}`);
		}
		assert.equal(body.length, 3, "nonfinite windows have no rows");
		assert.ok(frame.rows.every(row => visibleWidth(row) <= width));
		const custom = buildProfileCards({ ...snapshot, gauge: { filled: "#", emptyGlyph: ".", ok: "accent" } }, paint, width, "compact");
		assert.match(plain(custom.rows).join("\n"), /\.{2,}|#{2,}/);
	}
});

test("PROFILE quotas render only providers and models the profile routing names", () => {
	const now = 1_788_600_000_000;
	const nan = { provider: "nan", plan: "Pro", fetchedAt: now, limits: [
		{ name: "deepseek-v4-flash", limitReached: false, windows: [{ label: "", usedPercent: 10, windowSeconds: null, resetAt: null }] },
		{ name: "glm5", limitReached: false, windows: [{ label: "", usedPercent: 20, windowSeconds: null, resetAt: null }] },
	] };
	const codex = { provider: "openai-codex", plan: "Plus", fetchedAt: now, limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 30, windowSeconds: null, resetAt: null }] }] };
	const referenced: ProfileCardsSnapshot = { routing: [{ role: "worker", model: "nan/glm5" }], quotas: [nan, codex], now };
	const text = plain(renderProfileCards(referenced, theme, 70)).join("\n");
	assert.match(text, /nan · Pro/);
	assert.match(text, /glm5\s+[▰▱]+\s+20%/);
	assert.doesNotMatch(text, /deepseek-v4-flash/);
	assert.doesNotMatch(text, /openai-codex/);
	const unmatched = plain(renderProfileCards({ routing: [{ role: "worker", model: "nan/absent-model" }], quotas: [nan], now }, theme, 70)).join("\n");
	assert.match(unmatched, /deepseek-v4-flash/);
	assert.match(unmatched, /glm5/);
	assert.doesNotMatch(plain(renderProfileCards({ routing: [{ role: "worker", model: "other-provider/m" }], quotas: [nan, codex], now }, theme, 70)).join("\n"), /deepseek-v4-flash[\s\S]*openai-codex/);
	const empty = plain(renderProfileCards({ routing: [], quotas: [nan, codex], now }, theme, 70)).join("\n");
	assert.match(empty, /openai-codex · Plus/);
	assert.match(empty, /nan · Pro/);
});


test("PROFILE routing rows append the effort letter in a distinct color at the right edge", () => {
	const now = 1_788_600_000_000;
	const snapshot: ProfileCardsSnapshot = {
		routing: [
			{ role: "worker", model: "nan/glm5", effort: "high" },
			{ role: "explore", model: "nan/qwen", effort: "off" },
			{ role: "plain", model: "nan/glm3" },
		],
		now,
	};
	const frame = buildProfileCards(snapshot, theme, 60);
	const routingGroup = frame.groups[frame.headers.findIndex(header => header.id === "routing")];
	const body = frame.rows.slice(routingGroup.start + 1, routingGroup.end);
	// Distinct color: the letter is painted with a different theme role than the
	// muted name/accent model inks, and right-aligned past the model text.
	// The role-distinguishing theme must wrap with invisible ANSI only: a theme
	// that adds visible prefix text would inflate the row width and trip the
	// outer clip, hiding the very marker this test checks.
	const themed = buildProfileCards(snapshot, { fg: (role, text) => `\u001b[9${role.length}m${text}\u001b[39m` }, 60);
	const themedBody = themed.rows.slice(themed.groups[3].start + 1, themed.groups[3].end);
	const tail = (row: string) => row.trimEnd();
	// The letter carries its own ANSI role (role.length 7 = "warning"),
	// distinct from the text/muted/accent inks on the same row.
	assert.match(themedBody[0], /\x1b\[97mh\x1b\[39m$/, "high gets its letter in a distinct role at the right edge");
	assert.match(themedBody[1], /\x1b\[97mo\x1b\[39m$/, "off gets o");
	assert.doesNotMatch(themedBody[2].trimEnd(), /\x1b\[97m[a-z]\x1b\[39m$/, "no effort defined, no letter");
	assert.equal(themedBody[2].endsWith(" "), true, "an undefined effort keeps the reserved blank marker");
	// The marker column is aligned across every row: with long models, every row
	// truncates to the same budget so the … column and the letter column (letter
	// or reserved space) sit at fixed positions — `… h` everywhere.
	const longModel = "cpamc/cilon-gpt/gpt-6.1-sol";
	const wide = buildProfileCards({ routing: [
		{ role: "review-reliability-reviewer", model: longModel, effort: "high" },
		{ role: "review-reliability-refuter", model: longModel + "-x", effort: "off" },
		{ role: "review-reliability-passive", model: longModel + "-x" },
	], now }, theme, 60);
	const wideLines = wide.rows.map(row => stripAnsi(row)).filter(line => line.includes(" → "));
	const dots = new Set(wideLines.map(line => line.indexOf("…")));
	assert.equal(dots.size, 1, "the … column is identical on every routing row");
	const markers = new Set(wideLines.map(line => line.length - 1));
	assert.equal(markers.size, 1, "the marker column is identical on every routing row");
	const workerLine = wideLines[0];
	assert.ok(workerLine && /…\sh$/.test(workerLine.trimEnd()), "a truncated model ends … one column before the letter");
	const passiveLine = wideLines[2];
	assert.ok(passiveLine && !/[a-z]$/.test(passiveLine.trimEnd()), "an undefined effort paints no letter");
	const plainLine = wideLines.find(line => line.includes("passive"));
	assert.ok(plainLine && !/[a-z]$/.test(plainLine.trimEnd()), "an undefined effort paints a blank marker");
});



test("PROFILE quota hint exposes a fetch action only while the hint row is rendered", () => {
	const now = 1_788_600_000_000;
	const empty = buildProfileCards({ routing: [] }, theme, 50);
	const hintRow = empty.rows.findIndex(row => plain([row])[0].includes("Run /gentle:usage to fetch"));
	assert.ok(hintRow > 0);
	assert.deepEqual(empty.actions, [{ id: "fetch-quotas", row: hintRow }]);
	const codex = { provider: "openai-codex", plan: "Plus", fetchedAt: now, limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 30, windowSeconds: null, resetAt: null }] }] };
	const populated = buildProfileCards({ routing: [], quotas: [codex], now }, theme, 50);
	assert.equal(populated.actions.length, 0);
	const collapsed = buildProfileCards({ routing: [] }, theme, 50, "compact", { collapsed: new Set(["quotas"]) });
	assert.equal(collapsed.actions.length, 0);
});
test("PROFILE quotas render normalized cached providers, caps and resets without nonfinite percentages", () => {
	const now = 1_788_600_000_000;
	const codex = parseCodexUsage({ plan_type: "Plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 80, limit_window_seconds: 604800 } } }, now);
	const nan = parseNanQuota({ models: [{ model: "glm5", fullCap: 1000, tokensUsed: 200, periodEnd: (now + 86400000) / 1000 }] }, now);
	const snapshot: ProfileCardsSnapshot = { routing: [], quotas: [codex, nan], now };
	const text = plain(renderProfileCards(snapshot, theme, 70)).join("\n");
	assert.match(text, /openai-codex · Plus/);
	assert.match(text, /codex 5h\s+[▰▱]+\s+25% · 1h 0m/);
	assert.match(text, /codex week\s+[▰▱]+\s+80%/);
	assert.match(text, /nan[\s\S]*glm5\s+[▰▱]+\s+20% · 1d 0h/);
	assert.doesNotMatch(text, /Run \/gentle:usage/);
	assert.match(plain(renderProfileCards({ ...snapshot, now: now + 172800000 }, theme, 70)).join("\n"), /25% · now/, "stale cache stays visible");
	codex.limits[0].windows[0].usedPercent = Number.NaN;
	codex.limits[0].windows[1].usedPercent = Number.POSITIVE_INFINITY;
	for (const width of [16, 20, 30, 70]) {
		const rows = renderProfileCards(snapshot, theme, width);
		assert.ok(rows.every(row => visibleWidth(row) <= width));
		assert.doesNotMatch(plain(rows).join("\n"), /NaN|Infinity/);
	}
});

test("profile cards paint honest empty states and never invent data", () => {
	const text = plain(renderProfileCards({ routing: [] }, theme as never, 60)).join("\n");
	assert.match(text, /No active profile/);
	assert.match(text, /No model\./);
	assert.match(text, /No routing rows/);
	assert.ok(plain(renderProfileCards({ routing: [] }, theme, 60)).some(row => row.trim() === "Run /gentle:usage to fetch"));
	assert.doesNotMatch(text, /\d+%/);
	assert.doesNotMatch(text, /→/);
});

test("profile card rows truncate to the rail width on every card", () => {
	const wide: ProfileCardsSnapshot = {
		profile: { label: "a-very-long-profile-name-that-keeps-going (session)" },
		model: { id: "an-extremely-long-model-identifier/with-path-segments", provider: "some-provider", contextPercent: 100, costTotal: 1234.5 },
		routing: [{ role: "an-absurdly-long-role-name-beyond-any-reasonable-width", model: "provider/of-a-very-long-model-name-indeed" }],
	};
	for (const width of [16, 20, 30]) {
		for (const row of plain(renderProfileCards(wide, theme as never, width))) {
			assert.ok(row.length <= width, `width ${width}: ${JSON.stringify(row)}`);
		}
	}
});

test("profile cards keep density gaps outside populated and empty card ranges", () => {
	for (const snapshot of [full, { routing: [] }]) for (const density of ["comfortable", "compact", "minimal"] as const) {
		const rows = plain(renderProfileCards(snapshot, theme, 30, density));
		const { groups } = profileCardGroups(snapshot, density)!;
		assert.equal(groups.length, 4);
		assert.equal(groups[0].start, 0);
		assert.equal(groups.at(-1)!.end, rows.length);
		groups.forEach((group, index) => {
			assert.match(rows[group.start], /PROFILE|MODEL|QUOTAS|ROUTING/);
			if (!index) return;
			const gap = rows.slice(groups[index - 1].end, group.start);
			assert.deepEqual(gap, density === "comfortable" ? [" ".repeat(30)] : []);
		});
	}
});

test("profile cards declare their card groups so a transparent rail frames each card", () => {
	const rows = plain(renderProfileCards(full, theme as never, 60));
	const groups = profileCardGroups(full);
	assert.ok(groups);
	assert.equal(groups.loose?.length ?? 0, 0);
	assert.ok(groups.groups.length >= 3, JSON.stringify(groups));
	for (const group of groups.groups) {
		assert.ok(group.start >= 0 && group.end <= rows.length, JSON.stringify(groups));
		assert.ok(/PROFILE|MODEL|QUOTAS|ROUTING/.test(rows[group.start]), rows[group.start]);
	}
});
