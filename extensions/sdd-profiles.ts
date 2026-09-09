import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import {
	type Profile,
	type ProfileSummary,
} from "../lib/sdd-profiles-catalog.ts";
import {
	resolveAvailableModels,
	SddProfileManager,
} from "../lib/sdd-profiles-manager.ts";
import { SddProfilesView } from "../lib/sdd-profiles-view.ts";

export const SDD_PROFILES_COMMAND = "sdd-profile";
export const SDD_PROFILES_SHORTCUT = "alt+m";

function getManager(ctx?: ExtensionContext): SddProfileManager {
	const cwd = ctx?.sessionManager?.getCwd?.() ?? (ctx as { cwd?: string })?.cwd ?? process.cwd();
	const globalDir = (ctx as { globalDir?: string })?.globalDir;
	return new SddProfileManager({
		globalDir,
		projectDir: `${cwd}/.pi/profiles`,
		projectSubagentsPath: `${cwd}/.pi/subagents.json`,
	});
}

function formatProfileList(profiles: ProfileSummary[], activeName: string | null): string {
	if (profiles.length === 0) {
		return "No hay perfiles configurados. Usa /sdd-profile create o /sdd-profile save para crear uno.";
	}

	const lines = ["Perfiles de Agentes SDD disponibles:\n"];
	for (const p of profiles) {
		const isActive = Boolean(activeName && p.name.toLowerCase() === activeName.toLowerCase());
		const marker = isActive ? "✓ [ACTIVO]" : " ";
		const defaultInfo = p.default_model ? `(default: ${p.default_model})` : `(${p.agent_count} agentes)`;
		const desc = p.description ? ` - ${p.description}` : "";
		lines.push(`  ${marker} ${p.name.padEnd(20)} [${p.scope.padEnd(7)}] ${defaultInfo}${desc}`);
	}
	return lines.join("\n");
}

function formatProfileDetail(profile: Profile, isActive: boolean): string {
	const lines = [
		`Perfil: ${profile.name}${isActive ? " (ACTIVO)" : ""}`,
		`Descripción: ${profile.description ?? "Sin descripción"}`,
		`Modelo default: ${profile.default_model ?? "No especificado"}`,
		`Esfuerzo default: ${profile.default_effort ?? "No especificado"}`,
		`Última actualización: ${profile.updated_at ?? "N/A"}`,
		"\nConfiguración por agente:",
	];

	const entries = Object.entries(profile.model_profiles || {});
	if (entries.length === 0) {
		lines.push("  (Sin asignaciones específicas, hereda default)");
	} else {
		for (const [agent, cfg] of entries) {
			const effort = cfg.effort ? ` [effort: ${cfg.effort}]` : "";
			lines.push(`  - ${agent.padEnd(22)}: ${cfg.model}${effort}`);
		}
	}

	return lines.join("\n");
}

export async function syncActiveProfileToRuntime(
	pi: ExtensionAPI,
	profile?: Profile | null,
	ctx?: ExtensionContext,
): Promise<void> {
	if (!profile) return;

	// 1. Update footer status
	if (ctx?.hasUI && typeof ctx.ui?.setStatus === "function") {
		ctx.ui.setStatus("sdd-profile", `❀ ${profile.name}`);
	}

	// 2. Switch main session model if default_model is defined
	if (profile.default_model && typeof (pi as { setModel?: (model: unknown) => Promise<void> }).setModel === "function") {
		const sep = profile.default_model.indexOf("/");
		if (sep !== -1) {
			const provider = profile.default_model.slice(0, sep).trim();
			const modelId = profile.default_model.slice(sep + 1).trim();

			const registry = (ctx as { modelRegistry?: { find?: (p: string, id: string) => unknown; getAvailable?: () => Promise<unknown[]> } })?.modelRegistry;
			let targetModel = registry?.find?.(provider, modelId);
			if (!targetModel && typeof registry?.getAvailable === "function") {
				try {
					const available = await registry.getAvailable();
					targetModel = available?.find?.((m: unknown) => {
						const item = m as { provider?: string; providerId?: string; id?: string; model?: string; name?: string };
						return (
							(item.provider === provider || item.providerId === provider) &&
							(item.id === modelId || item.model === modelId || item.name === modelId)
						);
					});
				} catch {}
			}

			if (targetModel) {
				try {
					await (pi as { setModel: (model: unknown) => Promise<void> }).setModel(targetModel);
				} catch (e) {
					console.warn(`[sdd-profiles] Could not switch session model to ${profile.default_model}:`, e);
				}
			}
		}
	}

	// 3. Switch thinking level
	if (profile.default_effort && typeof (pi as { setThinkingLevel?: (effort: string) => void }).setThinkingLevel === "function") {
		try {
			(pi as { setThinkingLevel: (effort: string) => void }).setThinkingLevel(profile.default_effort);
		} catch {}
	}
}

