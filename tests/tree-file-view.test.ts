import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TreeFileView } from "../lib/tree-file-view.ts";

const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value };
test("narrow viewport explicitly reports insufficient width without replacing Unicode", () => {
 const view = new TreeFileView("x", theme, () => {}, () => {}, () => 10);
 view.update({ kind: "text", text: "界", message: "" });
 const small = view.render(4).join("\n");
 assert.doesNotMatch(small, /�/); assert.match(small, /!/);
 assert.match(view.render(8).join("\n"), /界/);
});

test("display limit preserves exactly 8192 rows and discloses overflow immediately", () => {
 const view = new TreeFileView("x", theme, () => {}, () => {}, () => 10);
 view.update({ kind: "text", text: Array(8192).fill("x").join("\n"), message: "" });
 assert.doesNotMatch(view.render(40).join("\n"), /Display truncated/);
 view.handleMouse({type: "wheel", wheelDelta: 10000} as never);
 assert.doesNotMatch(view.render(40).join("\n"), /Display truncated/);
 view.update({ kind: "text", text: Array(8193).fill("x").join("\n"), message: "" });
 assert.match(view.render(40).join("\n"), /Display truncated/);
});

test("viewer wraps logical lines with indented continuations, preserves indentation and blank lines, and reflows on resize", () => {
 let renders = 0, closes = 0;
 const view = new TreeFileView("file", theme, () => closes++, () => renders++, () => 20);
 assert.match(view.render(12).join("\n"), /Loading/);
 view.update({ kind: "text", text: "  abcdefghijkl\n\tchild\n\n界界界界界", message: "" });
 const narrow = view.render(12);
 assert.match(narrow.join("\n"), /  abcdef/);
 assert.doesNotMatch(narrow.join("\n"), /↪/);
 assert.match(narrow.join("\n"), /│  hijkl/);
 assert.ok(narrow.some(row => /^│\s+│$/.test(row)));
 assert.ok(narrow.every(row => visibleWidth(row) <= 12));
 const wide = view.render(40).join("\n");
 assert.match(wide, /  abcdefghijkl/); assert.match(wide, /        child/);
 assert.doesNotMatch(wide, /↪/);
 for (let width = 0; width <= 12; width++) assert.ok(view.render(width).every(row => visibleWidth(row) <= width));
 view.handleInput("\u001b"); assert.equal(closes, 1); view.dispose(); const before = renders;
 view.update({kind:"error", text:"", message:"late"}); assert.equal(renders, before);
});
