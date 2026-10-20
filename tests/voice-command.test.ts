import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import gentleVoice from "../extensions/gentle-voice.ts";
import { VoiceInstallError, type VoiceInstallProgress, type VoiceInstallResult } from "../lib/voice-install.ts";
import { VoiceSessionError, type VoiceSessionState, type VoiceTranscript } from "../lib/voice-session.ts";
import { VOICE_COMMAND_NAME, type VoiceCommandDeps, type VoiceDictation } from "../lib/voice-command.ts";

// /gentle:voice through its registered command, with fake UI, acquisition and
// session adapters: nothing here downloads, loads native code or opens a
// microphone.

type Handler = (event: unknown, ctx: unknown) => unknown;
type Component = { render(width: number): string[]; handleInput?(data: string): void };

// A broken lifecycle shows up as a hang; fail it instead of waiting forever.
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 5_000 }, fn);

const ENTER = "\r";
const ESC = "\x1b";
const VOICE_HOME = "/home/user/.pi/gentle-ai/voice";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, attempts = 200) {
	for (let attempt = 0; attempt < attempts && !check(); attempt++) await tick();
	assert.ok(check(), "condition not reached");
}

function fakePi() {
	const commands = new Map<string, { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const counts = { tools: 0, sends: 0 };
	const pi = {
		registerCommand: (name: string, registration: { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, registration),
		registerTool: () => { counts.tools++; },
		registerShortcut: () => { counts.tools++; },
		sendUserMessage: () => { counts.sends++; },
		sendMessage: () => { counts.sends++; },
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { pi, commands, handlers, counts, fire };
}

interface UiScript {
	select?: (title: string, options: string[]) => string | undefined;
	confirm?: (title: string, message: string) => boolean;
}

function fakeContext(script: UiScript = {}, mode = "tui", hasUI = true) {
	const notices: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const events: string[] = [];
	const renders: Array<boolean | undefined> = [];
	let editor = "draft: ";
	let component: Component | undefined;
	let open = false;
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: (force?: boolean) => renders.push(force) };
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI,
		mode,
		cwd: "/work/alpha",
		ui: {
			notify: (message: string, type?: string) => { notices.push({ message, type }); events.push(`notify:${message}`); },
			select: async (title: string, options: string[]) => { selects.push({ title, options }); return script.select?.(title, options); },
			confirm: async (title: string, message: string) => { confirms.push({ title, message }); return script.confirm?.(title, message) ?? false; },
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component) =>
				new Promise((resolve) => {
					open = true;
					events.push("open");
					component = factory(tui, theme, {}, (value) => { open = false; events.push("close"); resolve(value); });
				}),
			pasteToEditor: (text: string) => { editor += text; events.push(`paste:${text}`); },
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices, selects, confirms, events, renders, editor: () => editor, component: () => component, open: () => open };
}

class FakeSession implements VoiceDictation {
	state: VoiceSessionState = "idle";
	readonly calls: string[] = [];
	readonly started = deferred<void>();
	readonly result = deferred<VoiceTranscript>();
	readonly onStateChange: (state: VoiceSessionState) => void;
	constructor(onStateChange: (state: VoiceSessionState) => void) {
		this.onStateChange = onStateChange;
		this.result.promise.catch(() => {});
	}
	emit(state: VoiceSessionState) {
		this.state = state;
		this.onStateChange(state);
	}
	async start() {
		this.calls.push("start");
		this.emit("starting");
		await this.started.promise;
		this.emit("recording");
	}
	async stop() {
		this.calls.push("stop");
		if (this.state === "recording") this.emit("transcribing");
		const transcript = await this.result.promise;
		this.emit("finished");
		return transcript;
	}
	async cancel() {
		this.calls.push("cancel");
		this.emit("finished");
	}
}

interface Harness {
	deps: VoiceCommandDeps;
	calls: string[];
	sessions: FakeSession[];
	installs: Array<{ kind: string; options: Record<string, unknown> }>;
}

function harness(overrides: { platform?: string; arch?: string; installed?: boolean; install?: (kind: "runtime" | "model", options: { signal: AbortSignal; onProgress(progress: VoiceInstallProgress): void }) => Promise<VoiceInstallResult>; env?: NodeJS.ProcessEnv } = {}): Harness {
	const calls: string[] = [];
	const sessions: FakeSession[] = [];
	const installs: Harness["installs"] = [];
	const state = overrides.installed ? "installed" : "missing";
	const install = overrides.install ?? (async (kind) => ({ kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false }));
	const deps: VoiceCommandDeps = {
		env: overrides.env ?? {},
		probe: () => { calls.push("probe"); return { platform: overrides.platform ?? "darwin", arch: overrides.arch ?? "arm64" }; },
		readStatus: async (target) => {
			calls.push(`status:${target}`);
			return { voiceHome: VOICE_HOME, model: { kind: "model", state, path: `${VOICE_HOME}/models/m` }, runtime: { kind: "runtime", state, path: `${VOICE_HOME}/runtime/r` } };
		},
		installRuntime: async (options) => { calls.push("install:runtime"); installs.push({ kind: "runtime", options: options as unknown as Record<string, unknown> }); return install("runtime", options); },
		installModel: async (options) => { calls.push("install:model"); installs.push({ kind: "model", options: options as unknown as Record<string, unknown> }); return install("model", options); },
		createSession: (options) => {
			calls.push(`session:${options.target}`);
			const session = new FakeSession(options.onStateChange);
			sessions.push(session);
			return session;
		},
	};
	return { deps, calls, sessions, installs };
}

const pick = (pattern: RegExp) => (_title: string, options: string[]) => options.find((option) => pattern.test(option));

function register(h: Harness) {
	const pi = fakePi();
	gentleVoice(pi.pi, h.deps);
	return pi;
}

async function run(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	return pi.commands.get(VOICE_COMMAND_NAME)!.handler("", ui.ctx);
}

// --- registration and refusals ------------------------------------------------

test("registers only /gentle:voice and does no voice work at registration or session start", async () => {
	const h = harness();
	const pi = register(h);
	assert.equal(VOICE_COMMAND_NAME, "gentle:voice");
	assert.deepEqual([...pi.commands.keys()], ["gentle:voice"]);
	assert.match(pi.commands.get(VOICE_COMMAND_NAME)!.description, /dictation/i);
	assert.equal(pi.counts.tools, 0, "no model-callable tool or shortcut");
	await pi.fire("session_start");
	assert.deepEqual(h.calls, []);
});

test("a delegated child session refuses before any probe, status read or UI", async () => {
	const h = harness({ env: { GENTLE_PI_AGENTS_CHILD: "1" }, installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/dictat/i) });
	await run(pi, ui);
	assert.deepEqual(h.calls, []);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /delegated/i);
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
});

