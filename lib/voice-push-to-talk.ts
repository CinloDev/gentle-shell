import { isKeyRelease } from "@earendil-works/pi-tui";

// Hold-Space detection for push-to-talk dictation (S1). With Pi's keyboard
// flags a terminal reports Space as plain text and never reports its release,
// so a hold is recognized from OS key auto-repeat, and a release from a gap in
// that repeat.
//
// Pi's input listeners can consume a chunk or replace it, but cannot inject
// input later, so a held-back space could never be typed again exactly as the
// user typed it. Every space therefore goes to the editor untouched: a tap, a
// double space or a space followed by a letter types exactly as without this
// feature. Only after `holdRepeats` auto-repeats, each verified to have added
// exactly one space to the draft, is a hold confirmed. The following repeats
// are then rewritten into Backspace, through the editor's own key path, until
// the spaces the hold typed are gone, and later repeats are consumed. A draft
// that changes in any other way (Vim NORMAL mode, where Space is a motion;
// autocomplete; another key) stops the run or the erase and never removes
// anything else.

export const PUSH_TO_TALK_DEFAULTS = Object.freeze({
	// Longest wait from the first space to its first auto-repeat.
	tapWindowMs: 500,
	// Longest wait between auto-repeats; a longer gap means Space is released.
	releaseGapMs: 200,
	// Auto-repeats that confirm a hold. One would also match a fast deliberate
	// double space.
	holdRepeats: 2,
});

export interface PushToTalkTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface PushToTalkOptions {
	tapWindowMs?: number;
	releaseGapMs?: number;
	holdRepeats?: number;
	timers?: PushToTalkTimers;
}

export interface PushToTalkHandlers {
	// The current editor draft, read before the chunk reaches the editor.
	readDraft(): string;
	// A hold was detected; returns true when a dictation started. While it
	// returns false the spaces keep typing and the next repeat asks again.
	onHold(): boolean;
	// Space was released after a started hold.
	onRelease(): void;
}

export type PushToTalkInputResult = { consume?: boolean; data?: string } | undefined;

const SPACE = " ";
const BACKSPACE = "\x7f";

// True when `after` is `before` with exactly `count` spaces inserted at one place.
export function addedSpaces(before: string, after: string, count: number): boolean {
	if (after.length !== before.length + count) return false;
	let index = 0;
	while (index < before.length && before[index] === after[index]) index++;
	return after.slice(index, index + count) === SPACE.repeat(count) && after.slice(index + count) === before.slice(index);
}

type Phase =
	| { kind: "idle" }
	// Spaces typed so far in this press, verified against the draft before it.
	| { kind: "run"; before: string; typed: number; repeats: number }
	// This press is not a hold; its spaces pass until a gap or another key.
	| { kind: "spoiled" }
	| { kind: "holding"; before: string; erase: number };

const IDLE: Phase = { kind: "idle" };

export class SpaceHoldDetector {
	private phase: Phase = IDLE;
	private timer: unknown;
	private disposed = false;
	private readonly handlers: PushToTalkHandlers;
	private readonly tapWindowMs: number;
	private readonly releaseGapMs: number;
	private readonly holdRepeats: number;
	private readonly timers: PushToTalkTimers;

	constructor(handlers: PushToTalkHandlers, options: PushToTalkOptions = {}) {
		this.handlers = handlers;
		this.tapWindowMs = options.tapWindowMs ?? PUSH_TO_TALK_DEFAULTS.tapWindowMs;
		this.releaseGapMs = options.releaseGapMs ?? PUSH_TO_TALK_DEFAULTS.releaseGapMs;
		this.holdRepeats = Math.max(1, options.holdRepeats ?? PUSH_TO_TALK_DEFAULTS.holdRepeats);
		this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
	}

	get holding(): boolean {
		return this.phase.kind === "holding";
	}

	handleInput(data: string): PushToTalkInputResult {
		if (this.disposed || isKeyRelease(data)) return undefined;
		if (data !== SPACE) {
			if (this.phase.kind === "holding") this.phase.erase = 0;
			else this.reset();
			return undefined;
		}
		const phase = this.phase;
		switch (phase.kind) {
			case "idle": {
				const before = this.draft();
				if (before === undefined) return this.spoil();
				this.phase = { kind: "run", before, typed: 1, repeats: 0 };
				this.schedule(this.tapWindowMs, () => this.reset());
				return undefined;
			}
			case "spoiled":
				return this.spoil();
			case "run": {
				const draft = this.draft();
				if (draft === undefined || !addedSpaces(phase.before, draft, phase.typed)) return this.spoil();
				phase.repeats++;
				if (phase.repeats >= this.holdRepeats && this.askHold()) {
					this.phase = { kind: "holding", before: phase.before, erase: phase.typed };
					return this.whileHolding();
				}
				if (this.disposed) return undefined;
				phase.typed++;
				this.schedule(this.releaseGapMs, () => this.reset());
				return undefined;
			}
			case "holding":
				return this.whileHolding();
		}
	}

	// Leaves a hold (or a run) without reporting a release.
	end(): void {
		this.reset();
	}

	dispose(): void {
		this.reset();
		this.disposed = true;
	}

	private whileHolding(): PushToTalkInputResult {
		const phase = this.phase;
		if (phase.kind !== "holding") return undefined;
		this.schedule(this.releaseGapMs, () => this.release());
		const draft = this.draft();
		if (phase.erase > 0 && draft !== undefined && addedSpaces(phase.before, draft, phase.erase)) {
			phase.erase--;
			return { data: BACKSPACE };
		}
		phase.erase = 0;
		return { consume: true };
	}

	private spoil(): PushToTalkInputResult {
		this.phase = { kind: "spoiled" };
		this.schedule(this.releaseGapMs, () => this.reset());
		return undefined;
	}

	private release(): void {
		this.timer = undefined;
		this.phase = IDLE;
		try {
			this.handlers.onRelease();
		} catch {
			/* the owner reports its own failures */
		}
	}

	private askHold(): boolean {
		try {
			return this.handlers.onHold() === true;
		} catch {
			return false;
		}
	}

	private draft(): string | undefined {
		try {
			return this.handlers.readDraft();
		} catch {
			return undefined;
		}
	}

	private schedule(ms: number, callback: () => void): void {
		this.clear();
		if (this.disposed) return;
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			callback();
		}, ms);
	}

	private clear(): void {
		if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private reset(): void {
		this.clear();
		this.phase = IDLE;
	}
}
