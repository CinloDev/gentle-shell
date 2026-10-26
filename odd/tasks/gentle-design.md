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
- **S8 Handoff to code.** An "Implement this" action per artboard on the canvas, and `/gentle:design implement <slug>/<artboard>`, send a message to implement that artboard in the project's real stack under ODD. The message uses the artboard as the visual spec and `design/system.md` as the token source. The handoff never commits on its own.

## Tasks

| ID | Specs | Route | Status | Commit / evidence |
|----|-------|-------|--------|-------------------|
| T1 | S1, S2, S3 (`<brief>` and no-args usage) | delegated: context backstop (L4) | done (risk medium: writer self-verification + parent spot check) | `32550812b`; RED 9/9 → GREEN 9/9; parent re-run of focused suites 102/102, `node scripts/check-types.mjs` 0 diagnostics |
| T2 | S1, S3 (`open`, `stop`, no-args open), S4, S5, S6 | delegated: context backstop; Risk item 2 (local HTTP server, security) → own commit and independent verifier | implemented; independent check pending | part A + B by one writer (parallel to T1 for part A); RED→GREEN 57/57; two security mutations (realpath containment, POST Origin) caught by tests; parent re-run 94/94, types 0 diagnostics |
| T3 | S7, S3 (`sync`) | delegated: context backstop | pending | |
| T4 | S8, S3 (`implement`) | delegated: context backstop | pending | |

Planned slices (`feature-branch-chain`; push and PR stay with the user): PR1 = T1, PR2 = T2, PR3 = T3 + T4. Forecast: about 1,700 authored changed lines.
Slice boundaries: PR1 = `32550812b` (413 lines); PR2 = the T2 commit (`feat(design): add local design canvas with comments`).

## Log

- **L1** (2026-10-26) User: "ok quiero que lo revises bien, y planifiquemos como podriamos dar eso sin tener que pasr por claude, desde gentle shell directo por nosotros sin necesidad de usar dicho proveedor"
- **L2** (2026-10-26) Research (support.claude.com/en/articles/14604416, claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html, andrew.ooo/answers/claude-code-design-command-artboards-august-2026). `/design` has four parts: design guidance, an artboard canvas on Anthropic's Artifacts runtime, `/design-sync`, and handoff to code. Only the canvas hosting is provider-bound. Plan proposed: Phase 1 skill and command, Phase 2 local canvas with comments, Phase 3 design system, Phase 4 handoff. Canvas options: (1) build it ourselves, (2) use OpenPencil.
- **L3** (2026-10-26) User: "1" (build the canvas ourselves).
- **L4** (2026-10-26) The runtime context backstop fired before the first write, so every task runs in a bounded writer with a short handoff. Pi API facts: `pi.sendUserMessage(content, { deliverAs: "steer" | "followUp" })`; skills are invocable as `/skill:<name>`; extensions register with `pi.registerCommand`; package files are listed in `scripts/verify-package-files.mjs`.
- **L5** (2026-10-26) T1 landed in `32550812b`. `sendUserMessage` expands `/skill:<name>` only with `expandPromptTemplates: true` and only when the skill is loaded (`pi.getCommands()` lists `skill:gentle-design`); otherwise the command points the model at the bundled SKILL.md path. The palette entry goes in Session. The parent made the test scratch dirs clean themselves.
