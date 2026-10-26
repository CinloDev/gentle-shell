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

## Output Contract

Return: the slug, each artboard file with its title and tradeoff, which files changed in this turn, and any open question. Mention that `/gentle:design open <slug>` shows the canvas when it is available.

## References

- `design/system.md` in the project, when present — the design tokens to follow.