test("non-TUI modes refuse without voice work", async () => {
	for (const [mode, hasUI] of [["rpc", true], ["print", false]] as const) {
		const h = harness({ installed: true });
		const pi = register(h);
		const ui = fakeContext({ select: pick(/dictat/i) }, mode, hasUI);
		await run(pi, ui);
		assert.deepEqual(h.calls, [], mode);
		assert.equal(ui.selects.length, 0, mode);
		assert.equal(ui.editor(), "draft: ", mode);
	}
});

test("an unsupported platform is explained and offers no download", async () => {
	const h = harness({ platform: "win32", arch: "arm64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	assert.deepEqual(h.calls, ["probe"]);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /Windows ARM64/);
	assert.equal(ui.notices[0]!.type, "error");
});

// --- installation -------------------------------------------------------------

test("a missing install offers the download and declining it downloads nothing", async () => {
	const h = harness({ platform: "win32", arch: "x64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => false });
	await run(pi, ui);
	assert.ok(!ui.selects[0]!.options.some((option) => /start dictation/i.test(option)), "dictation needs an install first");
	const { message } = ui.confirms[0]!;
	assert.match(message, /MB/);
	assert.ok(message.includes(VOICE_HOME), "names the destination");
	assert.match(message, /CC-BY-4\.0/);
	assert.match(message, /NVIDIA/);
	assert.match(message, /Apache-2\.0/);
	assert.match(message, /Visual C\+\+/);
	assert.match(message, /not .*installed by Gentle AI|never (downloads|installs)/i);
	assert.ok(!h.calls.some((call) => call.startsWith("install:")));
	assert.equal(ui.editor(), "draft: ");
});

test("an accepted download installs runtime then model with progress and pinned defaults", async () => {
	const gate = deferred<void>();
	const h = harness({
		install: async (kind, options) => {
			options.onProgress({ component: kind, phase: "download", item: kind === "model" ? "encoder.int8.onnx" : "node-cpal", receivedBytes: 50, totalBytes: 100, overallReceivedBytes: 50, overallTotalBytes: 100 });
			if (kind === "model") await gate.promise;
			return { kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false };
		},
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:model"));
	assert.ok(ui.open());
	const screen = ui.component()!.render(80).join("\n");
	assert.match(screen, /50%/);
	assert.match(screen, /encoder\.int8\.onnx/);
	assert.match(screen, /esc/i);
	gate.resolve();
	await done;
	assert.deepEqual(h.calls.filter((call) => call.startsWith("install:")), ["install:runtime", "install:model"]);
	for (const install of h.installs) {
		assert.ok(install.options.signal instanceof AbortSignal);
		for (const key of ["manifest", "manifests", "fetch"]) assert.equal(key in install.options, false, `${install.kind} gets no ${key} override`);
	}
	assert.equal(h.installs[0]!.options.target, "darwin-arm64");
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /installed/i);
	assert.equal(ui.editor(), "draft: ");
});

test("Esc during a download aborts it and keeps nothing", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "raw /secret/path")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!h.calls.includes("install:model"));
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	assert.ok(!ui.notices.some((notice) => notice.message.includes("/secret/path")), "fixed messages only");
});

test("a failed download reports a fixed message without raw error text", async () => {
	const h = harness({ install: async () => { throw new VoiceInstallError("integrity", "encoder at /home/user/x does not match"); } });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /digest|verif/i);
	assert.ok(!last.message.includes("/home/user/x"));
	assert.ok(!ui.open());
});

// --- dictation ----------------------------------------------------------------

async function startDictation(h: Harness, pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1 && ui.open());
	const session = h.sessions[0]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	return { done, session };
}

