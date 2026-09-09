import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveGentlePiAgentHome } from "./agent-home.ts";
import {
	BUILTIN_PROFILES,
	type ModelProfileEntry,
	type Profile,
	type ProfileScope,
	type ProfileSummary,
	type ReasoningEffort,
	type SubagentsConfigFile,
} from "./sdd-profiles-catalog.ts";

/**
 * Pure function: applies profile models and defaults onto a SubagentsConfigFile object,
 * preserving all custom or existing properties (timeouts, shortcuts, tools, etc.).
 */
export function applyProfileToConfig(
	currentConfig: SubagentsConfigFile,
	profile: Profile,
): SubagentsConfigFile {
	const nextConfig: SubagentsConfigFile = { ...currentConfig };

	if (profile.default_model) {
		nextConfig.default_model = profile.default_model;
	}
	if (profile.default_effort) {
		nextConfig.default_effort = profile.default_effort;
	}

	nextConfig.active_profile = profile.name;
	nextConfig.model_profiles = { ...profile.model_profiles };

	return nextConfig;
}

/**
 * Pure function: extracts a Profile definition from a SubagentsConfigFile object.
 */
export function extractProfileFromConfig(
	config: SubagentsConfigFile,
	name: string,
	description?: string,
): Profile {
	const now = new Date().toISOString();
	const modelProfiles: Record<string, ModelProfileEntry> = {};

	if (config.model_profiles && typeof config.model_profiles === "object") {
		for (const [agent, val] of Object.entries(config.model_profiles)) {
			if (val && typeof val === "object" && typeof (val as { model?: unknown }).model === "string") {
				modelProfiles[agent] = {
					model: (val as { model: string }).model,
					effort: (val as { effort?: ReasoningEffort }).effort,
				};
			}
		}
	}

	return {
		name,
		description: description ?? `Guardado desde subagents.json a las ${now}`,
		default_model: typeof config.default_model === "string" ? config.default_model : undefined,
		default_effort: typeof config.default_effort === "string" ? (config.default_effort as ReasoningEffort) : undefined,
		model_profiles: modelProfiles,
		created_at: now,
		updated_at: now,
	};
}

/**
 * Atomically applies a profile to a subagents.json file on disk.
 * Uses a temp file + atomic rename to prevent partial writes.
 */
export function applyProfileToFile(
	filePath: string,
	profile: Profile,
): SubagentsConfigFile {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	let currentConfig: SubagentsConfigFile = {};
	if (fs.existsSync(filePath)) {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			currentConfig = JSON.parse(raw);
		} catch {
			currentConfig = {};
		}
	}

	const updatedConfig = applyProfileToConfig(currentConfig, profile);
	const formattedJson = JSON.stringify(updatedConfig, null, 2) + "\n";

	const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	fs.writeFileSync(tmpPath, formattedJson, "utf-8");
	fs.renameSync(tmpPath, filePath);

	return updatedConfig;
}

const COMMON_STANDARD_MODELS = [
	"anthropic/claude-sonnet-4-5",
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-opus-4-6",
	"openai/o3-mini",
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"google/gemini-2.5-flash",
	"google/gemini-2.5-pro",
];

/**
 * Discovers available models from Pi runtime context, models.json, and models-store.json.
 */
