import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	ALL_KNOWN_AGENTS,
	BUILTIN_PROFILES,
	SDD_AGENT_CATEGORIES,
	type Profile,
	type SubagentsConfigFile,
} from "../lib/sdd-profiles-catalog.ts";
import {
	applyProfileToConfig,
	applyProfileToFile,
	extractProfileFromConfig,
	resolveAvailableModels,
	SddProfileManager,
} from "../lib/sdd-profiles-manager.ts";
import { SddProfilesView } from "../lib/sdd-profiles-view.ts";
import sddProfilesExtension, {
	SDD_PROFILES_COMMAND,
	SDD_PROFILES_SHORTCUT,
} from "../extensions/sdd-profiles.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "sdd-profiles-test-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const plainTheme = { fg: (_color: string, text: string) => text };

test("catalog has all categories, known agents and builtin presets", () => {
	assert.ok(SDD_AGENT_CATEGORIES.length >= 4);
	assert.ok(ALL_KNOWN_AGENTS.includes("sdd-apply"));
	assert.ok(ALL_KNOWN_AGENTS.includes("jd-judge-a"));
	assert.ok(ALL_KNOWN_AGENTS.includes("gentle-ai-worker"));

	const presets = Object.keys(BUILTIN_PROFILES);
	assert.ok(presets.includes("balanced-default"));
	assert.ok(presets.includes("speed-economy"));
	assert.ok(presets.includes("deep-reasoning"));

	const balanced = BUILTIN_PROFILES["balanced-default"];
	assert.equal(balanced.name, "balanced-default");
	assert.equal(balanced.default_model, "anthropic/claude-sonnet-4-5");
	assert.equal(balanced.default_effort, "medium");
	assert.ok(balanced.model_profiles["sdd-apply"]);
});

test("applyProfileToConfig preserves custom properties and updates model profiles", () => {
	const current: SubagentsConfigFile = {
		timeout_ms: 120000,
		custom_flag: true,
		default_model: "old/model",
		model_profiles: {
			"sdd-apply": { model: "old/model", effort: "low" },
		},
	};

	const profile: Profile = {
		name: "test-profile",
		default_model: "new/default",
		default_effort: "high",
		model_profiles: {
			"sdd-apply": { model: "new/model", effort: "high" },
			"sdd-verify": { model: "new/verify" },
		},
	};

	const updated = applyProfileToConfig(current, profile);
	assert.equal(updated.timeout_ms, 120000);
	assert.equal(updated.custom_flag, true);
	assert.equal(updated.default_model, "new/default");
	assert.equal(updated.default_effort, "high");
	assert.equal(updated.active_profile, "test-profile");
	assert.equal(updated.model_profiles?.["sdd-apply"]?.model, "new/model");
	assert.equal(updated.model_profiles?.["sdd-apply"]?.effort, "high");
	assert.equal(updated.model_profiles?.["sdd-verify"]?.model, "new/verify");
});

test("extractProfileFromConfig correctly captures config data", () => {
	const config: SubagentsConfigFile = {
		default_model: "openai/o3-mini",
		default_effort: "max",
		model_profiles: {
			"sdd-spec": { model: "openai/o3-mini", effort: "max" },
		},
	};

	const extracted = extractProfileFromConfig(config, "my-extracted", "A test description");
	assert.equal(extracted.name, "my-extracted");
	assert.equal(extracted.description, "A test description");
	assert.equal(extracted.default_model, "openai/o3-mini");
	assert.equal(extracted.default_effort, "max");
	assert.deepEqual(extracted.model_profiles["sdd-spec"], {
		model: "openai/o3-mini",
		effort: "max",
	});
});

test("applyProfileToFile writes config atomically to disk", () => {
	const subagentsPath = join(tempRoot, "subagents-atomic.json");
	writeFileSync(subagentsPath, JSON.stringify({ timeout_ms: 5000 }, null, 2), "utf-8");

	const profile: Profile = {
		name: "disk-profile",
		default_model: "anthropic/claude-haiku-4-5",
		model_profiles: {
			"sdd-explore": { model: "anthropic/claude-haiku-4-5" },
		},
	};

	const written = applyProfileToFile(subagentsPath, profile);
	assert.equal(written.active_profile, "disk-profile");
	assert.equal(written.timeout_ms, 5000);

	const raw = JSON.parse(readFileSync(subagentsPath, "utf-8")) as SubagentsConfigFile;
	assert.equal(raw.active_profile, "disk-profile");
	assert.equal(raw.timeout_ms, 5000);
});

