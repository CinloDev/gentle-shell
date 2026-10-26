# Gentle Design: provider-free design canvas for Gentle Shell

Objective: a Gentle Shell equivalent of Claude Code `/design` (HTML artboards, canvas, comments, design system, handoff to code) that runs with any Pi provider.
Branch: `feat/gentle-design` (worktree `.worktrees/gentle-design`, base `origin/main` 9f29f16f1). Delivery: `ask-on-risk` → `feature-branch-chain` (chosen directly under the session's Super Yolo delivery permission), one PR slice per phase. Test runner: `node --experimental-strip-types --test tests/<file>.test.ts`; suite `pnpm test`.

## Specs

Requirements S2-S8 come from the plan the user accepted (L2, L3). Wording outside quotes is the plan's, not the user's.

- **S1 Provider independence.** User: "planifiquemos como podriamos dar eso sin tener que pasr por claude, desde gentle shell directo por nosotros sin necesidad de usar dicho proveedor". Acceptance: no code path calls a provider-specific API; the feature works with whatever model the Pi session uses; the only network traffic is the loopback canvas server; artboards are self-contained (no CDN, no remote fonts or scripts).
- **S2 Design skill.** A bundled skill (`skills/design/SKILL.md`, name `gentle-design`) makes the model:
  - take the brief: goal, layout, content and audience, with at most one clarifying question;
  - generate several clearly different directions (3 by default, or the number the user asks for), each labeled with the tradeoff it makes;
  - write them to `design/<slug>/`: one self-contained HTML file per artboard (`NN-<name>.html`, inline CSS/JS/SVG, system font stacks) plus a `design.json` manifest (`title`, `brief`, `artboards[]` with `file`, `title`, `tradeoff`, `width`, `height`);
  - use realistic content and accessible markup: semantic elements, WCAG AA contrast, visible focus, `prefers-reduced-motion`;
  - reuse `design/system.md` tokens when present;
  - when iterating, edit only the targeted artboard; "save and try a different approach" adds a new artboard and keeps the previous ones;
  - when the user wants to tune something, add sliders or controls with a "Copy as prompt" button.
- **S3 Command.** `/gentle:design <brief>` starts a design run with the skill. `/gentle:design` with no arguments opens the most recent design in the session cwd, or prints usage when there is none. The subcommands are `open [slug]`, `stop`, `sync` and `implement <slug>/<artboard>`. The help text, the README feature table and `docs/gentle-shell.md` describe all of them.
- **S4 Local canvas.** `/gentle:design open [slug]` starts a local server and opens the default browser on a canvas:
  - every artboard shows side by side, at its manifest size, with its title and tradeoff;
  - zoom (buttons, and Ctrl/Cmd + wheel), pan and fit;
  - live reload when an artboard file or the manifest changes.
- **S5 Comments back to the session.** In comment mode, clicking an element in an artboard and typing a comment sends the session one message with: the design slug, the artboard file, a CSS selector for the element, a short text excerpt of the element, and the comment. While the agent is busy, the message is queued as a follow-up. The agent edits that artboard, and the canvas reloads.
- **S6 Local server safety.** The server:
  - binds `127.0.0.1` only, on a random port;
  - requires a per-server random token on every route;
  - rejects a `Host` header that is not its own loopback address;
  - accepts POST only with `Origin` equal to its own origin and a JSON content type;
  - serves only files under `design/` in the session cwd (no traversal, no symlink escape);
  - bounds comment length;
  - renders artboards in iframes sandboxed without `allow-same-origin`;
  - stops on `/gentle:design stop` and on session shutdown.
- **S7 Design system sync.** `/gentle:design sync` has the agent read the project's design sources: CSS custom properties, the Tailwind theme, the component library and existing tokens. It writes `design/system.md` (tokens and component rules) and `design/system.html` (tokens rendered as an artboard). Later designs use these files. The canvas shows the system board first when it exists. Before finishing an artboard, the skill checks its colors and fonts against the system tokens and fixes any deviation.
- **S8 Handoff to code.** An "Implement this" action per artboard on the canvas, and `/gentle:design implement <slug>/<artboard>`, send a message to implement that artboard in the project's real stack under ODD. The message uses the artboard as the visual spec, `design/system.md` as the token source, and lists the artboard's open comments from `comments.json` (S9). The handoff never commits on its own.
- **S9 Persistent comments.** From the proposal the user accepted in L8 (option 1):
  - Every comment sent from the canvas is also saved in `design/<slug>/comments.json`, with artboard, selector, excerpt, text, date and status (`open` or `resolved`), so any agent or session can read it.
  - The canvas shows a pin on each commented element, plus a list of open and resolved comments.
  - The agent marks a comment `resolved` when it has applied it.
  - The canvas has two send modes: "Send now" (the S5 behavior) and "Collect", where comments are saved without being sent and a "Send all" button sends them as one batch.
  - The S8 handoff includes the open comments.
- **S10 Link to the ODD feature.** User: "esto del design estaria bueno que quedara ligado al documento de ODD de su feature, si es algo que es chico que quede suelto pero si es algo que surge desde un ODD hacer el link". Acceptance (assumptions marked):
  - A design that comes from a tracked ODD feature records it in `design.json` as an optional `feature` field: the repository-relative path of the feature document, `odd/tasks/<feature>.md`. A design from small, untracked work has no `feature` field and stays standalone.
  - Assumption: the link goes both ways. The skill appends a Log entry to that feature document naming `design/<slug>/` and its artboards, and the canvas shows the linked feature document.
  - Assumption: when an artboard with a `feature` link is handed off (S8), the message says to track the implementation in that feature document instead of sizing it from scratch.
  - The server validates `feature` (a relative `.md` path under `odd/tasks/`); an invalid value is ignored and reported, never served.

## Tasks

| ID | Specs | Route | Status | Commit / evidence |
|----|-------|-------|--------|-------------------|
| T1 | S1, S2, S3 (`<brief>` and no-args usage) | delegated: context backstop (L4) | done (risk medium: writer self-verification + parent spot check) | `32550812b`; RED 9/9 → GREEN 9/9; parent re-run of focused suites 102/102, `node scripts/check-types.mjs` 0 diagnostics |
| T2 | S1, S3 (`open`, `stop`, no-args open), S4, S5, S6 | delegated: context backstop; Risk item 2 (local HTTP server, security) → own commit and independent verifier | done (risk high: independent verifier, no blockers) | part A + B by one writer (parallel to T1 for part A); RED→GREEN 57/57; two security mutations (realpath containment, POST Origin) caught by tests; parent re-run 94/94, types 0 diagnostics; real-browser proof (ego-browser) 2a-2d, 2f PASS, 2e partial (ego-lite skips `<select>` on Tab, reproduced without app code); defect D1 fixed in `0e6862116` (RED→GREEN 20/20) |
| T3 | S7, S3 (`sync`) | delegated: context backstop | done (risk medium: writer self-verification + parent spot check; new server route goes to the feature-end verifier) | commit `feat(design): sync the project design system into a system board`; RED 9 new → GREEN; parent re-run 113/113, types 0; real-browser proof all PASS |
| T5 | S9 (and the S5 message carries the comment id) | delegated: context backstop; same writer as T2b; Risk item 4 (server and agent write the same comments.json) | done (risk high: independent verifier, no blockers); commit `e8cd68c2b` | RED→GREEN store 9/9, server 28/28, extension 19/19; mutations (store queue, POST Origin) caught; real-browser proof all PASS, plus a toolbar overflow fix at ~950px; parent re-run 116/116, types 0 diagnostics |
| T4 | S8, S10, S3 (`implement`), and `open` with only the system board (L14) | delegated: context backstop | done; feature-end independent verifier pending (new POST route) | commit `feat(design): hand artboards off to code and link designs to ODD features`; RED 11 new → GREEN; parent re-run 123/123, types 0; real-browser proof all PASS |

Planned slices (`feature-branch-chain`; push and PR stay with the user): PR1 = T1, PR2 = T2, PR3 = T3 + T4. Forecast: about 1,700 authored changed lines.
Slice boundaries: PR1 = `32550812b` (413 lines); PR3 = `49d898da0` (T3) + the T4 commit; PR2 = T2 `23bc81271` + D1 `0e6862116` + T5 `e8cd68c2b` + advisory fix `643c70795`. PR2 exceeds the ~400-line heuristic, because the canvas UI and the security tests are one coherent behavior.

## Log

- **L1** (2026-10-26) User: "ok quiero que lo revises bien, y planifiquemos como podriamos dar eso sin tener que pasr por claude, desde gentle shell directo por nosotros sin necesidad de usar dicho proveedor"
- **L2** (2026-10-26) Research (support.claude.com/en/articles/14604416, claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html, andrew.ooo/answers/claude-code-design-command-artboards-august-2026). `/design` has four parts: design guidance, an artboard canvas on Anthropic's Artifacts runtime, `/design-sync`, and handoff to code. Only the canvas hosting is provider-bound. Plan proposed: Phase 1 skill and command, Phase 2 local canvas with comments, Phase 3 design system, Phase 4 handoff. Canvas options: (1) build it ourselves, (2) use OpenPencil.
- **L3** (2026-10-26) User: "1" (build the canvas ourselves).
- **L4** (2026-10-26) The runtime context backstop fired before the first write, so every task runs in a bounded writer with a short handoff. Pi API facts: `pi.sendUserMessage(content, { deliverAs: "steer" | "followUp" })`; skills are invocable as `/skill:<name>`; extensions register with `pi.registerCommand`; package files are listed in `scripts/verify-package-files.mjs`.
- **L5** (2026-10-26) T1 landed in `32550812b`. `sendUserMessage` expands `/skill:<name>` only with `expandPromptTemplates: true` and only when the skill is loaded (`pi.getCommands()` lists `skill:gentle-design`); otherwise the command points the model at the bundled SKILL.md path. The palette entry goes in Session. The parent made the test scratch dirs clean themselves.
- **L6** (2026-10-26) T2 is in `23bc81271`. Native assess says `reviewDue: true` (high: process boundary in `lib/design-open-browser.ts`). The real-browser proof found D1: Chromium sends `Origin: null` for subresources of sandboxed artboards, so the server's 403 meant `inspector.js` never ran. Fixed in `0e6862116`: GET accepts `Origin: null` only for `files/` and `assets/inspector.js`, and every POST still needs the exact own Origin. The native review START waits for the user's answer about comment persistence (S9 proposal).
- **L7** (2026-10-26) User: "pero como se usan los comentarios ? quien los lee ? son para dar input al agente par que este haga las mejoras luego de los mismos ? se puede exportar en un archivo que luego lo puede usar otro agente ? etc"
- **L8** (2026-10-26) User: "lo agregamos dale, el 1". This accepts the S9 proposal: comments.json with states, pins, a Collect mode with "Send all", and open comments in the handoff. S8 was rewritten to add the open comments. T5 was added before the T2 native review, so one review covers T2 + D1 + T5 (base `32550812b`).
- **L9** (2026-10-26) T5 is done. Under the session's delivery permission the parent decided: the send mode stays in localStorage (it lasts while that server runs, as documented), and the agent resolves comments through the `gentle_design_comments` tool. Hand edits of comments.json are last-rename-wins, but they never corrupt the file.
- **L10** (2026-10-26) T5 landed in `e8cd68c2b`. Native review START of PR2 (`32550812b..HEAD`, 3845 lines, lenses risk/resilience/reliability) refused at preflight with `lens_context_budget_exceeded`. No authority was created, so there was nothing to abandon. Splitting it would have meant rewriting branch history, so the parent followed the documented RDD-off path for a refused START: native tier high → an independent `gentle-ai-verify` over `32550812b..HEAD` (items 2 and 4). T3 waits until the verifier finishes, so its test runs see a stable tree.
- **L11** (2026-10-26) The independent verifier found no blockers. S1, S3 (open/stop/no-args), S4, S5, S6 and S9 PASS. It re-ran 116/116 and types 0. Probes: security 107/108, lifecycle 22/23 (that FAIL was a probe bug, re-verified PASS), opener 18/18. Advisories, and what we do with each:
  - (1) send-now racing send-all can deliver twice → fix.
  - (2) excerpt truncation is by code points in the server but by UTF-16 length in the store → fix.
  - (3) async `sendUserMessage` failures are invisible, because Pi returns void → accept and document.
  - (4) a canvas opened via `localhost` gets 403 on every POST → fix: accept its own localhost origin as well.
  - (5) the README row does not name `stop` → fold into T3/T4 docs.
  - (6) `xdg-open` resolves through PATH → accept (`shell:false`).
  - (7) an artboard script can forge `gd:pick` → accept: the user still writes and sends the comment.
  - (8) the symlinked-design listing differs between the server and the command → fix: one shared listing.
  The parent removed the verifier scratch.
- **L12** (2026-10-26) Advisories 1, 2, 4 and 8 fixed test-first in `fix(design): close PR2 verifier advisories`, with RED→GREEN for each; advisory 3 is documented. Parent re-run 104/104, types 0. The fix touches the POST Origin set (item 2), so the feature-end independent verifier covers it together with T3 and T4.
- **L13** (2026-10-26) User: "una cosa mas, chiquita, esto del design estaria bueno que quedara ligado al documento de ODD de su feature, si es algo que es chico que quede suelto pero si es algo que surge desde un ODD hacer el link". Added as S10 and assigned to T4.
- **L14** (2026-10-26) T3 done. Parent decisions: the system board keeps a fixed 1200 px height and scrolls inside its iframe. `open` must also work when only `design/system.html` exists (folded into T4).
- **L15** (2026-10-26) T4 done. The command and the canvas Implement route share `planDesignImplement`, so both send identical text. Feature-end verification launched over `e8cd68c2b..HEAD` (advisory fix, T3, T4), together with the full suite.
