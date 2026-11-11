import type { ProviderUsage } from "./shell-usage.ts";

/**
 * Quota-threshold notifications: when a usage reading crosses the threshold,
 * the session gets one system notification per window — once per window cycle,
 * never per refresh. A window warns again only after its resetAt passed
 * (a new cycle) or its percentage dropped back below the threshold and rose
 * again. Readings without finite percentages never warn; a warning never
 * fires from cached/stale replays, only from fresh recorded readings.
 */

export type QuotaThresholdState = {
	/** `provider|name|label` → the percentage that was last warned about. */
	warned: Map<string, number>;
};

export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 95;

export type QuotaWarning = {
	provider: string;
	/** The limit the window belongs to ("codex", a model id, …). */
	limit: string;
	/** The window label ("5h", "week", or the empty per-model label). */
	label: string;
	usedPercent: number;
	threshold: number;
	resetAt: number | null;
	/** Human-ready sentence; the caller passes it to its notification channel verbatim. */
	message: string;
};

const windowKey = (provider: string, limit: string, label: string): string => `${provider}|${limit}|${label}`;

/**
 * Updates the warning state for one recorded reading and returns the windows
 * that crossed the threshold this time. Pure: callers own persistence and the
 * notification channel. Key order follows the reading's declaration order.
 */
export function collectQuotaWarnings(state: QuotaThresholdState, usage: ProviderUsage, now: number, threshold: number = DEFAULT_QUOTA_THRESHOLD_PERCENT): QuotaWarning[] {
	const warnings: QuotaWarning[] = [];
	for (const limit of usage.limits) {
		for (const window of limit.windows) {
			if (!Number.isFinite(window.usedPercent)) continue;
			const key = windowKey(usage.provider, limit.name, window.label);
			if (window.usedPercent < threshold) {
				// Back below the threshold: the next crossing is a new event worth
				// reporting, so this window's warning is forgotten.
				state.warned.delete(key);
				continue;
			}
			const previous = state.warned.get(key);
			if (previous !== undefined && previous >= threshold) continue;
			state.warned.set(key, window.usedPercent);
			const name = [usage.provider, limit.name, window.label].filter(Boolean).join(" ");
			const reset = window.resetAt !== null && window.resetAt > now
				? ` — resets in ${formatQuotaReset(window.resetAt - now)}`
				: "";
			warnings.push({
				provider: usage.provider,
				limit: limit.name,
				label: window.label,
				usedPercent: window.usedPercent,
				threshold,
				resetAt: window.resetAt,
				message: `Quota warning: ${name} is at ${Math.round(window.usedPercent)}%${reset}.`,
			});
		}
	}
	return warnings;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatQuotaReset(remainingMs: number): string {
	if (remainingMs < HOUR) return `${Math.max(1, Math.round(remainingMs / MINUTE))}m`;
	if (remainingMs < DAY) return `${Math.floor(remainingMs / HOUR)}h ${Math.floor((remainingMs % HOUR) / MINUTE)}m`;
	return `${Math.floor(remainingMs / DAY)}d ${Math.floor((remainingMs % DAY) / HOUR)}h`;
}