test("SddProfileManager lists builtin profiles and handles deleted tombstones", () => {
	const globalDir = join(tempRoot, "manager-global-1");
	const projectDir = join(tempRoot, "manager-project-1");
	const manager = new SddProfileManager({ globalDir, projectDir });

	const list = manager.listProfiles();
	assert.ok(list.some((p) => p.name === "balanced-default" && p.scope === "builtin"));
	assert.ok(list.some((p) => p.name === "speed-economy" && p.scope === "builtin"));

	// Deleting a builtin should record tombstone and remove from list
	const deleted = manager.deleteProfile("speed-economy");
	assert.equal(deleted, true);

	const listAfter = manager.listProfiles();
	assert.ok(!listAfter.some((p) => p.name === "speed-economy"));
	assert.ok(listAfter.some((p) => p.name === "balanced-default"));
});

test("SddProfileManager scopes and precedence: project > global > builtin", () => {
	const globalDir = join(tempRoot, "manager-global-2");
	const projectDir = join(tempRoot, "manager-project-2");
	const manager = new SddProfileManager({ globalDir, projectDir });

	// 1. Builtin
	const builtin = manager.loadProfile("balanced-default");
	assert.ok(builtin);
	assert.equal(builtin?.default_model, "anthropic/claude-sonnet-4-5");

	// 2. Global override
	manager.saveProfile(
		{
			name: "balanced-default",
			description: "Global override",
			default_model: "global/custom-model",
			model_profiles: {},
		},
		"global",
	);

	const loadedGlobal = manager.loadProfile("balanced-default");
	assert.equal(loadedGlobal?.default_model, "global/custom-model");
	assert.equal(loadedGlobal?.description, "Global override");

	// 3. Project override
	manager.saveProfile(
		{
			name: "balanced-default",
			description: "Project override",
			default_model: "project/local-model",
			model_profiles: {},
		},
		"project",
	);

	const loadedProject = manager.loadProfile("balanced-default");
	assert.equal(loadedProject?.default_model, "project/local-model");
	assert.equal(loadedProject?.description, "Project override");
});

test("SddProfileManager activation, saveCurrentAsProfile, rename and delete", () => {
	const globalDir = join(tempRoot, "manager-global-3");
	const projectDir = join(tempRoot, "manager-project-3");
	const globalSubagents = join(tempRoot, "global-subagents-3.json");
	const projectSubagents = join(tempRoot, "project-subagents-3.json");

	const manager = new SddProfileManager({
		globalDir,
		projectDir,
		globalSubagentsPath: globalSubagents,
		projectSubagentsPath: projectSubagents,
	});

	// Create and activate profile
	const created = manager.createProfile({
		name: "custom-v1",
		default_model: "custom/model-v1",
		default_effort: "high",
		model_profiles: {
			"sdd-apply": { model: "custom/model-v1", effort: "high" },
		},
		scope: "global",
	});
	assert.equal(created.success, true);

	const activated = manager.activateProfile("custom-v1", "global");
	assert.equal(activated.success, true);
	assert.equal(manager.getActiveProfileName(), "custom-v1");

	const fileData = JSON.parse(readFileSync(globalSubagents, "utf-8")) as SubagentsConfigFile;
	assert.equal(fileData.active_profile, "custom-v1");
	assert.equal(fileData.default_model, "custom/model-v1");

	// Set agent in profile
	const updated = manager.setAgentInProfile({
		profileName: "custom-v1",
		agentName: "sdd-verify",
		model: "custom/verifier-model",
		effort: "low",
	});
	assert.equal(updated.success, true);
	assert.equal(updated.profile?.model_profiles["sdd-verify"]?.model, "custom/verifier-model");

	// Rename profile
	const renamed = manager.renameProfile("custom-v1", "custom-renamed");
	assert.equal(renamed.success, true);
	assert.equal(manager.getActiveProfileName(), "custom-renamed");
	assert.equal(manager.loadProfile("custom-v1"), null);
	assert.ok(manager.loadProfile("custom-renamed"));

	// Save current config as profile
	const savedCurrent = manager.saveCurrentAsProfile("snapshot-profile", "Snapshot description", "global");
	assert.equal(savedCurrent.success, true);
	const snapshot = manager.loadProfile("snapshot-profile");
	assert.equal(snapshot?.name, "snapshot-profile");

	// Cannot delete an active profile without switching first
	assert.equal(manager.getActiveProfileName(), "snapshot-profile");
	const blockedDelete = manager.deleteProfile("snapshot-profile");
	assert.equal(blockedDelete, false, "Should block deleting an active profile");
	assert.ok(manager.loadProfile("snapshot-profile"), "Profile must still exist");

	// Switch to another profile, then delete succeeds
	manager.activateProfile("custom-renamed", "global");
	const deleted = manager.deleteProfile("snapshot-profile");
	assert.equal(deleted, true);
	assert.equal(manager.loadProfile("snapshot-profile"), null);
});

