import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Cross-extension click-through: the PROFILE rail's cards ask the models/profiles
 * owner to open the existing /gentle:profiles modal with the same preselection
 * the bare command uses. Display-only request; the modal stays the only mutation
 * actor. An optional `role` focuses that routing row (PROFILE_ORCHESTRATOR_KEY
 * for the orchestrator card, an agent name from the rail's routing rows); the
 * receiver honors it only when its own open-time state names that row.
 */
export const PROFILES_OPEN_EVENT = "gentle-ai:profiles-open";

/** Optional focus request; an absent role keeps the command's default preselection. */
export type ProfilesOpenRequest = { role?: string };

/** Validates a request payload defensively: display-only entry, no stranger shape trusted. */
export function parseProfilesOpenRequest(payload: unknown): ProfilesOpenRequest {
	const value = (payload ?? {}) as { role?: unknown };
	return typeof value.role === "string" && value.role.trim() !== "" ? { role: value.role.trim() } : {};
}

/**
 * Subscribes to open requests on the extension that owns the profiles panel.
 * Returns the unsubscribe function; handlers receive the validated request.
 */
export function onProfilesOpenRequest(pi: ExtensionAPI, open: (request: ProfilesOpenRequest) => void): () => void {
	// Optional chaining matches the other cross-extension subscribers: some
	// harnesses build a bare ExtensionAPI without an events bus, and a display
	// entry point must never be the thing that breaks their construction.
	return pi.events?.on?.(PROFILES_OPEN_EVENT, (payload: unknown) => open(parseProfilesOpenRequest(payload))) ?? (() => {});
}

/** Fires the open request from any surface; fire-and-forget for the sender. */
export function requestProfilesOpen(pi: ExtensionAPI, request: ProfilesOpenRequest = {}): void {
	try { pi.events?.emit?.(PROFILES_OPEN_EVENT, request); } catch { /* Display-only entry point. */ }
}
