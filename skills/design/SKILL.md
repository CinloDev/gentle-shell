---
name: gentle-design
description: "Trigger: /gentle:design, design a screen, mockup, artboards, UI directions, try a different approach. Write self-contained HTML design directions under design/<slug>/."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill when the user asks for a visual design, mockup, or UI directions, or iterates on artboards under `design/`. Do not use it to implement production code in the project's stack.

## Hard Rules

- Every artboard is one self-contained HTML file: inline CSS, JS, and SVG; system font stacks only. Never reference external URLs, CDNs, remote fonts, images, or scripts.
- Use realistic content for the audience; no lorem ipsum or placeholder names.
- Accessible markup: semantic elements and landmarks, WCAG AA contrast, visible focus styles, `prefers-reduced-motion` respected for any motion.
- When `design/system.md` exists, read it first and use only its tokens and component rules.
- Ask at most one clarifying question, and only when the brief lacks the goal or the content.
- Iterating edits only the targeted artboard. Never rewrite the others.

## Decision Gates

| Situation | Action |
| --- | --- |
| New brief | Write N clearly different directions (3 by default, or the number asked) to a new `design/<slug>/` |
| Feedback on one artboard | Edit that file only; keep its manifest entry, update `tradeoff` if it changed |
| "Save and try a different approach" | Add a new artboard with the next `NN`; keep previous ones; append it to the manifest |
| User wants to tune values (spacing, color, type scale) | Add sliders or controls in the artboard plus a "Copy as prompt" button that copies the chosen values as a prompt |
| `design/<slug>/` already exists for a new brief | Pick a new slug; never overwrite another design |
| A message carries design comments, or the user asks to apply them | Follow "Canvas comments" below |

## Execution Steps

1. Take the brief: goal, layout, content, audience.
2. Choose a kebab-case slug from the brief.
3. Make the directions differ in structure or visual strategy, not only in color. Label each with the tradeoff it makes.
4. Write `design/<slug>/NN-<name>.html` per artboard (`01-…`, `02-…`; kebab-case name).
5. Write `design/<slug>/design.json`:

```json
{
  "title": "Pricing page",
  "brief": "Pricing page for a note-taking app aimed at students",
  "artboards": [
    { "file": "01-comparison-table.html", "title": "Comparison table", "tradeoff": "Dense and scannable; weaker emotional pull", "width": 1440, "height": 900 },
    { "file": "02-single-plan-hero.html", "title": "Single plan hero", "tradeoff": "Strong focus; hides plan differences", "width": 1440, "height": 900 }
  ]
}
```

6. Set `width`/`height` to the artboard's intended viewport in CSS pixels; keep the manifest in sync with the files on every change.

## Canvas comments

Comments from the canvas are stored in `design/<slug>/comments.json`; the session also receives them as messages that name each comment id.

1. Read the open comments with the `gentle_design_comments` tool (`action: "list"`, optional `slug` and `file`). Without the tool, read `design/<slug>/comments.json` and use the entries whose `status` is `"open"`.
2. Apply each comment by editing only the artboard in its `file`; use `selector` and `excerpt` to find the element.
3. Mark each applied comment resolved with the tool (`action: "resolve"`, `slug`, `ids`). Without the tool, set its `status` to `"resolved"` and `resolvedAt` to the current ISO time, keeping every other entry and field as is. Leave comments you did not apply open, and say why.

The file format, for agents that only have file access:

```json
{
  "version": 1,
  "comments": [
    { "id": "k3x9p2ab", "file": "02-bold.html", "selector": "body > header > h1", "excerpt": "Ship faster", "comment": "Make the headline shorter.", "createdAt": "2026-10-26T10:00:00.000Z", "status": "open", "sentAt": null, "resolvedAt": null }
  ]
}
```

Never delete or reorder entries, and keep the file valid JSON: the canvas refuses to overwrite a file it cannot parse.

## Output Contract

Return: the slug, each artboard file with its title and tradeoff, which files changed in this turn, the comment ids resolved in this turn, and any open question. Mention that `/gentle:design open <slug>` shows the canvas.

## References

- `design/system.md` in the project, when present — the design tokens to follow.
