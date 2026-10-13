# gentle-shell #2180 — record the resolved model source in task records

Issue: #2180 (Part of #1064, post-3b-ii follow-up; field report by @zhalker, generalization by @matraket). Branch `feat/2180-model-source-task-record` from origin/main `41a3bcd05`.
Spec of record: the issue body. Quote-verbatim user requirement: Juan said: "comencemos con ese issue ya mismo que es urgente para tapar la cagada que nos madnamos".

## Problem

Since 3b-ii, every parent session freezes its profile at startup and an explicit Enter binding outranks editable layers. Nothing at launch time says which layer won, so disk edits below the frozen layers no-op silently (@zhalker: four relaunches failed on a provider quota error before a cold `loadAgentsConfig` proved the disk layers were already correct).

## Specs

- **S#1** `TaskRequest` gains an optional `modelSource?: string` (host-computed only, same provenance discipline as `extensionPaths`: never derived from tool input or agent definitions).
- **S#2** `TaskRecord` gains `modelSource?: string`, copied from the request at record creation in `lib/agents-runner.ts` (next to `model: formatModelRef(request.model)`).
- **S#3** The launch seam in `extensions/gentle-agents.ts` (the `subagent_run` handler that already resolves `sessionBinding`/`sessionProfile` and builds `config` via `withPinnedModelProfiles` + `sessionProfileRoutingAt` + `resolveAgentProfile`) computes the winning layer as a short stable token and passes it into the request. Tokens, exactly: `binding` (explicit Enter binding won), `frozen:local` / `frozen:repo` / `frozen:global` (a session-profile-freeze inherited snapshot won, with its origin), `pin:local` / `pin:repo` (resolveProfilePin won), `declaration` (non-git repo declaration won), `profile` (config.modelProfiles from the global active layer), `definition` (agent frontmatter), `default` (Pi default). Computed at the point where the winning modelProfiles are already known — no layer is re-resolved to route. `resolveSessionProfile` returns explicit → inherited(with origin) → live; the token reconciles with the existing sessionBinding/resolveProfilePin reads so it reflects the real winner. If a launch has both a sessionBinding and a frozen snapshot, the explicit binding wins per the chain's precedence.
- **S#4** The agents task card (`lib/agents-view.ts` `taskHeader`) shows the source next to the model when present (e.g. `nan/glm5.3 · binding`); absent `modelSource` renders exactly as today.
- **S#5** Docs: the task-card field documented in `docs/readme-reference.md` where the card/model routing is described; one line in the frozen-profiles (#2180-adjacent) section.
- **S#6** Tests (RED first): at minimum — a bound-session launch yields `modelSource: "binding"` on the TaskRecord; a frozen global-active launch (no Enter) yields `frozen:global`; an agent whose model comes from frontmatter with no profile layers yields `definition`; a request without `modelSource` leaves `modelSource` undefined and the card rendering unchanged (S#4 absence contract). Runner-level test that record creation copies the field. Fixtures: `pinFixture`/`launchSession` patterns in `tests/gentle-agents.test.ts`; runner tests in `tests/agents-runner.test.ts`.
- **S#7** This ODD file, mirroring the routing convention of `odd/tasks/1064-inherited-profile-freeze.md`.

## Token mapping (S#3, derived from the seam's own resolution)

`resolveAgentProfile(...).source.model` names how the model was found (`profile | definition | default | unresolved`); the seam names *which* layer supplied the profile routing it already resolved:

- `definition` / `default` → `definition` / `default`; `unresolved` → no token (no model anywhere; the card already shows `default`).
- source `profile` + resolution `explicit` → `binding`.
- source `profile` + resolution `inherited` with a snapshot → `frozen:<snapshot.origin>`.
- source `profile` + resolution `inherited` without a snapshot: the session keeps the materialized config routing → `profile`; a foreign target keeps only its own pin layers (L7/N1 contract), so a winning pin there is named `pin:<source>` from the same `resolveProfilePin` read `sessionProfileRoutingAt` just performed.
- source `profile` + resolution `follow`/`live` → the routing read the target's own defaults; the layer is named from the same target read (`resolveProfilePin` → `pin:local`/`pin:repo`, non-Git declaration → `declaration`, otherwise `profile`).

Known tradeoff, stated rather than hidden: the last two paths re-read only the pin/declaration files that `sessionProfileRoutingAt` itself just read, because `lib/session-profile-freeze.ts` and `lib/agents-config.ts` are outside this task's allowed edit surfaces (no origin-carrying routing helper may be added there). No freeze, binding, or profile resolution runs twice.

## Tasks

- T1 [ ] S#1, S#2 — protocol/request field + record creation copy; runner-level test. Route: inline.
- T2 [ ] S#3 — launch-seam token; `tests/gentle-agents.test.ts` seam tests (binding, frozen:global, frozen:local, frozen:repo, definition, profile, pin:local, pin:repo, declaration). Route: inline.
- T3 [ ] S#4 — task card source next to the model; absence contract test. Route: inline.
- T4 [ ] S#5, S#7 — docs + this record's log. Route: inline.

## Log

- L1 (process, 2026-10-06): worktree `/tmp/pr1827-2180` from origin/main `41a3bcd05`; `pnpm install` clean; test-first per commit; no push, no GitHub comments. Baselines: `tests/session-profile-freeze.test.ts` + `tests/session-profile-binding.test.ts` 41/41; `tests/agents-runner.test.ts` + `tests/agents-protocol.test.ts` 105/105; `tests/gentle-agents.test.ts` 247/247; `tests/gentle-shell.test.ts` 273/273; `pnpm run typecheck` clean (0 recorded diagnostics; the committed baseline is zero-diagnostics, the "185" ratchet figure in the task handoff does not appear in `scripts/check-types.mjs`, which reports `types: 0 recorded diagnostic(s), no regressions`).
