export type ReasoningEffort =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface ModelProfileEntry {
	model: string;
	effort?: ReasoningEffort;
}

export interface Profile {
	name: string;
	description?: string;
	default_model?: string;
	default_effort?: ReasoningEffort;
	model_profiles: Record<string, ModelProfileEntry>;
	created_at?: string;
	updated_at?: string;
}

export type ProfileScope = "builtin" | "global" | "project";

export interface ProfileSummary {
	name: string;
	description?: string;
	default_model?: string;
	agent_count: number;
	scope: ProfileScope;
	is_active: boolean;
	path?: string;
}

export interface SubagentsConfigFile {
	default_model?: string;
	default_effort?: string;
	active_profile?: string;
	model_profiles?: Record<string, { model: string; effort?: string }>;
	[key: string]: unknown;
}

export interface AgentCategory {
	id: string;
	name: string;
	description: string;
	agents: string[];
}

export const SDD_AGENT_CATEGORIES: AgentCategory[] = [
	{
		id: "sdd-core",
		name: "Núcleo SDD",
		description: "Agentes ejecutores de fases de Spec-Driven Development",
		agents: [
			"sdd-explore",
			"sdd-propose",
			"sdd-spec",
			"sdd-design",
			"sdd-tasks",
			"sdd-apply",
			"sdd-verify",
			"sdd-archive",
		],
	},
	{
		id: "judgment-day",
		name: "Judgment Day",
		description: "Revisión dual ciega, jueces y corrección",
		agents: ["jd-judge-a", "jd-judge-b", "jd-fix-agent"],
	},
	{
		id: "reviewers",
		name: "Revisores y Auditores",
		description: "Lentes de calidad, seguridad y arquitectura",
		agents: [
			"security-auditor",
			"review-readability",
			"review-reliability",
			"review-resilience",
			"review-validator",
			"review-refuter",
			"review-risk",
		],
	},
	{
		id: "general",
		name: "Harness General",
		description: "Subagentes generales para tareas exploratorias y de código",
		agents: [
			"gentle-ai-explore",
			"gentle-ai-worker",
			"gentle-ai-verify",
			"ui-specialist",
			"task-tracker-manager",
		],
	},
];

export const ALL_KNOWN_AGENTS: string[] = SDD_AGENT_CATEGORIES.flatMap((c) => c.agents);

export const BUILTIN_PROFILES: Record<string, Profile> = {
	"balanced-default": {
		name: "balanced-default",
		description: "Equilibrio entre calidad y costo para Spec-Driven Development",
		default_model: "anthropic/claude-sonnet-4-5",
		default_effort: "medium",
		model_profiles: {
			"sdd-explore": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"sdd-verify": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"sdd-propose": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"sdd-spec": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"sdd-design": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"sdd-tasks": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"sdd-apply": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-archive": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"jd-judge-a": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"jd-judge-b": { model: "openai/o3-mini", effort: "high" },
			"jd-fix-agent": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"gentle-ai-explore": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"gentle-ai-verify": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"gentle-ai-worker": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
		},
	},
	"speed-economy": {
		name: "speed-economy",
		description: "Velocidad y bajo costo para iteraciones ágiles y tareas directas",
		default_model: "anthropic/claude-haiku-4-5",
		default_effort: "low",
		model_profiles: {
			"sdd-explore": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"sdd-verify": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"sdd-propose": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-spec": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-design": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-tasks": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-apply": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-archive": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"jd-judge-a": { model: "anthropic/claude-haiku-4-5", effort: "medium" },
			"jd-judge-b": { model: "anthropic/claude-haiku-4-5", effort: "medium" },
			"jd-fix-agent": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
		},
	},
	"deep-reasoning": {
		name: "deep-reasoning",
		description: "Máximo esfuerzo de razonamiento en fases críticas de diseño y revisión",
		default_model: "openai/o3-mini",
		default_effort: "high",
		model_profiles: {
			"sdd-explore": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-verify": { model: "anthropic/claude-sonnet-4-5", effort: "medium" },
			"sdd-propose": { model: "openai/o3-mini", effort: "max" },
			"sdd-spec": { model: "openai/o3-mini", effort: "max" },
			"sdd-design": { model: "openai/o3-mini", effort: "max" },
			"sdd-tasks": { model: "openai/o3-mini", effort: "high" },
			"sdd-apply": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"sdd-archive": { model: "anthropic/claude-haiku-4-5", effort: "low" },
			"jd-judge-a": { model: "openai/o3-mini", effort: "max" },
			"jd-judge-b": { model: "anthropic/claude-sonnet-4-5", effort: "high" },
			"jd-fix-agent": { model: "openai/o3-mini", effort: "max" },
		},
	},
};