export async function resolveAvailableModels(ctx?: unknown): Promise<string[]> {
	const modelSet = new Set<string>();

	try {
		const registry = (ctx as { modelRegistry?: { getAvailable?: () => Promise<unknown[]> } })?.modelRegistry;
		const registryModels = await registry?.getAvailable?.();
		if (Array.isArray(registryModels)) {
			for (const m of registryModels) {
				const item = m as { provider?: string; providerId?: string; id?: string; model?: string };
				const provider = item.provider ?? item.providerId;
				const id = item.id ?? item.model;
				if (provider && id) {
					modelSet.add(`${provider}/${id}`);
				}
			}
		}
	} catch {}

	const home = os.homedir();

	const modelsJsonPath = path.join(home, ".pi", "agent", "models.json");
	if (fs.existsSync(modelsJsonPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as {
				providers?: Record<string, { models?: Array<{ id?: string }> }>;
			};
			if (data?.providers && typeof data.providers === "object") {
				for (const [provider, pData] of Object.entries(data.providers)) {
					if (Array.isArray(pData?.models)) {
						for (const m of pData.models) {
							if (m?.id) {
								modelSet.add(`${provider}/${m.id}`);
							}
						}
					}
				}
			}
		} catch {}
	}

	const storeJsonPath = path.join(home, ".pi", "agent", "models-store.json");
	if (fs.existsSync(storeJsonPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(storeJsonPath, "utf-8")) as Record<
				string,
				{ models?: Array<{ id?: string }> }
			>;
			if (typeof data === "object" && data !== null) {
				for (const [provider, pData] of Object.entries(data)) {
					if (Array.isArray(pData?.models)) {
						for (const m of pData.models) {
							if (m?.id) {
								modelSet.add(`${provider}/${m.id}`);
							}
						}
					}
				}
			}
		} catch {}
	}

	for (const std of COMMON_STANDARD_MODELS) {
		modelSet.add(std);
	}

	return Array.from(modelSet).sort((a, b) => a.localeCompare(b));
}

export interface ManagerOptions {
	globalDir?: string;
	projectDir?: string;
	builtinsDir?: string;
	activeStatePath?: string;
	globalSubagentsPath?: string;
	projectSubagentsPath?: string;
}

