import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	ALL_KNOWN_AGENTS,
	SDD_AGENT_CATEGORIES,
	type ModelProfileEntry,
	type Profile,
	type ProfileSummary,
	type ReasoningEffort,
} from "./sdd-profiles-catalog.ts";
import type { SddProfileManager } from "./sdd-profiles-manager.ts";

export interface SddProfilesTheme {
	fg(color: string, text: string): string;
}

export interface SddProfilesViewDeps {
	manager: SddProfileManager;
	availableModels: string[];
	theme: SddProfilesTheme;
	rows?: number;
	onProfileActivated?: (profile: Profile) => Promise<void> | void;
	onClose(result?: { action: "activated" | "saved" | "closed"; profileName?: string }): void;
	requestRender(): void;
}

export type ModalView =
	| "profiles-list"
	| "create-profile"
	| "rename-profile"
	| "confirm-delete"
	| "profile-editor"
	| "model-picker"
	| "effort-picker"
	| "category-picker";

export const ORCHESTRATOR_AGENT_KEY = "👑 Orquestador";
export const ASSIGN_ALL_SUBAGENTS_KEY = "⚡ [Asignar modelo a TODOS]";
export const ASSIGN_ALL_EFFORT_KEY = "🧠 [Asignar esfuerzo a TODOS]";
export const ASSIGN_CATEGORY_KEY = "📦 [Asignar por Categoría...]";