test("resolveAvailableModels discovers models with fallbacks", async () => {
	const fakeCtx = {
		modelRegistry: {
			async getAvailable() {
				return [
					{ provider: "mock-provider", id: "mock-model" },
				];
			},
		},
	};

	const models = await resolveAvailableModels(fakeCtx);
	assert.ok(models.includes("mock-provider/mock-model"));
	assert.ok(models.includes("anthropic/claude-sonnet-4-5"));
	assert.ok(models.includes("openai/o3-mini"));
});

test("SddProfilesView renders with Gentle Shell card styling and no raw ANSI backgrounds", () => {
	const globalDir = join(tempRoot, "view-global-1");
	const projectDir = join(tempRoot, "view-project-1");
	const manager = new SddProfileManager({ globalDir, projectDir });

	let closedWith: unknown;
	const view = new SddProfilesView({
		manager,
		availableModels: ["anthropic/claude-sonnet-4-5", "openai/o3-mini"],
		theme: plainTheme,
		onClose: (res) => { closedWith = res; },
		requestRender: () => {},
	});

	const rendered = view.render(80);
	const output = rendered.join("\n");

	// Gentle Shell frame characters
	assert.ok(rendered[0].includes("╭─"));
	assert.ok(rendered[0].includes("✿"));
	assert.ok(rendered[rendered.length - 1].includes("╰"));
	assert.ok(rendered[rendered.length - 1].includes("╯"));

	// Zero hardcoded ANSI escapes (no \x1b[48;2;...m)
	assert.equal(output.includes("\x1b[48;2;"), false, "Must not contain hardcoded 24-bit background ANSI");
	assert.equal(output.includes("\x1b[49m"), false, "Must not contain raw background reset ANSI");

	// Shortcuts footer in Gentle style
	assert.ok(output.includes("enter activar"));
	assert.ok(output.includes("esc salir"));

	// Pressing escape closes the modal
	view.handleInput("\u001b");
	assert.deepEqual(closedWith, { action: "closed" });
});

test("SddProfilesView interactive navigation, creation, editing and saving", () => {
	const globalDir = join(tempRoot, "view-global-2");
	const projectDir = join(tempRoot, "view-project-2");
	const manager = new SddProfileManager({ globalDir, projectDir });

	let renderCount = 0;
	let activatedProfile: Profile | undefined;
	let closedWith: unknown;

	const view = new SddProfilesView({
		manager,
		availableModels: ["anthropic/claude-sonnet-4-5", "openai/o3-mini", "google/gemini-2.5-pro"],
		theme: plainTheme,
		onProfileActivated: (p) => { activatedProfile = p; },
		onClose: (res) => { closedWith = res; },
		requestRender: () => { renderCount += 1; },
	});

	// 1. Press 'n' to switch to create-profile view
	view.handleInput("n");
	let rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("Nuevo Perfil SDD"));

	// 2. Type profile name and enter (advances to step 2: description)
	for (const char of "auto-test-profile") {
		view.handleInput(char);
	}
	view.handleInput("\r"); // Enter to submit name

	// Verify step 2 (description) is shown
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("Paso 2: Descripción"));

	// Type description and submit
	for (const char of "Test custom description") {
		view.handleInput(char);
	}
	view.handleInput("\r"); // Enter to submit description and create

	// Should transition into profile-editor
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("editando: auto-test-profile"));

	// 3. Select orchestrator (item index 0) and press enter to open model-picker
	view.handleInput("\r");
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("Seleccionar modelo para: Orquestador (default)"));

	// 4. In model-picker, filter by typing 'gemini'
	for (const char of "gemini") {
		view.handleInput(char);
	}
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("google/gemini-2.5-pro"));

	// 5. Select model with enter -> transitions to effort-picker
	view.handleInput("\r");
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("Nivel de Razonamiento"));

	// 6. Select effort (down down -> low) and enter -> returns to profile-editor
	view.handleInput("\u001b[B"); // down
	view.handleInput("\u001b[B"); // down
	view.handleInput("\r"); // enter

	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("editando: auto-test-profile"));
	assert.ok(rendered.includes("google/gemini-2.5-pro"));

	// 7. Save profile by pressing 's'
	view.handleInput("s");
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("Perfil \"auto-test-profile\" guardado"));

	const saved = manager.loadProfile("auto-test-profile");
	assert.ok(saved);
	assert.equal(saved?.default_model, "google/gemini-2.5-pro");

	// 8. Press enter on the list to activate the profile (stays open in modal, shows feedback)
	view.handleInput("\r");
	assert.equal(activatedProfile?.name, "auto-test-profile");
	rendered = view.render(80).join("\n");
	assert.ok(rendered.includes("auto-test-profile"));
	assert.ok(rendered.includes("activado"));
	assert.equal(closedWith, undefined, "Modal should remain open after activation");

	// 9. Press esc to close when done
	view.handleInput("\u001b");
	assert.deepEqual(closedWith, { action: "closed" });
	assert.ok(renderCount > 5);
});