export function sanitizeProfileName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export class SddProfileManager {
	readonly globalDir: string;
	readonly projectDir: string;
	readonly builtinsDir?: string;
	readonly activeStatePath: string;
	readonly globalSubagentsPath: string;
	readonly projectSubagentsPath: string;

	constructor(options: ManagerOptions = {}) {
		const agentHome = resolveGentlePiAgentHome();
		this.globalDir = options.globalDir ?? path.join(agentHome, "profiles");
		this.projectDir = options.projectDir ?? path.join(process.cwd(), ".pi", "profiles");
		this.builtinsDir = options.builtinsDir;
		this.activeStatePath = options.activeStatePath ?? path.join(this.globalDir, ".active");
		this.globalSubagentsPath =
			options.globalSubagentsPath ?? path.join(agentHome, "subagents.json");
		this.projectSubagentsPath =
			options.projectSubagentsPath ?? path.join(process.cwd(), ".pi", "subagents.json");
	}

	sanitizeName(name: string): string {
		return sanitizeProfileName(name);
	}

	private getDeletedProfilesPath(): string {
		return path.join(this.globalDir, ".deleted-profiles");
	}

	private getDeletedProfiles(): Set<string> {
		const filePath = this.getDeletedProfilesPath();
		if (!fs.existsSync(filePath)) return new Set();
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const lines = raw.split("\n").map((s) => this.sanitizeName(s)).filter(Boolean);
			return new Set(lines);
		} catch {
			return new Set();
		}
	}

	private addDeletedProfile(name: string): void {
		const set = this.getDeletedProfiles();
		set.add(this.sanitizeName(name));
		try {
			if (!fs.existsSync(this.globalDir)) {
				fs.mkdirSync(this.globalDir, { recursive: true });
			}
			fs.writeFileSync(this.getDeletedProfilesPath(), Array.from(set).join("\n"), "utf-8");
		} catch {}
	}

	private removeDeletedProfile(name: string): void {
		const set = this.getDeletedProfiles();
		const key = this.sanitizeName(name);
		if (set.has(key)) {
			set.delete(key);
			try {
				fs.writeFileSync(this.getDeletedProfilesPath(), Array.from(set).join("\n"), "utf-8");
			} catch {}
		}
	}

	private readProfilesFromDir(
		dir: string,
		scope: ProfileScope,
	): Map<string, { profile: Profile; path: string }> {
		const map = new Map<string, { profile: Profile; path: string }>();
		if (!fs.existsSync(dir)) return map;

		const deletedBuiltins = scope === "builtin" ? this.getDeletedProfiles() : new Set<string>();

		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.endsWith(".json") || file.startsWith(".")) continue;
				const filePath = path.join(dir, file);
				try {
					const raw = fs.readFileSync(filePath, "utf-8");
					const data = JSON.parse(raw) as Profile;
					if (data && typeof data === "object" && data.name) {
						const normalizedKey = this.sanitizeName(data.name);
						if (deletedBuiltins.has(normalizedKey)) continue;
						map.set(normalizedKey, { profile: data, path: filePath });
					}
				} catch {}
			}
		} catch {}

		return map;
	}

	listProfiles(): ProfileSummary[] {
		const deletedBuiltins = this.getDeletedProfiles();
		const merged = new Map<string, { profile: Profile; scope: ProfileScope; path?: string }>();

		// 1. In-memory built-in presets
		for (const [key, profile] of Object.entries(BUILTIN_PROFILES)) {
			const normalizedKey = this.sanitizeName(key);
			if (!deletedBuiltins.has(normalizedKey)) {
				merged.set(normalizedKey, { profile, scope: "builtin" });
			}
		}

		// 2. Builtins directory if provided
		if (this.builtinsDir) {
			const fromBuiltinsDir = this.readProfilesFromDir(this.builtinsDir, "builtin");
			for (const [key, val] of fromBuiltinsDir) {
				merged.set(key, { profile: val.profile, scope: "builtin", path: val.path });
			}
		}

		// 3. Global directory
		const globals = this.readProfilesFromDir(this.globalDir, "global");
		for (const [key, val] of globals) {
			merged.set(key, { profile: val.profile, scope: "global", path: val.path });
		}

		// 4. Project directory
		const projects = this.readProfilesFromDir(this.projectDir, "project");
		for (const [key, val] of projects) {
			merged.set(key, { profile: val.profile, scope: "project", path: val.path });
		}

		const activeName = this.getActiveProfileName();
		const summaries: ProfileSummary[] = [];
		for (const [, item] of merged) {
			const { profile, scope, path: filePath } = item;
			const count = Object.keys(profile.model_profiles || {}).length;
			summaries.push({
				name: profile.name,
				description: profile.description,
				default_model: profile.default_model,
				agent_count: count,
				scope,
				is_active: Boolean(activeName && this.sanitizeName(profile.name) === this.sanitizeName(activeName)),
				path: filePath,
			});
		}

		return summaries.sort((a, b) => a.name.localeCompare(b.name));
	}

	loadProfile(name: string): Profile | null {
		const key = this.sanitizeName(name);

		// 1. Project
		const projectPath = path.join(this.projectDir, `${key}.json`);
		if (fs.existsSync(projectPath)) {
			try {
				return JSON.parse(fs.readFileSync(projectPath, "utf-8")) as Profile;
			} catch {}
		}

		// 2. Global
		const globalPath = path.join(this.globalDir, `${key}.json`);
		if (fs.existsSync(globalPath)) {
			try {
				return JSON.parse(fs.readFileSync(globalPath, "utf-8")) as Profile;
			} catch {}
		}

		// 3. Builtin directory if provided
		if (!this.getDeletedProfiles().has(key)) {
			if (this.builtinsDir) {
				const builtinPath = path.join(this.builtinsDir, `${key}.json`);
				if (fs.existsSync(builtinPath)) {
					try {
						return JSON.parse(fs.readFileSync(builtinPath, "utf-8")) as Profile;
					} catch {}
				}
			}

			// 4. Builtin embedded catalog
			const builtin = BUILTIN_PROFILES[name] ?? BUILTIN_PROFILES[key];
			if (builtin) return { ...builtin };
		}

		return null;
	}

	saveProfile(profile: Profile, scope: "global" | "project" = "global"): string {
		const targetDir = scope === "project" ? this.projectDir : this.globalDir;
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		const key = this.sanitizeName(profile.name);
		this.removeDeletedProfile(key);
		const targetPath = path.join(targetDir, `${key}.json`);

		const payload: Profile = {
			...profile,
			name: profile.name.trim(),
			updated_at: new Date().toISOString(),
		};
		if (!payload.created_at) {
			payload.created_at = payload.updated_at;
		}

		const formatted = JSON.stringify(payload, null, 2) + "\n";
		const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		fs.writeFileSync(tmpPath, formatted, "utf-8");
		fs.renameSync(tmpPath, targetPath);

		return targetPath;
	}

	getActiveProfileName(): string | null {
		// First check project subagents.json
		if (fs.existsSync(this.projectSubagentsPath)) {
			try {
				const config = JSON.parse(fs.readFileSync(this.projectSubagentsPath, "utf-8")) as SubagentsConfigFile;
				if (typeof config.active_profile === "string" && config.active_profile.trim()) {
					return config.active_profile.trim();
				}
			} catch {}
		}

		// Second check activeStatePath
		if (fs.existsSync(this.activeStatePath)) {
			try {
				const content = fs.readFileSync(this.activeStatePath, "utf-8").trim();
				if (content) return content;
			} catch {}
		}

		// Third check global subagents.json
		if (fs.existsSync(this.globalSubagentsPath)) {
			try {
				const config = JSON.parse(fs.readFileSync(this.globalSubagentsPath, "utf-8")) as SubagentsConfigFile;
				if (typeof config.active_profile === "string" && config.active_profile.trim()) {
					return config.active_profile.trim();
				}
			} catch {}
		}

		return null;
	}

	setActiveProfileName(name: string): void {
		try {
			const dir = path.dirname(this.activeStatePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.activeStatePath, name.trim(), "utf-8");
		} catch {}
	}

	clearActiveProfileName(): void {
		if (fs.existsSync(this.activeStatePath)) {
			try {
				fs.unlinkSync(this.activeStatePath);
			} catch {}
		}
		const cleanSubagents = (filePath: string) => {
			if (fs.existsSync(filePath)) {
				try {
					const config = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SubagentsConfigFile;
					if (config.active_profile) {
						delete config.active_profile;
						fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
					}
				} catch {}
			}
		};
		cleanSubagents(this.projectSubagentsPath);
		cleanSubagents(this.globalSubagentsPath);
	}

	deleteProfile(name: string, force = false): boolean {
		const key = this.sanitizeName(name);
		const active = this.getActiveProfileName();
		if (!force && active && this.sanitizeName(active) === key) {
			return false;
		}

		let deleted = false;

		const projectPath = path.join(this.projectDir, `${key}.json`);
		if (fs.existsSync(projectPath)) {
			try {
				fs.unlinkSync(projectPath);
				deleted = true;
			} catch {}
		}

		const globalPath = path.join(this.globalDir, `${key}.json`);
		if (fs.existsSync(globalPath)) {
			try {
				fs.unlinkSync(globalPath);
				deleted = true;
			} catch {}
		}

		if (BUILTIN_PROFILES[name] || BUILTIN_PROFILES[key] || (this.builtinsDir && fs.existsSync(path.join(this.builtinsDir, `${key}.json`)))) {
			if (!this.getDeletedProfiles().has(key)) {
				this.addDeletedProfile(key);
				deleted = true;
			}
		}

		if (deleted) {
			const active = this.getActiveProfileName();
			if (active && this.sanitizeName(active) === key) {
				this.clearActiveProfileName();
			}
		}

		return deleted;
	}

	renameProfile(
		oldName: string,
		newName: string,
	): { success: boolean; message: string; targetPath?: string } {
		const trimmedNew = newName.trim();
		if (!trimmedNew) {
			return { success: false, message: "El nuevo nombre no puede estar vacío." };
		}

		const oldKey = this.sanitizeName(oldName);
		const newKey = this.sanitizeName(trimmedNew);

		if (oldKey === newKey) {
			return { success: false, message: "El nuevo nombre debe ser diferente al actual." };
		}

		const original = this.loadProfile(oldName);
		if (!original) {
			return {
				success: false,
				message: `Perfil "${oldName}" no encontrado.`,
			};
		}

		if (this.loadProfile(trimmedNew)) {
			return {
				success: false,
				message: `Ya existe un perfil con el nombre "${trimmedNew}".`,
			};
		}

		const projectPath = path.join(this.projectDir, `${oldKey}.json`);
		const targetScope: "project" | "global" = fs.existsSync(projectPath) ? "project" : "global";

		const updatedProfile: Profile = {
			...original,
			name: trimmedNew,
			updated_at: new Date().toISOString(),
		};

		const savedPath = this.saveProfile(updatedProfile, targetScope);

		const active = this.getActiveProfileName();
		const wasActive = Boolean(active && this.sanitizeName(active) === oldKey);

		this.deleteProfile(oldName, true);

		// Update subagents.json if active_profile matches oldKey
		const updateSubagents = (filePath: string) => {
			if (fs.existsSync(filePath)) {
				try {
					const config = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SubagentsConfigFile;
					if (config.active_profile && this.sanitizeName(config.active_profile) === oldKey) {
						config.active_profile = trimmedNew;
						fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
					}
				} catch {}
			}
		};
		updateSubagents(this.projectSubagentsPath);
		updateSubagents(this.globalSubagentsPath);

		if (wasActive) {
			this.setActiveProfileName(trimmedNew);
		}

		return {
			success: true,
			message: `Perfil "${oldName}" renombrado exitosamente a "${trimmedNew}".`,
			targetPath: savedPath,
		};
	}

	activateProfile(
		name: string,
		target: "global" | "project" = "global",
	): { success: boolean; profile?: Profile; message: string } {
		const profile = this.loadProfile(name);
		if (!profile) {
			return {
				success: false,
				message: `Perfil "${name}" no encontrado.`,
			};
		}

		const targetPath =
			target === "project" ? this.projectSubagentsPath : this.globalSubagentsPath;

		applyProfileToFile(targetPath, profile);
		this.setActiveProfileName(profile.name);

		return {
			success: true,
			profile,
			message: `Perfil "${profile.name}" activado correctamente en ${target} subagents.json.`,
		};
	}

	saveCurrentAsProfile(
		name: string,
		description?: string,
		scope: "global" | "project" = "global",
	): { success: boolean; path?: string; profile?: Profile; message: string } {
		let sourcePath = this.globalSubagentsPath;
		if (scope === "project" && fs.existsSync(this.projectSubagentsPath)) {
			sourcePath = this.projectSubagentsPath;
		} else if (fs.existsSync(this.projectSubagentsPath)) {
			sourcePath = this.projectSubagentsPath;
		}

		let config: SubagentsConfigFile = {};
		if (fs.existsSync(sourcePath)) {
			try {
				config = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
			} catch {
				config = {};
			}
		}

		const profile = extractProfileFromConfig(config, name, description);
		const savedPath = this.saveProfile(profile, scope);
		this.setActiveProfileName(profile.name);

		return {
			success: true,
			path: savedPath,
			profile,
			message: `Perfil "${profile.name}" guardado exitosamente en ${savedPath}.`,
		};
	}

	createProfile(params: {
		name: string;
		description?: string;
		default_model?: string;
		default_effort?: ReasoningEffort;
		model_profiles?: Record<string, ModelProfileEntry>;
		scope?: "global" | "project";
	}): { success: boolean; path?: string; profile?: Profile; message: string } {
		const trimmed = params.name.trim();
		if (!trimmed) {
			return { success: false, message: "El nombre del perfil no puede estar vacío." };
		}

		const scope = params.scope ?? "global";
		const newProfile: Profile = {
			name: trimmed,
			description: params.description?.trim() || undefined,
			default_model: params.default_model?.trim() || undefined,
			default_effort: params.default_effort,
			model_profiles: params.model_profiles ?? {},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const savedPath = this.saveProfile(newProfile, scope);
		return {
			success: true,
			path: savedPath,
			profile: newProfile,
			message: `Perfil "${newProfile.name}" creado correctamente en ${scope} (${savedPath}).`,
		};
	}

	setAgentInProfile(params: {
		profileName: string;
		agentName: string;
		model: string;
		effort?: ReasoningEffort;
		scope?: "global" | "project";
	}): { success: boolean; profile?: Profile; message: string } {
		const profile = this.loadProfile(params.profileName);
		if (!profile) {
			return { success: false, message: `Perfil "${params.profileName}" no encontrado.` };
		}

		const updatedProfiles = { ...profile.model_profiles };
		updatedProfiles[params.agentName.trim()] = {
			model: params.model.trim(),
			effort: params.effort,
		};

		const updatedProfile: Profile = {
			...profile,
			model_profiles: updatedProfiles,
			updated_at: new Date().toISOString(),
		};

		const savedPath = this.saveProfile(updatedProfile, params.scope ?? "global");
		return {
			success: true,
			profile: updatedProfile,
			message: `Agente "${params.agentName}" asignado a "${params.model}" en el perfil "${profile.name}".`,
		};
	}
}