test("Enter stops recording, closes the overlay and pastes the exact transcript into the draft", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	assert.match(ui.component()!.render(80).join("\n"), /recording/i);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.component()!.render(80).join("\n"), /transcrib/i);
	assert.ok(ui.open(), "stays open until the transcript settles");
	session.result.resolve({ text: "hola canción", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: hola canción");
	assert.ok(ui.events.indexOf("close") < ui.events.indexOf("paste:hola canción"), "closes before pasting");
	assert.equal(pi.counts.sends, 0, "never submits");
	assert.deepEqual(session.calls, ["start", "stop"]);
});

test("Esc while recording cancels the session and leaves the draft untouched", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ESC);
	await done;
	session.result.resolve({ text: "late text", truncated: false });
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});

test("the recording limit transcribes by itself and delivers without a key press", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	session.emit("transcribing");
	session.result.resolve({ text: "limit reached", truncated: true });
	session.emit("finished");
	await done;
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: limit reached");
	assert.match(ui.notices.map((notice) => notice.message).join("\n"), /limit/i);
});

test("a session failure shows its fixed message with a user action and pastes nothing", async () => {
	const h = harness({ installed: true, platform: "linux", arch: "x64" });
	h.deps.probe = () => ({ platform: "linux", arch: "x64", glibcVersion: "2.39" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.reject(new VoiceSessionError("runtime-load"));
	await done;
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /could not be loaded/);
	assert.match(last.message, /libasound|ALSA/);
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
});

test("a second /gentle:voice while one is active is refused with a notice", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	const second = fakeContext({ select: pick(/start dictation/i) });
	await run(pi, second);
	assert.equal(h.sessions.length, 1, "no parallel session");
	assert.match(second.notices[0]!.message, /already/i);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
	// The lock is released once the first run settles.
	const third = fakeContext({ select: () => undefined });
	await run(pi, third);
	assert.equal(third.selects.length, 1);
});

test("session shutdown cancels an active dictation and drops a late transcript", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	await pi.fire("session_shutdown");
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	// The state observer stays safe after teardown.
	assert.doesNotThrow(() => session.onStateChange("finished"));
});

test("session shutdown aborts an active download", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "cancelled")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	await pi.fire("session_shutdown");
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!ui.open());
	assert.ok(!h.calls.includes("install:model"));
});

test("status reports the target, both components and the unverified hardware state", async () => {
	const h = harness({ platform: "linux", arch: "arm64" });
	h.deps.probe = () => ({ platform: "linux", arch: "arm64", glibcVersion: "2.35", wsl: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/status/i) });
	await run(pi, ui);
	const message = ui.notices.at(-1)!.message;
	assert.match(message, /linux-arm64/);
	assert.match(message, /unproven/i);
	assert.match(message, /model: missing/i);
	assert.match(message, /runtime: missing/i);
	assert.match(message, /not been verified on hardware/);
	assert.match(message, /libasound/);
	assert.ok(!h.calls.some((call) => call.startsWith("install:") || call.startsWith("session:")));
});

test("a transcript that arrives while cancelling is dropped", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	// As with the real worker, the result line can land before the process closes.
	session.cancel = async () => {
		session.calls.push("cancel");
		session.result.resolve({ text: "raced", truncated: false });
		await tick();
		session.emit("finished");
	};
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal(ui.editor(), "draft: ");
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});
