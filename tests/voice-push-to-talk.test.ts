import assert from "node:assert/strict";
import test from "node:test";
import { Editor, isKeyRelease } from "@earendil-works/pi-tui";
import { PUSH_TO_TALK_DEFAULTS, SpaceHoldDetector, type PushToTalkTimers } from "../lib/voice-push-to-talk.ts";

// Hold-Space detection on raw terminal input. Chunks go through the detector
// and then, as Pi's TUI does, to an editor: a real pi-tui Editor where the
// exact typing path matters, fake editors for Vim NORMAL mode and autocomplete.
// Timers are a manual clock; nothing here records audio.

const BACKSPACE = "\x7f";

function manualClock() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const timers: PushToTalkTimers = {
		setTimeout: (callback, ms) => {
			const id = nextId++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => { pending.delete(handle as number); },
	};
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of pending) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			pending.delete(due[0]);
			now = due[1].at;
			due[1].callback();
		}
		now = target;
	};
	return { timers, advance, pending: () => pending.size };
}

interface Draft {
	text(): string;
	input(data: string): void;
}

function realEditor(text = ""): Draft {
	const editor = new Editor({ terminal: { rows: 24 }, requestRender() {} } as never, { borderColor: (s: string) => s } as never);
	editor.setText(text);
	return { text: () => editor.getText(), input: (data) => editor.handleInput(data) };
}

function setup(draft: Draft, onHold: () => boolean = () => true) {
	const clock = manualClock();
	const calls = { holds: 0, releases: 0 };
	const results: Array<ReturnType<SpaceHoldDetector["handleInput"]>> = [];
	const detector = new SpaceHoldDetector(
		{
			readDraft: () => draft.text(),
			onHold: () => { calls.holds++; return onHold(); },
			onRelease: () => { calls.releases++; },
		},
		{ timers: clock.timers },
	);
	// Mirrors TUI.handleTerminalInput: consume stops the chunk, data replaces
	// it, and key releases never reach the editor.
	const type = (data: string) => {
		const result = detector.handleInput(data);
		results.push(result);
		if (result?.consume) return;
		const forwarded = result?.data ?? data;
		if (!isKeyRelease(forwarded)) draft.input(forwarded);
	};
	// One press of Space held down: the first space, then OS auto-repeats.
	const hold = (repeats: number, delay = 400, interval = 40) => {
		type(" ");
		for (let index = 0; index < repeats; index++) {
			clock.advance(index === 0 ? delay : interval);
			type(" ");
		}
	};
	return { clock, calls, results, detector, type, hold };
}

test("defaults match the documented tap window, release gap and repeat count", () => {
	assert.deepEqual({ ...PUSH_TO_TALK_DEFAULTS }, { tapWindowMs: 500, releaseGapMs: 200, holdRepeats: 2 });
});

test("a tap types exactly one space through the editor's own path and never starts a hold", () => {
	const draft = realEditor("hello");
	const s = setup(draft);
	s.type(" ");
	assert.equal(draft.text(), "hello ", "the space is in the draft immediately");
	s.clock.advance(1_000);
	assert.equal(draft.text(), "hello ");
	assert.deepEqual(s.results, [undefined], "the chunk was passed through untouched");
	assert.equal(s.calls.holds, 0);
	assert.equal(s.clock.pending(), 0, "no timer left behind");
});

test("rollover keeps order: a space followed quickly by a letter yields ' a'", () => {
	const draft = realEditor("x");
	const s = setup(draft);
	s.type(" ");
	s.type("a");
	assert.equal(draft.text(), "x a");
	assert.deepEqual(s.results, [undefined, undefined]);
	assert.equal(s.calls.holds, 0);
});

test("pastes, escape sequences and multi-character chunks pass untouched and break a run", () => {
	const draft = realEditor("");
	const s = setup(draft);
	for (const chunk of ["\x1b[200~ \x1b[201~", "\x1b", "\x1b[A", "  ", "ab", " \r"]) {
		s.type(" ");
		s.clock.advance(40);
		s.type(chunk);
		s.clock.advance(40);
		s.type(" ");
		s.clock.advance(40);
	}
	assert.ok(s.results.every((result) => result === undefined), "nothing consumed or rewritten");
	assert.equal(s.calls.holds, 0);
});

test("a deliberate fast double space is not a hold", () => {
	const draft = realEditor("end.");
	const s = setup(draft);
	s.type(" ");
	s.clock.advance(120);
	s.type(" ");
	s.clock.advance(1_000);
	s.type("N");
	assert.equal(draft.text(), "end.  N");
	assert.equal(s.calls.holds, 0);
});