test("sddProfilesExtension registers commands, shortcuts and tools", async () => {
	const registeredCommands: Record<string, { description: string; handler: Function }> = {};
	const registeredShortcuts: Record<string, { description: string; handler: Function }> = {};
	const registeredTools: Record<string, { description: string; execute: Function }> = {};
	const listeners: Record<string, Function> = {};

	const fakePi: any = {
		registerCommand(name: string, def: any) {
			registeredCommands[name] = def;
		},
		registerShortcut(key: string, def: any) {
			registeredShortcuts[key] = def;
		},
		registerTool(def: any) {
			registeredTools[def.name] = def;
		},
		on(event: string, handler: Function) {
			listeners[event] = handler;
		},
	};

	sddProfilesExtension(fakePi);

	// Verify command registration
	assert.ok(registeredCommands[SDD_PROFILES_COMMAND]);
	assert.ok(registeredCommands["sdd-profile-list"]);
	assert.ok(registeredCommands["sdd-profile-save"]);
	assert.ok(registeredCommands["sdd-profile-rename"]);
	assert.ok(registeredCommands["sdd-profile-delete"]);

	// Verify shortcut registration
	assert.ok(registeredShortcuts[SDD_PROFILES_SHORTCUT]);

	// Verify tools registration
	assert.ok(registeredTools["sdd_profile_list"]);
	assert.ok(registeredTools["sdd_profile_switch"]);
	assert.ok(registeredTools["sdd_profile_rename"]);
	assert.ok(registeredTools["sdd_profile_delete"]);

	// Test tool sdd_profile_list execution
	const globalDir = join(tempRoot, "ext-global");
	const projectDir = join(tempRoot, "ext-project");
	const fakeCtx: any = {
		sessionManager: { getCwd: () => projectDir },
		cwd: projectDir,
		globalDir,
	};

	const listResult = await registeredTools["sdd_profile_list"].execute("id1", {}, null, null, fakeCtx);
	assert.ok(listResult.content?.[0]?.text);
	const parsedList = JSON.parse(listResult.content[0].text);
	assert.ok(Array.isArray(parsedList.profiles));
	assert.ok(parsedList.profiles.length > 0);

	// Test tool sdd_profile_switch execution
	const switchResult = await registeredTools["sdd_profile_switch"].execute(
		"id2",
		{ profile_name: "balanced-default" },
		null,
		null,
		fakeCtx,
	);
	assert.ok(switchResult.content?.[0]?.text);
	const parsedSwitch = JSON.parse(switchResult.content[0].text);
	assert.equal(parsedSwitch.success, true);
	assert.equal(parsedSwitch.active_profile, "balanced-default");

	// Test tool sdd_profile_delete blocks active profile
	const blockedToolDelete = await registeredTools["sdd_profile_delete"].execute(
		"id3",
		{ profile_name: "balanced-default" },
		null,
		null,
		fakeCtx,
	);
	assert.ok(blockedToolDelete.content?.[0]?.text);
	const parsedBlocked = JSON.parse(blockedToolDelete.content[0].text);
	assert.equal(parsedBlocked.success, false);
	assert.ok(parsedBlocked.message.includes("No se puede eliminar el perfil activo"));

	// Test command execution for /sdd-profile list
	const cmdOutput = await registeredCommands[SDD_PROFILES_COMMAND].handler("list", fakeCtx);
	assert.ok(typeof cmdOutput === "string");
	assert.ok(cmdOutput.includes("balanced-default"));
});
