# Voice push-to-talk (hold Space)
Objective: hold Space to dictate into the draft, only when voice is installed and push-to-talk is enabled. Branch: feat/voice-push-to-talk, based on feat/optional-parakeet-voice (bee120aad).
Delivery: feature-branch-chain, next child after the voice chain; local commits only. Runner: node --experimental-strip-types --test tests/voice-*.test.ts; typecheck: node scripts/check-types.mjs (never pnpm).

## Specs
S1. "dejando espacio no se puede?" — push-to-talk: holding Space records, releasing Space stops and pastes the transcript into the draft (never sent).
S2. "solo si esta cargado el voice, que la persona lo eligio y descargo" — push-to-talk is active only when the voice runtime and model are installed. Without them Space behaves exactly as today.
S3. "tambien deberiamos de agregar un enabled disabled" — a persisted enable/disable toggle, managed from /gentle:voice.
S4. Contract notes for Cristian updated (standing instruction, see feat/optional-parakeet-voice S6).

Design constraints (from verified evidence, see L2):
- Detection uses key auto-repeat on `ctx.ui.onTerminalInput`, because the terminal never reports a Space release with Pi's keyboard flags. First " " is held back; a repeat within the tap window (assumption: 500 ms) means hold; no repeat means tap and the held space is emitted unchanged; any other input while held flushes the space first, then passes through. During recording, repeats are consumed; a gap with no repeat (assumption: about 200 ms) means release.
- Only exact single " " chunks are candidates. Pastes, escape sequences and other chunks pass through untouched.
- Disabled or not installed: no listener armed, zero change to typing.
- Startup: reading the persisted toggle through the existing settings mechanism is allowed; no voice filesystem probe, network, native load or worker spawn at startup. Installation is checked lazily at the first hold.
- Assumption: push-to-talk is enabled by default after a successful download; the menu offers Disable/Enable.
- Reuse createVoiceSession, readVoiceStatus and the existing single-operation lock in lib/voice-command.ts; Esc cancels; shutdown cancels; no auto-send.

## Tasks
- T1 [S1-S3] delegated (context backstop): hold detector + toggle + /gentle:voice menu entries + status indicator + tests + docs; pending; commit none.
- T2 [S4] inline: contract notes update; pending; commit none.
- T3 [S1-S3] user smoke test on this Mac; pending.

## Log
L1. User: "anda increible , cual es el atajo lo unico?" → no dedicated shortcut existed. User: "dejando espacio no se puede?" then "solo si esta cargado el voice, que la persona lo eligio y descargo, tambien deberiamos de agregar un enabled disabled".
L2. Evidence: Pi requests Kitty keyboard flags 7 (node_modules/@earendil-works/pi-tui/dist/terminal.js:12). Kitty spec: "Key events that result in text are reported as plain UTF-8 text, so events are not supported for them, unless the application requests key report mode" (https://sw.kovidgoyal.net/kitty/keyboard-protocol/). So Space release is never reported; auto-repeat detection is the only way to honor "Space". `ctx.ui.onTerminalInput(handler)` returns `{consume, data}` and sees raw input before the editor (dist/core/extensions/types.d.ts:54,82). Tradeoff disclosed to user: a trailing Space can appear up to the tap window late.
L3. Branch created from feat/optional-parakeet-voice at bee120aad.