export const EFFORT_OPTIONS: Array<ReasoningEffort | "default"> = [
	"default",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const ROLE = {
	FRAME: "border",
	TITLE: "customMessageLabel",
	SELECTED: "accent",
	NAME: "text",
	NAME_IDLE: "muted",
	META: "dim",
	TEXT: "text",
	KEY: "accent",
	KEY_TEXT: "dim",
	EMPTY: "dim",
	ACTIVE: "success",
	WARNING: "warning",
	ERROR: "error",
} as const;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class SddProfilesView implements Component {
	private readonly manager: SddProfileManager;
	private readonly availableModels: string[];
	private readonly theme: SddProfilesTheme;
	private readonly rows: number;
	private readonly onClose: (result?: { action: "activated" | "saved" | "closed"; profileName?: string }) => void;
	private readonly requestRender: () => void;
	private readonly onProfileActivated?: (profile: Profile) => Promise<void> | void;

	private view: ModalView = "profiles-list";
	private profiles: ProfileSummary[] = [];
	private selectedProfileIndex = 0;
	private profileScrollOffset = 0;

	// Creation, rename, and delete state
	private textInput = "";
	private creationStep: "name" | "description" = "name";
	private pendingProfileName = "";
	private descriptionInput = "";
	private renamingOldName = "";
	private deletingProfileName = "";
	private errorMessage: string | null = null;
	private feedbackMessage: string | null = null;

	// Profile editor state
	private editingProfile: Profile | null = null;
	private editingAgentsList: string[] = [];
	private selectedAgentIndex = 0;
	private agentScrollOffset = 0;
	private isDirty = false;

	// Pickers state
	private pickerItems: string[] = [];
	private pickerIndex = 0;
	private pickerScrollOffset = 0;
	private pickerTarget: "default-model" | "agent-model" | "all-models" | "category-models" = "agent-model";
	private targetCategory?: string;
	private stagedModel?: string;
	private modelFilter = "";
	private allPickerModels: string[] = [];

	constructor(deps: SddProfilesViewDeps) {
		this.manager = deps.manager;
		this.availableModels = deps.availableModels;
		this.theme = deps.theme;
		this.rows = Math.max(12, deps.rows ?? 16);
		this.onClose = deps.onClose;
		this.requestRender = deps.requestRender;
		this.onProfileActivated = deps.onProfileActivated;

		this.refreshProfiles();
		this.initEditingAgentsList();
	}

	private refreshProfiles(): void {
		this.profiles = this.manager.listProfiles();
		if (this.selectedProfileIndex >= this.profiles.length) {
			this.selectedProfileIndex = Math.max(0, this.profiles.length - 1);
		}
	}

	private initEditingAgentsList(): void {
		this.editingAgentsList = [
			ORCHESTRATOR_AGENT_KEY,
			ASSIGN_ALL_SUBAGENTS_KEY,
			ASSIGN_ALL_EFFORT_KEY,
			ASSIGN_CATEGORY_KEY,
			...ALL_KNOWN_AGENTS,
		];
	}

	private applyModelFilter(): void {
		const query = this.modelFilter.trim().toLowerCase();
		if (!query) {
			this.pickerItems = [...this.allPickerModels];
		} else {
			const tokens = query.split(/\s+/).filter(Boolean);
			this.pickerItems = this.allPickerModels.filter((model) => {
				const lower = model.toLowerCase();
				return tokens.every((token) => lower.includes(token));
			});
		}
		this.pickerIndex = 0;
		this.pickerScrollOffset = 0;
	}

	private openModelPicker(
		target: "default-model" | "agent-model" | "all-models" | "category-models",
		category?: string,
	): void {
		this.pickerTarget = target;
		this.targetCategory = category;
		this.allPickerModels = [...this.availableModels];
		this.modelFilter = "";
		this.applyModelFilter();
		this.view = "model-picker";
	}

	invalidate(): void {}
	dispose(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(40, Math.floor(width || 80));
		const inner = safeWidth - 2;
		const bodyRows = Math.max(8, this.rows - 3);

		const listWidth = Math.max(26, Math.min(34, Math.floor(inner * 0.35)));
		const rightWidth = Math.max(10, inner - listWidth - 3);

		let subtitle = "";
		let leftLines: string[] = [];
		let rightLines: string[] = [];
		let keysList: Array<[string, string]> = [];

		switch (this.view) {
			case "profiles-list": {
				const active = this.profiles.find((p) => p.is_active)?.name ?? "ninguno";
				subtitle = `activo: ${active} · ${this.profiles.length} perfiles`;
				leftLines = this.renderProfilesLeft(listWidth, bodyRows);
				rightLines = this.renderProfileDetailsRight(rightWidth, bodyRows);
				keysList = [
					["j/k", "navegar"],
					["enter", "activar"],
					["e", "editar"],
					["n", "nuevo"],
					["r", "renombrar"],
					["d", "borrar"],
					["esc", "salir"],
				];
				break;
			}
			case "profile-editor": {
				const profileName = this.editingProfile?.name ?? "";
				const dirtyTag = this.isDirty ? " · [modificado *]" : "";
				subtitle = `editando: ${profileName}${dirtyTag}`;
				leftLines = this.renderEditorLeft(listWidth, bodyRows);
				rightLines = this.renderEditorRight(rightWidth, bodyRows);
				keysList = [
					["j/k", "navegar"],
					["enter", "modificar"],
					["s", "guardar"],
					["esc", "volver"],
				];
				break;
			}
			case "model-picker": {
				subtitle = `buscar: "${this.modelFilter}" · ${this.pickerItems.length} modelos`;
				leftLines = this.renderModelPickerLeft(listWidth, bodyRows);
				rightLines = this.renderModelPickerRight(rightWidth, bodyRows);
				keysList = [
					["j/k", "navegar"],
					["enter", "elegir esfuerzo"],
					["backspace", "borrar"],
					["esc", "volver"],
				];
				break;
			}
			case "effort-picker": {
				subtitle = "seleccionar nivel de esfuerzo de razonamiento";
				leftLines = this.renderEffortPickerLeft(listWidth, bodyRows);
				rightLines = this.renderEffortPickerRight(rightWidth, bodyRows);
				keysList = [
					["j/k", "navegar"],
					["enter", "aplicar"],
					["esc", "volver"],
				];
				break;
			}
			case "category-picker": {
				subtitle = "seleccionar categoría a configurar";
				leftLines = this.renderCategoryPickerLeft(listWidth, bodyRows);
				rightLines = this.renderCategoryPickerRight(rightWidth, bodyRows);
				keysList = [
					["j/k", "navegar"],
					["enter", "seleccionar modelo"],
					["esc", "volver"],
				];
				break;
			}
			case "create-profile": {
				subtitle = this.creationStep === "name" ? "crear perfil · paso 1 de 2 (nombre)" : "crear perfil · paso 2 de 2 (descripción)";
				if (this.creationStep === "name") {
					leftLines = [
						this.theme.fg(ROLE.TITLE, "Nuevo Perfil SDD"),
						"",
						this.theme.fg(ROLE.META, "Nombre del perfil:"),
						`  ${this.theme.fg(ROLE.SELECTED, ">")} ${this.theme.fg(ROLE.NAME, this.textInput)}${this.theme.fg(ROLE.META, "_")}`,
						"",
						this.errorMessage ? this.theme.fg(ROLE.ERROR, `  ${this.errorMessage}`) : "",
					];
					rightLines = [
						this.theme.fg(ROLE.TITLE, "Paso 1: Identificador"),
						rule(Math.min(rightWidth - 2, 40)),
						this.theme.fg(ROLE.TEXT, "Escribe un nombre identificador único"),
						this.theme.fg(ROLE.META, "(ej: deep-research, anthropic-fast, sonnet-pro)."),
						"",
						this.theme.fg(ROLE.META, "Presiona enter para continuar a la descripción."),
					];
					keysList = [
						["enter", "siguiente paso"],
						["esc", "cancelar"],
					];
				} else {
					leftLines = [
						this.theme.fg(ROLE.TITLE, "Nuevo Perfil SDD"),
						"",
						`${this.theme.fg(ROLE.META, "Perfil:")} ${this.theme.fg(ROLE.SELECTED, this.pendingProfileName)}`,
						"",
						this.theme.fg(ROLE.META, "Descripción (opcional):"),
						`  ${this.theme.fg(ROLE.SELECTED, ">")} ${this.theme.fg(ROLE.NAME, this.descriptionInput)}${this.theme.fg(ROLE.META, "_")}`,
						"",
						this.errorMessage ? this.theme.fg(ROLE.ERROR, `  ${this.errorMessage}`) : "",
					];
					rightLines = [
						this.theme.fg(ROLE.TITLE, "Paso 2: Descripción"),
						rule(Math.min(rightWidth - 2, 40)),
						this.theme.fg(ROLE.TEXT, "Agrega una breve nota o propósito"),
						this.theme.fg(ROLE.META, "(ej: Modelos rápidos para iteraciones leves)."),
						"",
						this.theme.fg(ROLE.META, "Puedes dejarlo vacío y presionar enter para omitir."),
					];
					keysList = [
						["enter", "crear perfil"],
						["esc", "volver"],
					];
				}
				break;
			}
			case "rename-profile": {
				subtitle = `renombrar "${this.renamingOldName}"`;
				leftLines = [
					this.theme.fg(ROLE.TITLE, `Renombrar`),
					"",
					`  ${this.theme.fg(ROLE.SELECTED, ">")} ${this.theme.fg(ROLE.NAME, this.textInput)}${this.theme.fg(ROLE.META, "_")}`,
					"",
					this.errorMessage ? this.theme.fg(ROLE.ERROR, `  ${this.errorMessage}`) : "",
				];
				rightLines = [
					this.theme.fg(ROLE.META, `Nombre actual: ${this.renamingOldName}`),
					"",
					this.theme.fg(ROLE.META, "Escribe el nuevo nombre y presiona enter."),
				];
				keysList = [
					["enter", "confirmar"],
					["esc", "cancelar"],
				];
				break;
			}
			case "confirm-delete": {
				subtitle = `confirmar eliminación`;
				leftLines = [
					this.theme.fg(ROLE.WARNING, "Eliminar perfil"),
					"",
					this.theme.fg(ROLE.NAME, `  ¿Eliminar "${this.deletingProfileName}"?`),
				];
				rightLines = [
					this.theme.fg(ROLE.WARNING, "Atención: Esta acción no se puede deshacer."),
					"",
					this.theme.fg(ROLE.META, "Presiona [ y ] para confirmar o [ n / esc ] para cancelar."),
				];
				keysList = [
					["y", "confirmar eliminación"],
					["n/esc", "cancelar"],
				];
				break;
			}
		}

		// Title formatting: ╭─ ✿ Profiles · subtitle ────────...─╮
		const titleText = subtitle ? `✿ Perfiles SDD · ${subtitle}` : `✿ Perfiles SDD`;
		const top =
			this.theme.fg(ROLE.FRAME, "╭─ ") +
			this.theme.fg(ROLE.TITLE, titleText) +
			this.theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(titleText) - 3)}╮`);

		// Two-column split body
		const body: string[] = [];
		for (let row = 0; row < bodyRows; row += 1) {
			const leftCol = fit(leftLines[row] ?? "", listWidth);
			const rightCol = fit(rightLines[row] ?? "", rightWidth);
			body.push(
				`${this.theme.fg(ROLE.FRAME, "│")} ${leftCol} ${this.theme.fg(ROLE.FRAME, "│")} ${rightCol}${this.theme.fg(ROLE.FRAME, "│")}`,
			);
		}

		// Footer line with Gentle-style keys: [key] label
		const formattedKeys = keysList
			.map(([key, label]) => `${this.theme.fg(ROLE.KEY, key)} ${this.theme.fg(ROLE.KEY_TEXT, label)}`)
			.join(" ");
		const keysLine = `${this.theme.fg(ROLE.FRAME, "│")} ${fit(formattedKeys, inner - 2)} ${this.theme.fg(ROLE.FRAME, "│")}`;
		const bottom = this.theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`);

		return [top, ...body, keysLine, bottom];
	}

	// Profiles list left column
	private renderProfilesLeft(width: number, rows: number): string[] {
		const lines: string[] = [];
		if (this.profiles.length === 0) {
			return [this.theme.fg(ROLE.EMPTY, "sin perfiles disponibles")];
		}

		if (this.selectedProfileIndex < this.profileScrollOffset) {
			this.profileScrollOffset = this.selectedProfileIndex;
		} else if (this.selectedProfileIndex >= this.profileScrollOffset + rows) {
			this.profileScrollOffset = this.selectedProfileIndex - rows + 1;
		}

		const visible = this.profiles.slice(this.profileScrollOffset, this.profileScrollOffset + rows);
		for (let i = 0; i < visible.length; i += 1) {
			const p = visible[i];
			const actualIndex = this.profileScrollOffset + i;
			const isSelected = actualIndex === this.selectedProfileIndex;

			const marker = isSelected ? this.theme.fg(ROLE.SELECTED, "▶") : " ";
			const glyph = p.is_active ? this.theme.fg(ROLE.ACTIVE, "❀") : this.theme.fg(ROLE.META, "○");
			const name = this.theme.fg(isSelected ? ROLE.SELECTED : ROLE.NAME, p.name);
			const scope = this.theme.fg(ROLE.META, `[${p.scope[0]}]`);

			lines.push(`${marker} ${glyph} ${name} ${scope}`);
		}
		return lines;
	}

	// Profile details right column (thread / preview pane)
	private renderProfileDetailsRight(width: number, rows: number): string[] {
		const selected = this.profiles[this.selectedProfileIndex];
		if (!selected) return [];

		const full = this.manager.loadProfile(selected.name);
		const lines: string[] = [];

		if (this.feedbackMessage) {
			lines.push(this.theme.fg(ROLE.SELECTED, `❀ ${this.feedbackMessage}`));
			lines.push("");
		}

		const activeTag = selected.is_active
			? this.theme.fg(ROLE.ACTIVE, "❀ ACTIVO")
			: this.theme.fg(ROLE.META, "INACTIVO");
		lines.push(`${this.theme.fg(ROLE.TITLE, selected.name)}  ${activeTag}`);

		if (full?.description) {
			lines.push(this.theme.fg(ROLE.META, full.description));
		}
		lines.push(this.theme.fg(ROLE.META, `Alcance: ${selected.scope} · Ubicación: ${selected.path ?? "builtin"}`));
		lines.push(rule(Math.min(width - 2, 40)));

		const defModel = full?.default_model ?? "default";
		const defEffort = full?.default_effort ? ` · effort: ${full.default_effort}` : "";
		lines.push(`${this.theme.fg(ROLE.SELECTED, "👑 Orquestador:")} ${this.theme.fg(ROLE.TEXT, defModel)}${this.theme.fg(ROLE.META, defEffort)}`);
		lines.push("");

		const entries = Object.entries(full?.model_profiles ?? {});
		lines.push(this.theme.fg(ROLE.TITLE, `Agentes configurados (${entries.length}):`));

		for (const [agent, cfg] of entries) {
			const effort = cfg.effort ? ` [${cfg.effort}]` : "";
			lines.push(`  ${this.theme.fg(ROLE.NAME, agent)}: ${this.theme.fg(ROLE.NAME_IDLE, cfg.model)}${this.theme.fg(ROLE.META, effort)}`);
		}

		return lines.slice(0, rows);
	}

	// Editor left column
	private renderEditorLeft(width: number, rows: number): string[] {
		const lines: string[] = [];
		const total = this.editingAgentsList.length;

		if (this.selectedAgentIndex < this.agentScrollOffset) {
			this.agentScrollOffset = this.selectedAgentIndex;
		} else if (this.selectedAgentIndex >= this.agentScrollOffset + rows) {
			this.agentScrollOffset = this.selectedAgentIndex - rows + 1;
		}

		const visible = this.editingAgentsList.slice(this.agentScrollOffset, this.agentScrollOffset + rows);
		for (let i = 0; i < visible.length; i += 1) {
			const item = visible[i];
			const actualIndex = this.agentScrollOffset + i;
			const isSelected = actualIndex === this.selectedAgentIndex;

			const marker = isSelected ? this.theme.fg(ROLE.SELECTED, "▶") : " ";
			let label = item;
			let details = "";
			if (item === ORCHESTRATOR_AGENT_KEY) {
				const currentModel = this.editingProfile?.default_model ?? "default";
				details = ` (${currentModel})`;
			} else if (
				item !== ASSIGN_ALL_SUBAGENTS_KEY &&
				item !== ASSIGN_ALL_EFFORT_KEY &&
				item !== ASSIGN_CATEGORY_KEY
			) {
				const assigned = this.editingProfile?.model_profiles[item];
				if (assigned) {
					details = ` (${assigned.model})`;
				}
			}

			const styledLabel = isSelected
				? this.theme.fg(ROLE.SELECTED, `${label}${details}`)
				: item.startsWith("👑") || item.startsWith("⚡") || item.startsWith("🧠") || item.startsWith("📦")
					? `${this.theme.fg(ROLE.TEXT, label)}${this.theme.fg(ROLE.META, details)}`
					: `${this.theme.fg(ROLE.NAME_IDLE, label)}${this.theme.fg(ROLE.META, details)}`;

			lines.push(`${marker} ${styledLabel}`);
		}
		return lines;
	}

	// Editor right column
	private renderEditorRight(width: number, rows: number): string[] {
		const profile = this.editingProfile;
		if (!profile) return [];

		const lines: string[] = [];
		const selectedKey = this.editingAgentsList[this.selectedAgentIndex];

		lines.push(this.theme.fg(ROLE.TITLE, `Configuración de: ${selectedKey}`));
		lines.push(rule(Math.min(width - 2, 40)));

		if (selectedKey === ORCHESTRATOR_AGENT_KEY) {
			lines.push(this.theme.fg(ROLE.TEXT, "Define el modelo y esfuerzo de razonamiento principal"));
			lines.push(this.theme.fg(ROLE.TEXT, "usado por la sesión orquestadora de Pi."));
			lines.push("");
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Modelo actual:")} ${profile.default_model ?? "default"}`);
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Esfuerzo actual:")} ${profile.default_effort ?? "default"}`);
		} else if (selectedKey === ASSIGN_ALL_SUBAGENTS_KEY) {
			lines.push(this.theme.fg(ROLE.TEXT, "Asigna masivamente un único modelo"));
			lines.push(this.theme.fg(ROLE.TEXT, "a todos los subagentes del catálogo."));
		} else if (selectedKey === ASSIGN_ALL_EFFORT_KEY) {
			lines.push(this.theme.fg(ROLE.TEXT, "Asigna masivamente un nivel de razonamiento"));
			lines.push(this.theme.fg(ROLE.TEXT, "a todos los subagentes del catálogo."));
		} else if (selectedKey === ASSIGN_CATEGORY_KEY) {
			lines.push(this.theme.fg(ROLE.TEXT, "Configura modelos en bloque por categoría"));
			lines.push(this.theme.fg(ROLE.TEXT, "(Núcleo SDD, Judgment Day, Revisores, etc.)."));
		} else {
			const entry = profile.model_profiles[selectedKey];
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Agente:")} ${this.theme.fg(ROLE.TEXT, selectedKey)}`);
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Modelo asignado:")} ${entry?.model ?? this.theme.fg(ROLE.META, "(hereda default)")}`);
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Nivel de esfuerzo:")} ${entry?.effort ?? this.theme.fg(ROLE.META, "(hereda default)")}`);
			lines.push("");
			lines.push(this.theme.fg(ROLE.META, "Presiona enter para cambiar de modelo y nivel de esfuerzo."));
		}

		lines.push("");
		lines.push(this.theme.fg(ROLE.META, "Presiona [ s ] en cualquier momento para guardar los cambios."));
		return lines.slice(0, rows);
	}

	// Model picker left column
	private renderModelPickerLeft(width: number, rows: number): string[] {
		const lines: string[] = [];
		if (this.pickerItems.length === 0) {
			return [this.theme.fg(ROLE.EMPTY, "sin coincidencias")];
		}

		if (this.pickerIndex < this.pickerScrollOffset) {
			this.pickerScrollOffset = this.pickerIndex;
		} else if (this.pickerIndex >= this.pickerScrollOffset + rows) {
			this.pickerScrollOffset = this.pickerIndex - rows + 1;
		}

		const visible = this.pickerItems.slice(this.pickerScrollOffset, this.pickerScrollOffset + rows);
		for (let i = 0; i < visible.length; i += 1) {
			const m = visible[i];
			const actualIndex = this.pickerScrollOffset + i;
			const isSelected = actualIndex === this.pickerIndex;

			const marker = isSelected ? this.theme.fg(ROLE.SELECTED, "▶") : " ";
			const label = isSelected ? this.theme.fg(ROLE.SELECTED, m) : this.theme.fg(ROLE.TEXT, m);
			lines.push(`${marker} ${label}`);
		}
		return lines;
	}

	// Model picker right column
	private renderModelPickerRight(width: number, rows: number): string[] {
		const lines: string[] = [];
		const selectedModel = this.pickerItems[this.pickerIndex];
		const targetLabel =
			this.pickerTarget === "default-model"
				? "Orquestador (default)"
				: this.pickerTarget === "all-models"
					? "TODOS los subagentes"
					: this.pickerTarget === "category-models"
						? `Categoría [${this.targetCategory}]`
						: this.editingAgentsList[this.selectedAgentIndex];

		lines.push(this.theme.fg(ROLE.TITLE, `Seleccionar modelo para: ${targetLabel}`));
		lines.push(rule(Math.min(width - 2, 40)));
		lines.push(`${this.theme.fg(ROLE.META, "Filtro:")} ${this.theme.fg(ROLE.TEXT, this.modelFilter)}${this.theme.fg(ROLE.SELECTED, "█")}`);
		lines.push("");

		if (selectedModel) {
			lines.push(`${this.theme.fg(ROLE.SELECTED, "Seleccionado:")} ${selectedModel}`);
			const sep = selectedModel.indexOf("/");
			if (sep !== -1) {
				lines.push(`${this.theme.fg(ROLE.META, "Proveedor:")} ${selectedModel.slice(0, sep)}`);
				lines.push(`${this.theme.fg(ROLE.META, "ID:")} ${selectedModel.slice(sep + 1)}`);
			}
		}

		lines.push("");
		lines.push(this.theme.fg(ROLE.META, "Tipea letras para filtrar."));
		lines.push(this.theme.fg(ROLE.META, "Enter selecciona el modelo y pasa al selector de effort."));
		return lines.slice(0, rows);
	}

	// Effort picker left column
	private renderEffortPickerLeft(width: number, rows: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < EFFORT_OPTIONS.length; i += 1) {
			const effort = EFFORT_OPTIONS[i];
			const isSelected = i === this.pickerIndex;
			const marker = isSelected ? this.theme.fg(ROLE.SELECTED, "▶") : " ";
			const label = isSelected ? this.theme.fg(ROLE.SELECTED, effort) : this.theme.fg(ROLE.TEXT, effort);
			lines.push(`${marker} ${label}`);
		}
		return lines;
	}

	// Effort picker right column
	private renderEffortPickerRight(width: number, rows: number): string[] {
		const lines: string[] = [];
		const effort = EFFORT_OPTIONS[this.pickerIndex];

		lines.push(this.theme.fg(ROLE.TITLE, "Nivel de Razonamiento"));
		lines.push(rule(Math.min(width - 2, 40)));
		lines.push(`${this.theme.fg(ROLE.SELECTED, "Nivel:")} ${effort}`);
		lines.push("");

		const descriptions: Record<string, string> = {
			default: "Usa el valor default configurado en el orquestador o en el agente.",
			off: "Razonamiento desactivado (sin thinking tokens).",
			minimal: "Mínimo presupuesto de pensamiento.",
			low: "Bajo presupuesto de pensamiento (rápido y económico).",
			medium: "Esfuerzo medio equilibrado.",
			high: "Esfuerzo alto para razonamiento profundo.",
			xhigh: "Esfuerzo muy alto para fases críticas de diseño/código.",
			max: "Máximo presupuesto posible soportado por el modelo.",
		};

		lines.push(this.theme.fg(ROLE.TEXT, descriptions[effort] ?? ""));
		return lines.slice(0, rows);
	}

	// Category picker left column
	private renderCategoryPickerLeft(width: number, rows: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < SDD_AGENT_CATEGORIES.length; i += 1) {
			const cat = SDD_AGENT_CATEGORIES[i];
			const isSelected = i === this.pickerIndex;
			const marker = isSelected ? this.theme.fg(ROLE.SELECTED, "▶") : " ";
			const label = isSelected ? this.theme.fg(ROLE.SELECTED, cat.name) : this.theme.fg(ROLE.TEXT, cat.name);
			lines.push(`${marker} ${label}`);
		}
		return lines;
	}

	// Category picker right column
	private renderCategoryPickerRight(width: number, rows: number): string[] {
		const lines: string[] = [];
		const cat = SDD_AGENT_CATEGORIES[this.pickerIndex];
		if (!cat) return [];

		lines.push(this.theme.fg(ROLE.TITLE, cat.name));
		lines.push(rule(Math.min(width - 2, 40)));
		lines.push(this.theme.fg(ROLE.TEXT, cat.description));
		lines.push("");
		lines.push(this.theme.fg(ROLE.META, `Agentes en esta categoría (${cat.agents.length}):`));

		for (const a of cat.agents) {
			lines.push(`  ${this.theme.fg(ROLE.NAME, "•")} ${a}`);
		}
		return lines.slice(0, rows);
	}

	handleInput(data: string): void {
		switch (this.view) {
			case "profiles-list":
				this.handleProfilesListInput(data);
				break;
			case "profile-editor":
				this.handleProfileEditorInput(data);
				break;
			case "model-picker":
				this.handleModelPickerInput(data);
				break;
			case "effort-picker":
				this.handleEffortPickerInput(data);
				break;
			case "category-picker":
				this.handleCategoryPickerInput(data);
				break;
			case "create-profile":
			case "rename-profile":
				this.handleTextInput(data);
				break;
			case "confirm-delete":
				this.handleConfirmDeleteInput(data);
				break;
		}
		this.requestRender();
	}

	private handleProfilesListInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onClose({ action: "closed" });
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.selectedProfileIndex > 0) {
				this.selectedProfileIndex -= 1;
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			if (this.selectedProfileIndex < this.profiles.length - 1) {
				this.selectedProfileIndex += 1;
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const selected = this.profiles[this.selectedProfileIndex];
			if (selected) {
				const res = this.manager.activateProfile(selected.name, "global");
				if (res.success && res.profile) {
					this.onProfileActivated?.(res.profile);
					this.refreshProfiles();
					this.feedbackMessage = `Perfil "${selected.name}" activado.`;
				} else {
					this.feedbackMessage = res.message;
				}
			}
			return;
		}

		if (data === "e" || data === "E") {
			const selected = this.profiles[this.selectedProfileIndex];
			if (selected) {
				const full = this.manager.loadProfile(selected.name);
				if (full) {
					this.editingProfile = JSON.parse(JSON.stringify(full)) as Profile;
					this.selectedAgentIndex = 0;
					this.agentScrollOffset = 0;
					this.isDirty = false;
					this.view = "profile-editor";
				}
			}
			return;
		}

		if (data === "n" || data === "N") {
			this.textInput = "";
			this.descriptionInput = "";
			this.creationStep = "name";
			this.pendingProfileName = "";
			this.errorMessage = null;
			this.view = "create-profile";
			return;
		}

		if (data === "r" || data === "R") {
			const selected = this.profiles[this.selectedProfileIndex];
			if (selected) {
				this.renamingOldName = selected.name;
				this.textInput = selected.name;
				this.errorMessage = null;
				this.view = "rename-profile";
			}
			return;
		}

		if (data === "d" || data === "D") {
			const selected = this.profiles[this.selectedProfileIndex];
			if (selected) {
				if (selected.is_active) {
					this.feedbackMessage = `No se puede eliminar el perfil activo "${selected.name}". Activa otro perfil antes de eliminar este.`;
					return;
				}
				this.deletingProfileName = selected.name;
				this.view = "confirm-delete";
			}
			return;
		}
	}

	private handleProfileEditorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.refreshProfiles();
			this.view = "profiles-list";
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.selectedAgentIndex > 0) {
				this.selectedAgentIndex -= 1;
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			if (this.selectedAgentIndex < this.editingAgentsList.length - 1) {
				this.selectedAgentIndex += 1;
			}
			return;
		}

		if (data === "s" || data === "S") {
			if (this.editingProfile) {
				this.manager.saveProfile(this.editingProfile, "global");
				this.isDirty = false;
				this.feedbackMessage = `Perfil "${this.editingProfile.name}" guardado.`;
				this.refreshProfiles();
				this.view = "profiles-list";
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const selectedKey = this.editingAgentsList[this.selectedAgentIndex];
			if (selectedKey === ORCHESTRATOR_AGENT_KEY) {
				this.openModelPicker("default-model");
			} else if (selectedKey === ASSIGN_ALL_SUBAGENTS_KEY) {
				this.openModelPicker("all-models");
			} else if (selectedKey === ASSIGN_ALL_EFFORT_KEY) {
				this.pickerIndex = 0;
				this.pickerTarget = "all-models";
				this.view = "effort-picker";
			} else if (selectedKey === ASSIGN_CATEGORY_KEY) {
				this.pickerIndex = 0;
				this.view = "category-picker";
			} else {
				this.openModelPicker("agent-model");
			}
			return;
		}
	}

	private handleModelPickerInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.view = "profile-editor";
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.pickerIndex > 0) {
				this.pickerIndex -= 1;
			}
			return;
		}

		if (matchesKey(data, Key.down)) {
			if (this.pickerIndex < this.pickerItems.length - 1) {
				this.pickerIndex += 1;
			}
			return;
		}

		if (matchesKey(data, Key.backspace) || data === "\u007f" || data === "\b") {
			if (this.modelFilter.length > 0) {
				this.modelFilter = this.modelFilter.slice(0, -1);
				this.applyModelFilter();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const chosenModel = this.pickerItems[this.pickerIndex];
			if (!chosenModel) return;

			this.stagedModel = chosenModel;
			this.pickerIndex = 0;
			this.view = "effort-picker";
			return;
		}

		if (data.length === 1 && data >= " " && data <= "~") {
			this.modelFilter += data;
			this.applyModelFilter();
			return;
		}
	}

	private handleEffortPickerInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.view = "profile-editor";
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.pickerIndex > 0) {
				this.pickerIndex -= 1;
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			if (this.pickerIndex < EFFORT_OPTIONS.length - 1) {
				this.pickerIndex += 1;
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const effortChoice = EFFORT_OPTIONS[this.pickerIndex];
			const normalizedEffort = effortChoice === "default" ? undefined : effortChoice;
			const profile = this.editingProfile;

			if (profile) {
				if (this.pickerTarget === "default-model") {
					if (this.stagedModel) profile.default_model = this.stagedModel;
					profile.default_effort = normalizedEffort;
					this.isDirty = true;
				} else if (this.pickerTarget === "all-models") {
					for (const agent of ALL_KNOWN_AGENTS) {
						profile.model_profiles[agent] = {
							model: this.stagedModel ?? profile.model_profiles[agent]?.model ?? profile.default_model ?? "anthropic/claude-sonnet-4-5",
							effort: normalizedEffort,
						};
					}
					this.isDirty = true;
				} else if (this.pickerTarget === "category-models" && this.targetCategory) {
					const cat = SDD_AGENT_CATEGORIES.find((c) => c.id === this.targetCategory);
					if (cat) {
						for (const agent of cat.agents) {
							profile.model_profiles[agent] = {
								model: this.stagedModel ?? profile.model_profiles[agent]?.model ?? profile.default_model ?? "anthropic/claude-sonnet-4-5",
								effort: normalizedEffort,
							};
						}
					}
					this.isDirty = true;
				} else if (this.pickerTarget === "agent-model") {
					const currentAgent = this.editingAgentsList[this.selectedAgentIndex];
					if (currentAgent && this.stagedModel) {
						profile.model_profiles[currentAgent] = {
							model: this.stagedModel,
							effort: normalizedEffort,
						};
						this.isDirty = true;
					}
				}
			}

			this.stagedModel = undefined;
			this.view = "profile-editor";
			return;
		}
	}

	private handleCategoryPickerInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.view = "profile-editor";
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.pickerIndex > 0) {
				this.pickerIndex -= 1;
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			if (this.pickerIndex < SDD_AGENT_CATEGORIES.length - 1) {
				this.pickerIndex += 1;
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const selectedCat = SDD_AGENT_CATEGORIES[this.pickerIndex];
			if (selectedCat) {
				this.openModelPicker("category-models", selectedCat.id);
			}
			return;
		}
	}

	private handleTextInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.view === "create-profile" && this.creationStep === "description") {
				this.creationStep = "name";
				this.errorMessage = null;
				return;
			}
			this.view = "profiles-list";
			return;
		}

		if (matchesKey(data, Key.backspace) || data === "\u007f" || data === "\b") {
			if (this.view === "create-profile" && this.creationStep === "description") {
				if (this.descriptionInput.length > 0) {
					this.descriptionInput = this.descriptionInput.slice(0, -1);
				}
			} else {
				if (this.textInput.length > 0) {
					this.textInput = this.textInput.slice(0, -1);
				}
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (this.view === "create-profile") {
				if (this.creationStep === "name") {
					const trimmedName = this.textInput.trim();
					if (!trimmedName) {
						this.errorMessage = "El nombre no puede estar vacío.";
						return;
					}
					const existing = this.manager.loadProfile(trimmedName);
					if (existing) {
						this.errorMessage = `Ya existe un perfil con el nombre "${trimmedName}".`;
						return;
					}
					this.pendingProfileName = trimmedName;
					this.creationStep = "description";
					this.descriptionInput = "";
					this.errorMessage = null;
					return;
				}

				// Step 2: Description
				const trimmedDesc = this.descriptionInput.trim() || undefined;
				const res = this.manager.createProfile({
					name: this.pendingProfileName,
					description: trimmedDesc,
					scope: "global",
				});

				if (res.success && res.profile) {
					this.refreshProfiles();
					const idx = this.profiles.findIndex((p) => p.name.toLowerCase() === this.pendingProfileName.toLowerCase());
					if (idx !== -1) this.selectedProfileIndex = idx;
					this.editingProfile = JSON.parse(JSON.stringify(res.profile)) as Profile;
					this.selectedAgentIndex = 0;
					this.agentScrollOffset = 0;
					this.isDirty = false;
					this.view = "profile-editor";
				} else {
					this.errorMessage = res.message;
				}
				return;
			}

			if (this.view === "rename-profile") {
				const trimmed = this.textInput.trim();
				if (!trimmed) {
					this.errorMessage = "El nombre no puede estar vacío.";
					return;
				}
				const res = this.manager.renameProfile(this.renamingOldName, trimmed);
				if (res.success) {
					this.refreshProfiles();
					this.feedbackMessage = res.message;
					this.view = "profiles-list";
				} else {
					this.errorMessage = res.message;
				}
				return;
			}
			return;
		}

		if (data.length === 1 && data >= " " && data <= "~") {
			if (this.view === "create-profile" && this.creationStep === "description") {
				this.descriptionInput += data;
			} else {
				this.textInput += data;
			}
			this.errorMessage = null;
		}
	}

	private handleConfirmDeleteInput(data: string): void {
		if (data === "y" || data === "Y") {
			const active = this.manager.getActiveProfileName();
			if (active && this.manager.sanitizeName(active) === this.manager.sanitizeName(this.deletingProfileName)) {
				this.feedbackMessage = `No se puede eliminar el perfil activo "${this.deletingProfileName}". Activa otro perfil antes de eliminar este.`;
				this.view = "profiles-list";
				return;
			}
			const deleted = this.manager.deleteProfile(this.deletingProfileName);
			this.refreshProfiles();
			this.feedbackMessage = deleted
				? `Perfil "${this.deletingProfileName}" eliminado.`
				: `No se pudo eliminar "${this.deletingProfileName}".`;
			this.view = "profiles-list";
			return;
		}

		if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
			this.view = "profiles-list";
			return;
		}
	}
}
