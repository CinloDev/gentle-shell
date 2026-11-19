import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// STAT reports the session base and, only when its integration is loaded,
// Engram's live core version. Installer targets are not installed versions.
export const ECOSYSTEM_SOURCE = {
	/** The active Pi host's public VERSION export. */
	RUNTIME: "runtime",
	/** This package's own package.json. */
	PACKAGE: "package",
	/** Reported by the daemon that is running now. */
	RUNNING: "running",
	/** No local source states a version. */
	UNAVAILABLE: "unavailable",
} as const;
export type EcosystemSource = (typeof ECOSYSTEM_SOURCE)[keyof typeof ECOSYSTEM_SOURCE];
export type EcosystemId = "pi" | "shell" | "engram";

export interface EcosystemVersionRow {
	id: EcosystemId;
	label: string;
	/** The detected version; absent when nothing trustworthy reports one. */
	version?: string;
	source: EcosystemSource;
}

export interface EcosystemDetection {
	/** This package's version (the Gentle Shell build). */
	packageVersion?: string;
	/** The active Pi host version, never adjacent installation metadata. */
	piVersion?: string;
	/** Live registry presence, independent of daemon health or MEM visibility. */
	engramEnabled?: boolean;
	/** The Engram core version the running daemon reports. */
	engramRunningVersion?: string;
}

/** Structural registry input keeps this pure predicate independent of the host SDK. */
interface IntegrationTool {
	name: string;
	sourceInfo?: { origin?: string; source?: string; path?: string };
}

/** Same package provenance criteria as the native memory binder; not an authorization decision. */
export function isEngramIntegrationEnabled(tools: readonly IntegrationTool[]): boolean {
	const matches = tools.filter(tool => tool.name === "mem_current_project");
	if (matches.length !== 1) return false;
	const source = matches[0].sourceInfo;
	return source?.origin === "package"
		&& typeof source.source === "string" && /^npm:gentle-engram(?:@[^\s/]+)?$/.test(source.source)
		&& typeof source.path === "string" && source.path.length > 0
		&& !source.path.startsWith("builtin:") && !source.path.startsWith("<");
}

const MAX_VERSION_LENGTH = 40;

/** A version string from untrusted metadata: escapes and controls removed, blanks dropped. */
function versionText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = sanitizeTerminalText(value).trim();
	return text.length > 0 && text.length <= MAX_VERSION_LENGTH ? text : undefined;
}

/** Reject unknown host identity, including Pi's synthetic metadata fallback. */
function activePiVersion(value: unknown): string | undefined {
	const text = versionText(value);
	if (text === undefined || text !== value || text === "0.0.0") return undefined;
	return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/.test(text) ? text : undefined;
}

/** Pi and Shell always appear; loaded Engram remains visible even during an outage. */
export function describeEcosystemVersions(detection: EcosystemDetection): EcosystemVersionRow[] {
	const row = (id: EcosystemId, label: string, version: string | undefined, source: EcosystemSource): EcosystemVersionRow =>
		version === undefined ? { id, label, source: ECOSYSTEM_SOURCE.UNAVAILABLE } : { id, label, version, source };
	return [
		row("pi", "Pi", activePiVersion(detection.piVersion), ECOSYSTEM_SOURCE.RUNTIME),
		row("shell", "Gentle Shell", versionText(detection.packageVersion), ECOSYSTEM_SOURCE.PACKAGE),
		...(detection.engramEnabled ? [row("engram", "Engram", versionText(detection.engramRunningVersion), ECOSYSTEM_SOURCE.RUNNING)] : []),
	];
}

/** The version an Engram daemon's /health payload states, when it states one. */
export function parseEngramHealthVersion(body: unknown): string | undefined {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
	const record = body as { version?: unknown; engram_version?: unknown };
	const text = versionText(record.version) ?? versionText(record.engram_version);
	return text === undefined ? undefined : text.replace(/^v(?=\d)/, "");
}

export interface EcosystemReaderDeps {
	/** The package root whose package.json is read. */
	packageRoot?: string;
	/** Read and parse a JSON file; undefined when it is missing or unreadable. */
	readJson?: (path: string) => unknown;
	/** Public VERSION supplied by the active host; absent or invalid stays unknown. */
	piVersion?: string;
	/** Presence from the live tool registry, not the daemon probe. */
	engramEnabled?: boolean;
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

const packageVersionOf = (value: unknown): string | undefined => (value !== null && typeof value === "object" ? versionText((value as { version?: unknown }).version) : undefined);

/** Read Shell metadata independently of the explicit active Pi identity. */
export function detectEcosystemVersions(deps: EcosystemReaderDeps = {}): EcosystemDetection {
	const root = deps.packageRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
	const readJson = deps.readJson ?? readJsonFile;
	const piVersion = activePiVersion(deps.piVersion);
	return {
		packageVersion: packageVersionOf(readJson(join(resolve(root), "package.json"))),
		piVersion,
		engramEnabled: deps.engramEnabled ?? false,
	};
}