async function openProfilesModal(
	pi: ExtensionAPI,
	manager: SddProfileManager,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
		const profiles = manager.listProfiles();
		const active = manager.getActiveProfileName();
		ctx.ui?.notify?.(formatProfileList(profiles, active), "info");
		return;
	}

	const availableModels = await resolveAvailableModels(ctx);
	let view: SddProfilesView | undefined;

	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			const rows = Math.max(12, Math.floor((tui.terminal?.rows ?? 24) * 0.8));
			view = new SddProfilesView({
				manager,
				availableModels,
				theme,
				rows,
				onProfileActivated: async (p) => {
					await syncActiveProfileToRuntime(pi, p, ctx);
				},
				onClose: (res) => {
					if (res?.action === "activated") {
						ctx.ui.notify(`Perfil SDD activado: ${res.profileName}`, "info");
					}
					done(res);
				},
				requestRender: () => tui.requestRender(),
			});

			const interaction = createNativeFullscreenInteraction({
				keyboardTarget: view,
				requestRender: () => tui.requestRender(),
			});
			interaction.addChild(view);
			return interaction;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
			},
		},
	);

	view?.dispose();
}

export default function sddProfilesExtension(pi: ExtensionAPI): void {
	// Sync active profile on session_start
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		const manager = getManager(ctx);
		const active = manager.getActiveProfileName();
		if (active) {
			const profile = manager.loadProfile(active);
			if (profile) {
				await syncActiveProfileToRuntime(pi, profile, ctx);
			}
		}
	});

	// Main command: /sdd-profile
	pi.registerCommand(SDD_PROFILES_COMMAND, {
		description: "Gestionar perfiles de modelos para agentes SDD (abre modal interactivo o ejecuta subcomandos)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const trimmed = (args || "").trim();

			if (!trimmed || trimmed === "modal") {
				await openProfilesModal(pi, manager, ctx);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const sub = parts[0].toLowerCase();
			const targetName = parts[1];

			switch (sub) {
				case "list": {
					const profiles = manager.listProfiles();
					const active = manager.getActiveProfileName();
					return formatProfileList(profiles, active);
				}

				case "show": {
					if (!targetName) {
						ctx.ui?.notify?.("Uso: /sdd-profile show <nombre>", "warning");
						return "Uso: /sdd-profile show <nombre>";
					}
					const profile = manager.loadProfile(targetName);
					if (!profile) {
						const msg = `Perfil "${targetName}" no encontrado.`;
						ctx.ui?.notify?.(msg, "error");
						return msg;
					}
					const active = manager.getActiveProfileName();
					const isActive = Boolean(active && active.toLowerCase() === targetName.toLowerCase());
					return formatProfileDetail(profile, isActive);
				}

				case "apply": {
					if (!targetName) {
						ctx.ui?.notify?.("Uso: /sdd-profile apply <nombre> [--project]", "warning");
						return "Uso: /sdd-profile apply <nombre> [--project]";
					}
					const isProject = parts.includes("--project");
					const result = manager.activateProfile(targetName, isProject ? "project" : "global");
					if (result.success && result.profile) {
						await syncActiveProfileToRuntime(pi, result.profile, ctx);
					}
					ctx.ui?.notify?.(result.message, result.success ? "info" : "error");
					return result.message;
				}

				case "save": {
					if (!targetName) {
						ctx.ui?.notify?.("Uso: /sdd-profile save <nombre> [descripción] [--project]", "warning");
						return "Uso: /sdd-profile save <nombre> [descripción] [--project]";
					}
					const isProject = parts.includes("--project");
					const descWords = parts.slice(2).filter((w) => w !== "--project" && w !== "--global");
					const description = descWords.length > 0 ? descWords.join(" ") : undefined;

					const result = manager.saveCurrentAsProfile(
						targetName,
						description,
						isProject ? "project" : "global",
					);
					ctx.ui?.notify?.(result.message, result.success ? "info" : "error");
					return result.message;
				}

				case "create": {
					if (!targetName) {
						await openProfilesModal(pi, manager, ctx);
						return;
					}
					const defaultModel = parts[2];
					const effort = parts[3] as any;
					const isProject = parts.includes("--project");
					const result = manager.createProfile({
						name: targetName,
						default_model: defaultModel && defaultModel !== "--project" ? defaultModel : undefined,
						default_effort: effort && effort !== "--project" ? effort : undefined,
						scope: isProject ? "project" : "global",
					});
					ctx.ui?.notify?.(result.message, result.success ? "info" : "error");
					return result.message;
				}

				case "set": {
					const agentName = parts[2];
					const modelName = parts[3];
					const effort = parts[4] as any;
					if (!targetName || !agentName || !modelName) {
						const msg = "Uso: /sdd-profile set <perfil> <agente> <modelo> [effort]";
						ctx.ui?.notify?.(msg, "warning");
						return msg;
					}
					const result = manager.setAgentInProfile({
						profileName: targetName,
						agentName,
						model: modelName,
						effort,
					});
					ctx.ui?.notify?.(result.message, result.success ? "info" : "error");
					return result.message;
				}

				case "rename": {
					const newName = parts[2];
					if (!targetName || !newName) {
						const usage = "Uso: /sdd-profile rename <nombre-actual> <nuevo-nombre>";
						ctx.ui?.notify?.(usage, "warning");
						return usage;
					}
					const res = manager.renameProfile(targetName, newName);
					ctx.ui?.notify?.(res.message, res.success ? "info" : "warning");
					return res.message;
				}

				case "delete": {
					if (!targetName) {
						ctx.ui?.notify?.("Uso: /sdd-profile delete <nombre>", "warning");
						return "Uso: /sdd-profile delete <nombre>";
					}
					const profile = manager.loadProfile(targetName);
					if (!profile) {
						const msg = `Perfil "${targetName}" no encontrado.`;
						ctx.ui?.notify?.(msg, "warning");
						return msg;
					}
					const active = manager.getActiveProfileName();
					if (active && manager.sanitizeName(active) === manager.sanitizeName(targetName)) {
						const msg = `No se puede eliminar el perfil activo "${targetName}". Activa otro perfil antes de eliminar este.`;
						ctx.ui?.notify?.(msg, "warning");
						return msg;
					}
					const deleted = manager.deleteProfile(targetName);
					const msg = deleted
						? `Perfil "${targetName}" eliminado correctamente.`
						: `No se pudo eliminar el perfil "${targetName}".`;
					ctx.ui?.notify?.(msg, deleted ? "info" : "warning");
					return msg;
				}

				default: {
					const result = manager.activateProfile(sub);
					if (result.success && result.profile) {
						await syncActiveProfileToRuntime(pi, result.profile, ctx);
					}
					ctx.ui?.notify?.(result.message, result.success ? "info" : "error");
					return result.message;
				}
			}
		},
	});

	// Helper commands
	pi.registerCommand("sdd-profile-list", {
		description: "Listar perfiles de modelos SDD y subagentes",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const profiles = manager.listProfiles();
			const active = manager.getActiveProfileName();
			return formatProfileList(profiles, active);
		},
	});

	pi.registerCommand("sdd-profile-save", {
		description: "Guardar configuración actual de subagents.json como perfil",
		handler: async (args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const trimmed = (args || "").trim();
			if (!trimmed) {
				ctx.ui?.notify?.("Uso: /sdd-profile-save <nombre> [descripción]", "warning");
				return "Uso: /sdd-profile-save <nombre> [descripción]";
			}
			const [name, ...descParts] = trimmed.split(/\s+/);
			const desc = descParts.join(" ") || undefined;
			const res = manager.saveCurrentAsProfile(name, desc, "global");
			ctx.ui?.notify?.(res.message, res.success ? "info" : "error");
			return res.message;
		},
	});

	pi.registerCommand("sdd-profile-rename", {
		description: "Renombrar un perfil existente de modelos SDD",
		handler: async (args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const parts = (args || "").trim().split(/\s+/);
			const oldName = parts[0];
			const newName = parts[1];
			if (!oldName || !newName) {
				const usage = "Uso: /sdd-profile-rename <nombre-actual> <nuevo-nombre>";
				ctx.ui?.notify?.(usage, "warning");
				return usage;
			}
			const res = manager.renameProfile(oldName, newName);
			ctx.ui?.notify?.(res.message, res.success ? "info" : "warning");
			return res.message;
		},
	});

	pi.registerCommand("sdd-profile-delete", {
		description: "Eliminar un perfil de modelos SDD",
		handler: async (args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const target = (args || "").trim();
			if (!target) {
				const usage = "Uso: /sdd-profile-delete <nombre>";
				ctx.ui?.notify?.(usage, "warning");
				return usage;
			}
			const profile = manager.loadProfile(target);
			if (!profile) {
				const msg = `Perfil "${target}" no encontrado.`;
				ctx.ui?.notify?.(msg, "warning");
				return msg;
			}
			const active = manager.getActiveProfileName();
			if (active && manager.sanitizeName(active) === manager.sanitizeName(target)) {
				const msg = `No se puede eliminar el perfil activo "${target}". Activa otro perfil antes de eliminar este.`;
				ctx.ui?.notify?.(msg, "warning");
				return msg;
			}
			const deleted = manager.deleteProfile(target);
			const msg = deleted
				? `Perfil "${target}" eliminado correctamente.`
				: `No se pudo eliminar el perfil "${target}".`;
			ctx.ui?.notify?.(msg, deleted ? "info" : "warning");
			return msg;
		},
	});

	// Shortcut alt+m to open modal
	pi.registerShortcut(SDD_PROFILES_SHORTCUT as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Abrir ventana flotante de perfiles SDD",
		handler: async (ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			await openProfilesModal(pi, manager, ctx);
		},
	});

	// LLM Tools
	pi.registerTool({
		name: "sdd_profile_list",
		description: "List all available SDD and subagent model profiles.",
		parameters: {
			type: "object",
			properties: {},
		},
		execute: async (_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const profiles = manager.listProfiles();
			const active = manager.getActiveProfileName();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ active_profile: active, profiles }, null, 2),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "sdd_profile_switch",
		description: "Switch the active SDD and subagent model profile.",
		parameters: {
			type: "object",
			properties: {
				profile_name: {
					type: "string",
					description: "The name of the profile to activate (e.g. 'cinlo-flash', 'deep-reasoning').",
				},
				scope: {
					type: "string",
					description: "Whether to update 'global' or 'project' subagents config.",
					enum: ["global", "project"],
				},
			},
			required: ["profile_name"],
		},
		execute: async (
			_toolCallId: string,
			args: { profile_name: string; scope?: "global" | "project" },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			const manager = getManager(ctx);
			const res = manager.activateProfile(args.profile_name, args.scope ?? "global");
			if (res.success && res.profile) {
				await syncActiveProfileToRuntime(pi, res.profile, ctx);
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: res.success,
								message: res.message,
								active_profile: args.profile_name,
							},
							null,
							2,
						),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "sdd_profile_rename",
		description: "Rename an existing SDD and subagent model profile.",
		parameters: {
			type: "object",
			properties: {
				old_name: {
					type: "string",
					description: "The current name of the profile to rename.",
				},
				new_name: {
					type: "string",
					description: "The new name for the profile.",
				},
			},
			required: ["old_name", "new_name"],
		},
		execute: async (
			_toolCallId: string,
			args: { old_name: string; new_name: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			const manager = getManager(ctx);
			const res = manager.renameProfile(args.old_name, args.new_name);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(res, null, 2),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "sdd_profile_delete",
		description: "Delete an existing SDD and subagent model profile.",
		parameters: {
			type: "object",
			properties: {
				profile_name: {
					type: "string",
					description: "The name of the profile to delete.",
				},
			},
			required: ["profile_name"],
		},
		execute: async (
			_toolCallId: string,
			args: { profile_name: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			const manager = getManager(ctx);
			const profile = manager.loadProfile(args.profile_name);
			if (!profile) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ success: false, message: `Perfil "${args.profile_name}" no encontrado.` },
								null,
								2,
							),
						},
					],
				};
			}
			const active = manager.getActiveProfileName();
			if (active && manager.sanitizeName(active) === manager.sanitizeName(args.profile_name)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: false,
									message: `No se puede eliminar el perfil activo "${args.profile_name}". Activa otro perfil antes de eliminarlo.`,
								},
								null,
								2,
							),
						},
					],
				};
			}
			const deleted = manager.deleteProfile(args.profile_name);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: deleted,
								message: deleted
									? `Perfil "${args.profile_name}" eliminado.`
									: `No se pudo eliminar "${args.profile_name}".`,
							},
							null,
							2,
						),
					},
				],
			};
		},
	});
}
