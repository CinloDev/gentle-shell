# Session scratch and artifact ledger

Objective: the runtime owns the parent session's temporary files and the clones/worktrees it creates, records them in
a persistent per-session ledger outside Engram, cleans what is safe automatically (including after cancelled, stuck,
or crashed sessions), and offers a command to list and clean the rest, so the model spends no tokens remembering or
re-deducing what is garbage. Branch `feat/session-scratch-ledger` from `feat/harness-r1-runtime-checks` (stacked on
gentle-shell#2290). Runner: `pnpm test`.

## Specs

- S1 (user report, verbatim): "En gentle-shell main de hoy, dependiendo del caso crea test temporales, clones etc pero
  después de un largo tiempo se olvida de ellos y peor, si por alguna razón se paraliza una tarea por bloqueante o se
  cancela la misma, los test o temporales no se borran. A veces el modelo por iniciativa puede pedir investigar si los
  temporales son creados por su tarea y pide permiso de borrarlos y eso demuestra que se olvida de ellos. De manera
  persistente en algún lugar además de engram, debería guardar esas rutas y ficheros temporales que crea y al
  finalizar un plan o tarea pueda mirar ahí y borrarlos sin necesidad de gastar tokens deduciendo o leyendo su
  contenido y verificando que se pueden borrar. También podría haber un automatismo que los borre o un comando para
  que borre la basura listada". User: "Si ahira" (implement now) after the proposal below.
- S2 Parent session scratch: at primary session start the runtime creates
  `<inherited tmpdir>/gentle-pi-session-<session id>-XXXX` (mkdtemp, private mode) and points `TMPDIR` (and `TMP`/`TEMP`
  on win32) of the Pi process at it, so every `mktemp` the model runs and every subagent's own TMPDIR (T3) land under
  it. Children never create a session scratch of their own. If creation fails, the session keeps the inherited TMPDIR.
- S3 Ledger: a JSON file per session in gentle-pi's config home (for example
  `<GENTLE_PI_CONFIG_HOME>/scratch/<session id>.json`) records: schema version, session id, owning process id and
  start time, cwd, the scratch dir, and artifacts outside TMPDIR. Writes are atomic (temp file + rename). Never in
  Engram.
- S4 Artifact capture: after a successful foreground parent `bash` command, the runtime records the destination of
  `git clone ... [<dir>]` (the default directory name when omitted) and the path of `git worktree add ... <path>`,
  resolved against the command's directory (reuse the cd-segment resolution from lib/commit-slice-signal.ts), with the
  command line and time. Only paths that exist after the command are recorded. No model call is needed.
- S5 Automatic cleanup: (a) on session shutdown the runtime removes its own scratch dir and deletes the ledger when no
  artifacts remain; (b) at primary session start it sweeps ledgers of dead sessions (owning process not alive and the
  ledger older than a grace period, default 1 hour): removes their scratch dirs, keeps their artifact entries for the
  command. Removal is limited to directories the runtime created (prefix and ledger match; never follow symlinks out).
- S6 Command `/gentle:scratch`: `list` shows the session's scratch dir with its size and every recorded artifact of this
  and dead sessions; `clean` removes scratch dirs without asking and, for recorded worktrees and clones, removes only
  those with no uncommitted changes and no unpushed commits (clones) after one confirmation listing them; dirty ones
  are reported and kept. Worktrees are removed with `git worktree remove` (then pruned), clones with a recursive delete
  of the recorded path only. Headless/no-UI: `clean` removes scratch only and reports artifacts.
- S7 Prompt: the orchestrator text that tells the model to clean its scratch is shortened to say the runtime owns
  session scratch and `/gentle:scratch` lists or cleans recorded clones and worktrees (keep module byte budgets and
  pins; check tests/orchestrator-budget.test.ts and the test-scratch contract tests).
- S8 Docs: docs/readme-reference.md describes the scratch dir, the ledger location and format, automatic cleanup, the
  sweep rule, and the command; the help text of the command matches.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S2-S8 | session scratch, ledger, capture, cleanup, command, prompt, docs, tests | delegated (context backstop) | implemented, uncommitted (L2-L3); verifier and native review pending |

## Log

- L1 (user, 2026-10-15): report in S1 and "Si ahira". Risk: item 1 (deletes files and directories) — needs an
  independent verifier and native review after the writer.
- L2 (evidence, T1): new extension `extensions/session-scratch.ts` (auto-discovered, registers nothing when
  `GENTLE_PI_AGENTS_CHILD=1`) over `lib/session-scratch.ts`; `lib/commit-slice-signal.ts` now exports
  `SHELL_SEGMENT_SEPARATOR` and `directoryAfterSegment`, shared by `commitTargetDirectory` and S4 capture.
  RED: `tests/session-scratch.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `extensions/session-scratch.ts`.
  GREEN: 19/19, then 22/22 after triangulation. TRIANGULATE: removing the protected-path check at record time fails
  "S4: a clone into the session directory or an ancestor of it is never recorded"; disabling the detached-commit check
  fails "S6: clean keeps a detached worktree whose commits are on no branch" (both restored). S7: the writer line now
  says the runtime owns session scratch and `/gentle:scratch` lists or cleans recorded clones and worktrees (268 to 263
  bytes); `tests/test-scratch-contract.test.ts` pins it (the old writer text lacks the clause). S8: reference section
  "Session scratch and artifact ledger" plus a command row, pinned against `SCRATCH_COMMAND_USAGE`. Checks:
  `pnpm test` all three stages PASS (unit 6956 tests, 6884 pass, 0 fail); `pnpm -s typecheck` 0 diagnostics;
  `node scripts/verify-package-files.mjs` passed (214 files).
- L3 (decisions, T1): reload keeps the scratch (same session); other shutdown reasons remove it and restore the
  inherited `TMPDIR`/`TMP`/`TEMP`. A scratch dir is removed only when it is the recorded real path, carries
  `gentle-pi-session-<safe session id>-`, is a non-symlink directory owned by the current uid, and holds no recorded
  artifact (a scratch holding a clone is kept for `clean`). `clean` empties the live session's scratch (it is still
  `TMPDIR`) except `gentle-pi-subagent-tmp-*` and recorded artifacts. Clones need a clean `git status`, a `.git`
  directory, the recorded path as Git top level, and `rev-list --all --not --remotes` empty; worktrees need a clean
  status, a `.git` file, and, when detached, commits on a branch. Paths that are a filesystem root or the home, config
  home, ledger cwd, or process cwd (or an ancestor) are never recorded or removed. A resumed session id carries the
  artifacts of its earlier ledger. `assets/orchestrator-verification.md` (outside the surfaces) still says the parent
  removes verifier scratch paths; verifier scratch now lives in the child TMPDIR the runner removes.
