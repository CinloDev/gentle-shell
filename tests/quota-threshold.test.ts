import assert from "node:assert/strict";
import test from "node:test";
import { collectQuotaWarnings, DEFAULT_QUOTA_THRESHOLD_PERCENT, type QuotaThresholdState } from "../lib/quota-threshold.ts";
import { parseCodexUsage } from "../lib/shell-usage.ts";

const NOW = 1_788_600_000_000;

const codex = (primary: number) => parseCodexUsage({ plan_type: "Plus", rate_limit: { primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_at: (NOW + 3600_000) / 1000 } } }, NOW);

test("a window crossing the threshold warns once with a human-ready message", () => {
	const state: QuotaThresholdState = { warned: new Map() };
	const first = collectQuotaWarnings(state, codex(96), NOW);
	assert.equal(first.length, 1);
	assert.equal(first[0].provider, "openai-codex");
	assert.equal(first[0].usedPercent, 96);
	assert.match(first[0].message, /openai-codex codex 5h is at 96%/);
	assert.match(first[0].message, /resets in 1h 0m/);
	const again = collectQuotaWarnings(state, codex(97), NOW);
	assert.deepEqual(again, [], "same cycle never re-warns, even as it climbs");
});

test("a window that recovers below the threshold warns again when it crosses later", () => {
	const state: QuotaThresholdState = { warned: new Map() };
	collectQuotaWarnings(state, codex(96), NOW);
	collectQuotaWarnings(state, codex(40), NOW);
	const crossed = collectQuotaWarnings(state, codex(98), NOW);
	assert.equal(crossed.length, 1, "below-threshold clears the warning; a new crossing warns");
});

test("a window below the threshold never warns", () => {
	const state: QuotaThresholdState = { warned: new Map() };
	assert.deepEqual(collectQuotaWarnings(state, codex(94), NOW), []);
	assert.deepEqual(collectQuotaWarnings(state, codex(0), NOW), []);
});

test("nonfinite percentages never warn and never enter the state", () => {
	const state: QuotaThresholdState = { warned: new Map() };
	const reading = { provider: "nan", plan: undefined, fetchedAt: NOW, limits: [
		{ name: "glm5", limitReached: false, windows: [{ label: "", usedPercent: NaN, windowSeconds: null, resetAt: null }] },
	] };
	assert.deepEqual(collectQuotaWarnings(state, reading, NOW), []);
	assert.equal(state.warned.size, 0);
});

test("the threshold is customizable and the default is 95", () => {
	assert.equal(DEFAULT_QUOTA_THRESHOLD_PERCENT, 95);
	const state: QuotaThresholdState = { warned: new Map() };
	assert.deepEqual(collectQuotaWarnings(state, codex(90), NOW), [], "below the default");
	assert.equal(collectQuotaWarnings(state, codex(90), NOW, 90).length, 1, "custom threshold");
});
