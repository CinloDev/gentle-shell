import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { PARAKEET_MODEL_MANIFEST, VOICE_NOTICES, voiceRuntimeManifest, type VoiceTarget } from "./voice-artifacts.ts";
import { installVoiceModel, installVoiceRuntime, readVoiceStatus, VoiceInstallError, type VoiceComponentStatus, type VoiceInstallErrorCode, type VoiceInstallProgress, type VoiceInstallResult } from "./voice-install.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe, type VoicePlatformDiagnosis, type VoicePlatformProbe } from "./voice-platform.ts";
import { createVoiceSession, VoiceSessionError, type VoiceSessionErrorCode, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";
import { VoiceDictationView, VoiceProgressView, type VoiceViewTheme } from "./voice-ui.ts";

// /gentle:voice (S1-S3): the only entry point to optional local dictation. It
// shows status, downloads the pinned runtime and model after an explicit
// confirmation, and records one dictation whose transcript is pasted into the
// editor draft, never submitted. Registration does nothing else: the platform
// probe, status reads, downloads and the worker all start from the command, in
// an interactive parent session only. One install or dictation runs at a time.

export const VOICE_COMMAND_NAME = "gentle:voice";

// The part of VoiceSession the command drives.
export interface VoiceDictation {
	readonly state: VoiceSessionState;
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

export interface VoiceStatusSnapshot {
	voiceHome: string;
	model: VoiceComponentStatus;
	runtime?: VoiceComponentStatus;
}

interface VoiceInstallRequest {
	signal: AbortSignal;
	onProgress(progress: VoiceInstallProgress): void;
}

export interface VoiceCommandDeps {
	env?: NodeJS.ProcessEnv;
	probe?: () => VoicePlatformProbe;
	readStatus?: (target: VoiceTarget) => Promise<VoiceStatusSnapshot>;
	installRuntime?: (options: VoiceInstallRequest & { target: VoiceTarget }) => Promise<VoiceInstallResult>;
	installModel?: (options: VoiceInstallRequest) => Promise<VoiceInstallResult>;
	createSession?: (options: { target: VoiceTarget; onStateChange(state: VoiceSessionState): void }) => VoiceDictation;
}

const MB = 1_000_000;
const OVERLAY = { overlay: true, overlayOptions: { anchor: "center", width: "60%", minWidth: 44 } } as const;

const START = "Start dictation";
const STATUS = "Show status and notices";

const INSTALL_MESSAGES: Record<VoiceInstallErrorCode, string> = {
	aborted: "Voice download was cancelled. Unfinished files were removed; completed components are kept.",
	timeout: "Voice download timed out. Check the network connection and try again.",
	http: "The download server answered with an error. Try again later.",
	redirect: "The download was redirected to an unexpected location and was refused.",
	size: "A downloaded file did not match its pinned size or digest and was discarded.",
	integrity: "A downloaded file did not match its pinned size or digest and was discarded.",
	archive: "A downloaded runtime package failed validation and was discarded.",
	unsupported: "Voice dictation has no pinned runtime for this platform.",
	io: "Voice files could not be written to the voice directory. Check its permissions and free space.",
};

// What the user can do about a session failure, by platform where it differs.
// Gentle AI never runs an installer for any of these.
function sessionAction(code: VoiceSessionErrorCode, platform: string): string | undefined {
	switch (code) {
		case "not-installed":
		case "runtime-invalid":
		case "model-invalid":
			return "Run /gentle:voice and download it again.";
		case "runtime-load":
			if (platform === "linux") return "Install the ALSA library (libasound.so.2, for example the libasound2 or alsa-lib package), then try again.";
			if (platform === "win32") return "Install the Microsoft Visual C++ Redistributable (x64) from Microsoft, then try again.";
			return "Loading has not been verified on hardware for this target.";
		case "no-input-device":
			return "Connect a microphone or choose a default input device, then try again.";
		case "capture":
			return platform === "darwin"
				? "Allow microphone access for this terminal in System Settings > Privacy & Security > Microphone, then try again."
				: "Check that the default microphone is available, then try again.";
		case "node-version":
			return "Run Gentle AI with Node 22 or newer.";
		case "empty-audio":
		case "no-speech":
			return "Speak after recording starts, then press Enter.";
		default:
			return undefined;
	}
}

function sessionErrorMessage(error: unknown, platform: string): string {
	if (!(error instanceof VoiceSessionError)) return "Voice dictation failed.";
	const action = sessionAction(error.code, platform);
	return action ? `${error.message} ${action}` : error.message;
}

const PREREQUISITE_ACTIONS: Partial<Record<string, string>> = {
	linux: "Gentle AI never installs system libraries; install ALSA with your package manager if loading fails.",
	win32: "Gentle AI never installs the Visual C++ runtime; install it from Microsoft if loading fails.",
};

const runtimeBytes = (target: VoiceTarget) => voiceRuntimeManifest(target).packages.reduce((sum, pkg) => sum + pkg.size, 0);
const modelBytes = () => PARAKEET_MODEL_MANIFEST.files.reduce((sum, file) => sum + file.size, 0);
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

function noticeLines(): string[] {
	return VOICE_NOTICES.flatMap((notice) => [`- ${notice.attribution ?? `${notice.component}: ${notice.license}.`} Source: ${notice.source}`, ...(notice.unresolved ? [`  ${notice.unresolved}`] : [])]);
}

function limitationLines(diagnosis: VoicePlatformDiagnosis, platform: string): string[] {
	const action = PREREQUISITE_ACTIONS[platform];
	return [...diagnosis.limitations, ...(action ? [action] : [])].map((line) => `- ${line}`);
}

const describe = (status: VoiceComponentStatus | undefined) => (!status ? "unknown" : status.state === "invalid" && status.reason ? `invalid (${status.reason})` : status.state);

function statusReport(target: VoiceTarget, diagnosis: VoicePlatformDiagnosis, status: VoiceStatusSnapshot, platform: string): string {
	return [
		"Voice dictation status",
		`Target: ${target} (${diagnosis.support})`,
		`Voice home: ${status.voiceHome}`,
		`Model: ${describe(status.model)}`,
		`Runtime: ${describe(status.runtime)}`,
		"Limitations:",
		...limitationLines(diagnosis, platform),
		"Licenses and attribution:",
		...noticeLines(),
	].join("\n");
}

interface Overlay<V> {
	view(): V | undefined;
	tui(): TUI | undefined;
	// Closes once, whether or not the factory has run yet; resolves when closed.
	close(): Promise<void>;
}

function openOverlay<V extends Component & { dispose(): void }>(ctx: ExtensionCommandContext, make: (theme: VoiceViewTheme, requestRender: () => void) => V): Overlay<V> {
	let view: V | undefined;
	let tui: TUI | undefined;
	let finish: ((value: undefined) => void) | undefined;
	let closing = false;
	const closed = ctx.ui
		.custom<undefined>((t, theme, _keybindings, done) => {
			tui = t;
			finish = withOverlayRepaint(t, done);
			view = make(theme as VoiceViewTheme, () => t.requestRender());
			if (closing) queueMicrotask(() => finish?.(undefined));
			return view;
		}, OVERLAY)
		.catch(() => undefined)
		.finally(() => view?.dispose());
	return {
		view: () => view,
		tui: () => tui,
		close: () => {
			if (!closing) {
				closing = true;
				view?.dispose();
				finish?.(undefined);
			}
			return closed.then(() => undefined);
		},
	};
}

interface Run {
	generation: number;
	abort(): void;
}

export function registerVoiceCommand(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	const env = deps.env ?? process.env;
	const probe = deps.probe ?? readVoicePlatformProbe;
	const readStatus = deps.readStatus ?? ((target) => readVoiceStatus({ env, target }));
	// Production always installs and runs the pinned manifests: no manifest or
	// fetch override is ever passed from here.
	const installRuntime = deps.installRuntime ?? (({ target, signal, onProgress }) => installVoiceRuntime({ env, target, signal, onProgress }));
	const installModel = deps.installModel ?? (({ signal, onProgress }) => installVoiceModel({ env, signal, onProgress }));
	const createSession = deps.createSession ?? (({ target, onStateChange }) => createVoiceSession({ env, target, onStateChange }));
	let generation = 0;
	let active: Run | undefined;

	const command = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") {
			if (ctx.hasUI) ctx.ui.notify("Voice dictation is not available in delegated sessions.", "warning");
			return;
		}
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Voice dictation requires TUI mode.", "warning");
			return;
		}
		if (active) {
			ctx.ui.notify("Voice dictation is already running. Finish or cancel it first.", "warning");
			return;
		}
		const run: Run = { generation, abort: () => {} };
		active = run;
		try {
			await workflow(ctx, run);
		} catch {
			if (run.generation === generation) ctx.ui.notify("Voice dictation failed.", "error");
		} finally {
			if (active === run) active = undefined;
		}
	};

	const workflow = async (ctx: ExtensionCommandContext, run: Run): Promise<void> => {
		// After a session shutdown the old context is stale: say and paste nothing.
		const live = () => run.generation === generation;
		const say = (message: string, type: "info" | "warning" | "error") => {
			if (live()) ctx.ui.notify(message, type);
		};
		const platform = probe();
		const diagnosis = diagnoseVoicePlatform(platform);
		if (diagnosis.support === "unsupported" || !diagnosis.target) {
			say(diagnosis.limitations[0] ?? "Voice dictation is not supported on this platform.", "error");
			return;
		}
		const target = diagnosis.target;
		const status = await readStatus(target);
		if (!live()) return;
		const runtimeMissing = status.runtime?.state !== "installed";
		const modelMissing = status.model.state !== "installed";
		const pending = (runtimeMissing ? runtimeBytes(target) : 0) + (modelMissing ? modelBytes() : 0);
		const download = `Download voice dictation (about ${megabytes(pending)})`;
		const ready = !runtimeMissing && !modelMissing;
		const choice = await ctx.ui.select(ready ? "Voice dictation · ready" : "Voice dictation · not installed", ready ? [START, STATUS] : [download, STATUS]);
		if (!live() || !choice) return;
		if (choice === STATUS) say(statusReport(target, diagnosis, status, platform.platform), "info");
		else if (choice === download) await install(ctx, run, { target, diagnosis, status, platform: platform.platform, runtimeMissing, modelMissing }, say);
		else if (choice === START) await dictate(ctx, run, target, platform.platform, say);
	};

	const install = async (
		ctx: ExtensionCommandContext,
		run: Run,
		plan: { target: VoiceTarget; diagnosis: VoicePlatformDiagnosis; status: VoiceStatusSnapshot; platform: string; runtimeMissing: boolean; modelMissing: boolean },
		say: (message: string, type: "info" | "warning" | "error") => void,
	): Promise<void> => {
		const items = [
			...(plan.runtimeMissing ? [`- Voice runtime for ${plan.target} (sherpa-onnx, node-cpal) from the npm registry: ${megabytes(runtimeBytes(plan.target))}`] : []),
			...(plan.modelMissing ? [`- Parakeet TDT 0.6B v3 int8 model from Hugging Face: ${megabytes(modelBytes())}`] : []),
		];
		const message = [
			`Downloads into ${plan.status.voiceHome}:`,
			...items,
			"Every file is checked against its pinned size and digest. Nothing downloaded is loaded or run during the download.",
			"Licenses and attribution:",
			...noticeLines(),
			"Limitations:",
			...limitationLines(plan.diagnosis, plan.platform),
		].join("\n");
		if (!(await ctx.ui.confirm("Download voice dictation?", message))) {
			say("Voice download skipped; nothing was downloaded.", "info");
			return;
		}
		if (run.generation !== generation) return;
		const controller = new AbortController();
		run.abort = () => controller.abort();
		const overlay = openOverlay(ctx, (theme, requestRender) => new VoiceProgressView({ theme, requestRender, onCancel: () => controller.abort() }));
		const onProgress = (progress: VoiceInstallProgress) => overlay.view()?.update(progress);
		let failure: unknown;
		try {
			if (plan.runtimeMissing) await installRuntime({ target: plan.target, signal: controller.signal, onProgress });
			if (plan.modelMissing && !controller.signal.aborted) await installModel({ signal: controller.signal, onProgress });
		} catch (error) {
			failure = error;
		} finally {
			run.abort = () => {};
			await overlay.close();
		}
		if (controller.signal.aborted) say(INSTALL_MESSAGES.aborted, "info");
		else if (failure !== undefined) say(failure instanceof VoiceInstallError ? INSTALL_MESSAGES[failure.code] : "Voice download failed.", "error");
		else say("Voice dictation is installed. Run /gentle:voice and choose Start dictation.", "info");
	};

	const dictate = async (ctx: ExtensionCommandContext, run: Run, target: VoiceTarget, platform: string, say: (message: string, type: "info" | "warning" | "error") => void): Promise<void> => {
		type Outcome = { kind: "text"; transcript: VoiceTranscript } | { kind: "cancelled" } | { kind: "error"; error: unknown };
		let settled = false;
		let stopping = false;
		let cancelled = false;
		let resolveOutcome!: (outcome: Outcome) => void;
		const outcome = new Promise<Outcome>((resolve) => { resolveOutcome = resolve; });
		const settle = (value: Outcome) => {
			if (settled) return;
			settled = true;
			resolveOutcome(cancelled ? { kind: "cancelled" } : value);
		};
		let overlay: Overlay<VoiceDictationView> | undefined;
		// stop() and cancel() settle only after the worker has exited.
		const collect = () => {
			if (stopping || cancelled || settled) return;
			stopping = true;
			session.stop().then((transcript) => settle({ kind: "text", transcript }), (error) => settle({ kind: "error", error }));
		};
		const cancel = () => {
			if (cancelled || settled) return;
			cancelled = true;
			session.cancel().catch(() => {}).finally(() => settle({ kind: "cancelled" }));
		};
		// The session calls this synchronously from its own transitions, so it
		// must never throw: a throw there could leave a closing session unsettled.
		const onStateChange = (state: VoiceSessionState) => {
			try {
				overlay?.view()?.setState(state);
				// The recording limit ends capture without a key press.
				if (state === "finished") queueMicrotask(collect);
			} catch {
				/* the observer is advisory */
			}
		};
		const session = createSession({ target, onStateChange });
		run.abort = cancel;
		overlay = openOverlay(ctx, (theme, requestRender) => {
			const view = new VoiceDictationView({ theme, requestRender, onStop: collect, onCancel: cancel });
			// The factory may run after the session has already moved on.
			if (session.state !== "idle") view.setState(session.state);
			return view;
		});
		session.start().catch((error) => settle({ kind: "error", error }));
		const result = await outcome;
		run.abort = () => {};
		const tui = overlay.tui();
		await overlay.close();
		if (run.generation !== generation) return;
		if (result.kind === "cancelled") {
			say("Voice dictation cancelled; the draft is unchanged.", "info");
			return;
		}
		if (result.kind === "error") {
			say(sessionErrorMessage(result.error, platform), "error");
			return;
		}
		const { text, truncated } = result.transcript;
		if (!text.trim()) {
			say("No speech was recognized.", "warning");
			return;
		}
		// The transcript goes through the editor's paste pipeline as is; it is
		// never sent.
		ctx.ui.pasteToEditor(text);
		setTimeout(() => {
			try {
				tui?.requestRender();
			} catch {
				/* best-effort repaint after the overlay teardown */
			}
		}, 0);
		if (truncated) say("Recording reached the 2-minute limit; the transcript covers what was recorded.", "info");
	};

	pi.registerCommand(VOICE_COMMAND_NAME, {
		description: "Local voice dictation with Parakeet: download it once, then record and insert the transcript into the draft (never sent).",
		handler: async (_args, ctx) => command(ctx),
	});
	pi.on("session_shutdown", () => {
		generation++;
		active?.abort();
	});
}