test("a hold is confirmed after two repeats, erases exactly the spaces it typed, then consumes repeats", () => {
	const draft = realEditor("hello");
	const s = setup(draft);
	s.hold(2);
	assert.equal(s.calls.holds, 1);
	assert.ok(s.detector.holding);
	assert.deepEqual(s.results, [undefined, undefined, { data: BACKSPACE }], "the confirming repeat becomes a Backspace");
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { data: BACKSPACE });
	assert.equal(draft.text(), "hello", "both spaces typed by the hold are gone");
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true });
	assert.equal(draft.text(), "hello");
	assert.equal(s.calls.releases, 0);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.releaseGapMs + 1);
	assert.equal(s.calls.releases, 1, "no repeat for the release gap means Space was released");
	assert.ok(!s.detector.holding);
	assert.equal(s.clock.pending(), 0);
});

test("erasing never removes spaces that were in the draft before the hold", () => {
	const draft = realEditor("hi   ");
	const s = setup(draft);
	s.hold(6);
	s.clock.advance(PUSH_TO_TALK_DEFAULTS.releaseGapMs + 1);
	assert.equal(draft.text(), "hi   ");
	assert.equal(s.results.filter((result) => result?.data === BACKSPACE).length, 2);
});

test("a first repeat later than the tap window does not count as a hold", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(2, PUSH_TO_TALK_DEFAULTS.tapWindowMs + 1);
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined));
});

test("a refused hold keeps typing spaces, and a later start erases every space the hold added", () => {
	const draft = realEditor("ok");
	let allow = false;
	const s = setup(draft, () => allow);
	s.hold(3);
	assert.equal(draft.text(), "ok    ", "refused: four spaces typed normally");
	assert.equal(s.calls.holds, 2);
	allow = true;
	for (let index = 0; index < 6; index++) {
		s.clock.advance(40);
		s.type(" ");
	}
	// Four spaces landed before the start; the starting repeat is the first Backspace.
	assert.equal(draft.text(), "ok");
	assert.equal(s.results.filter((result) => result?.data === BACKSPACE).length, 4);
	assert.deepEqual(s.results.at(-1), { consume: true });
});

test("Vim NORMAL mode: Space moves the cursor without growing the draft, so no hold and no rewrite", () => {
	// A NORMAL-mode editor treats Space and Backspace as motions: the text never changes.
	let cursor = 0;
	const text = "normal mode text";
	const draft: Draft = {
		text: () => text,
		input: (data) => {
			if (data === " ") cursor = Math.min(text.length, cursor + 1);
			else if (data === BACKSPACE) cursor = Math.max(0, cursor - 1);
		},
	};
	const s = setup(draft);
	s.hold(8);
	assert.equal(s.calls.holds, 0);
	assert.ok(s.results.every((result) => result === undefined), "every Space reached the editor unchanged");
	assert.equal(cursor, 9);
});

test("a draft change other than the hold's spaces aborts the run without erasing", () => {
	let text = "@fo";
	const draft: Draft = {
		text: () => text,
		input: (data) => {
			// Autocomplete accepts on the first repeat and rewrites the draft.
			if (data === " ") text = text === "@fo " ? "@foo.ts " : `${text} `;
			else if (data === BACKSPACE) text = text.slice(0, -1);
		},
	};
	const s = setup(draft);
	s.hold(4);
	assert.equal(s.calls.holds, 0);
	assert.ok(!s.results.some((result) => result?.data === BACKSPACE));
});

test("a draft change during erasing stops the erase and keeps the rest of the draft", () => {
	const draft = realEditor("abc");
	const s = setup(draft);
	s.hold(2);
	assert.equal(draft.text(), "abc ");
	draft.input("Z");
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true }, "no Backspace once the draft moved on");
	assert.equal(draft.text(), "abc Z");
});

test("other input during a hold passes through and stops erasing", () => {
	const draft = realEditor("go");
	const s = setup(draft);
	s.hold(2);
	s.type("x");
	assert.equal(s.results.at(-1), undefined);
	s.clock.advance(40);
	s.type(" ");
	assert.deepEqual(s.results.at(-1), { consume: true });
	assert.equal(draft.text(), "go x");
});

test("key release reports are ignored and do not break a run", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.type(" ");
	s.clock.advance(400);
	s.type("\x1b[13;1:3u");
	s.type(" ");
	s.clock.advance(40);
	s.type(" ");
	assert.equal(s.calls.holds, 1);
});

test("end() leaves a hold without a release, and dispose() clears timers and stops listening", () => {
	const draft = realEditor("");
	const s = setup(draft);
	s.hold(3);
	s.detector.end();
	assert.ok(!s.detector.holding);
	s.clock.advance(1_000);
	assert.equal(s.calls.releases, 0);
	s.type(" ");
	s.detector.dispose();
	assert.equal(s.clock.pending(), 0);
	s.clock.advance(40);
	assert.equal(s.detector.handleInput(" "), undefined);
	s.clock.advance(40);
	assert.equal(s.detector.handleInput(" "), undefined);
	assert.equal(s.calls.holds, 1);
});
