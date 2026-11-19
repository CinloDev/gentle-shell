import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSidebarTabs, writeSidebarTabs } from "../lib/sidebar-tabs-policy.ts";

test("TREE defaults off for legacy preferences and persists independently", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-tree-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 const path = join(home, "sidebar-tabs.json");
 for (const raw of ['{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"off","git":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"off","diff":"on"}']) {
  writeFileSync(path, raw);
  assert.equal(resolveSidebarTabs(options).tree, "off");
  assert.equal(resolveSidebarTabs(options).malformed, false);
 }
 writeSidebarTabs("on", options, { main: "on", git: "on", tree: "on" });
 writeSidebarTabs("off", options);
 assert.equal(resolveSidebarTabs(options).tree, "on");
});

test("PROFILE defaults off for legacy preferences and persists independently", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-profile-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 const path = join(home, "sidebar-tabs.json");
 for (const raw of ['{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"off","git":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"off","diff":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"off"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on"}']) {
  writeFileSync(path, raw);
  assert.equal(resolveSidebarTabs(options).profile, "off");
  assert.equal(resolveSidebarTabs(options).malformed, false);
 }
 writeSidebarTabs("on", options, { main: "on", git: "on", profile: "on" });
 writeSidebarTabs("off", options);
 assert.equal(resolveSidebarTabs(options).profile, "on");
 writeSidebarTabs("on", options, { main: "off", git: "on", profile: "off" });
 assert.equal(resolveSidebarTabs(options).profile, "off");
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"invalid"}');
 assert.equal(resolveSidebarTabs(options).malformed, true);
});

test("destination preferences persist independently of global Tabs and legacy files remain enabled", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-destinations-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 writeFileSync(join(home, "sidebar-tabs.json"), '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}\n');
 assert.equal(resolveSidebarTabs(options).main, "on");
 assert.equal(resolveSidebarTabs(options).git, "on");
 writeSidebarTabs("on", options, { main: "off", git: "on" });
 writeSidebarTabs("off", options);
 assert.deepEqual([resolveSidebarTabs(options).policy, resolveSidebarTabs(options).main, resolveSidebarTabs(options).git], ["off", "off", "on"]);
 writeSidebarTabs("on", options);
 assert.deepEqual([resolveSidebarTabs(options).policy, resolveSidebarTabs(options).main, resolveSidebarTabs(options).git], ["on", "off", "on"]);
});

test("Git card choices persist independently and legacy preferences enable both", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-cards-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 const path = join(home, "sidebar-tabs.json");
 for (const raw of ['{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"off","git":"on"}']) {
  writeFileSync(path, raw);
  const result = resolveSidebarTabs(options);
  assert.deepEqual([result.malformed, result.gitHistory, result.diff], [false, "on", "on"]);
 }
 writeSidebarTabs("on", options, { main: "off", git: "on", gitHistory: "off", diff: "on" });
 writeSidebarTabs("off", options);
 const result = resolveSidebarTabs(options);
 assert.deepEqual([result.policy, result.main, result.git, result.gitHistory, result.diff], ["off", "off", "on", "off", "on"]);
});

test("global Tabs defaults off, persists both choices, and refuses malformed files", (t) => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 assert.equal(resolveSidebarTabs(options).policy, "off");
 writeSidebarTabs("on", options);
 assert.equal(resolveSidebarTabs(options).policy, "on");
 writeSidebarTabs("off", options);
 assert.equal(resolveSidebarTabs(options).policy, "off");
 const path = resolveSidebarTabs(options).globalFile;
 for (const raw of ["broken", "null", "[]", "{}", '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","extra":true}', '{"schema":"future","policy":"on"}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":true}', '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"invalid"}']) {
  writeFileSync(path, raw);
  const result = resolveSidebarTabs(options);
  assert.equal(result.malformed, true, raw);
  assert.equal(result.policy, "off", raw);
  assert.throws(() => writeSidebarTabs("on", options));
  assert.equal(readFileSync(path, "utf8"), raw);
 }
});

test("MEM defaults off for legacy preferences and persists independently", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 assert.deepEqual([resolveSidebarTabs(options).mem, resolveSidebarTabs(options).malformed], ["off", false]);
 writeSidebarTabs("on", options, { main: "on", git: "on", mem: "on" });
 const persisted = resolveSidebarTabs(options);
 assert.deepEqual([persisted.mem, persisted.main, persisted.profile], ["on", "on", "off"]);
 writeSidebarTabs("off", options, { main: "on", git: "on", mem: "off" });
 assert.equal(resolveSidebarTabs(options).mem, "off");
});

test("MEM card toggles default on for legacy preferences and persist independently", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-memcards-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 const path = join(home, "sidebar-tabs.json");
 // Every existing preference shape keeps resolving, with the new card toggles on.
 for (const raw of [
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on"}',
 ]) {
  writeFileSync(path, raw);
  const result = resolveSidebarTabs(options);
  assert.deepEqual([result.memLocal, result.memCloud, result.malformed], ["on", "on", false], raw);
 }
 assert.deepEqual([resolveSidebarTabs(options).memLocal, resolveSidebarTabs(options).memCloud], ["on", "on"]);
 writeSidebarTabs("on", options, { main: "on", git: "on", mem: "on", memLocal: "off" });
 let persisted = resolveSidebarTabs(options);
 assert.deepEqual([persisted.memLocal, persisted.memCloud, persisted.mem], ["off", "on", "on"]);
 writeSidebarTabs("on", options, { main: "on", git: "on", mem: "on", memLocal: "on", memCloud: "off" });
 persisted = resolveSidebarTabs(options);
 assert.deepEqual([persisted.memLocal, persisted.memCloud], ["on", "off"]);
 // A partial chain (up to 10 keys) still resolves without the cloud key.
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"off"}');
 persisted = resolveSidebarTabs(options);
 assert.deepEqual([persisted.memLocal, persisted.memCloud, persisted.malformed], ["off", "on", false]);
 // A malformed memLocal value rejects the whole file.
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"maybe","memCloud":"on"}');
 assert.equal(resolveSidebarTabs(options).malformed, true);
});

test("STAT defaults off for every earlier preference shape and persists independently", t => {
 const home = mkdtempSync(join(tmpdir(), "sidebar-tabs-stat-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const options = { gentlePiConfigHome: home };
 const path = join(home, "sidebar-tabs.json");
 for (const raw of [
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"off","git":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"off","diff":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"on"}',
  '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"on","memCloud":"off"}',
 ]) {
  writeFileSync(path, raw);
  const result = resolveSidebarTabs(options);
  assert.deepEqual([result.stats, result.malformed], ["off", false], raw);
 }
 writeSidebarTabs("on", options, { main: "on", git: "on", stats: "on" });
 assert.equal(resolveSidebarTabs(options).stats, "on");
 writeSidebarTabs("off", options);
 assert.deepEqual([resolveSidebarTabs(options).policy, resolveSidebarTabs(options).stats], ["off", "on"]);
 writeSidebarTabs("on", options, { main: "on", git: "on", stats: "off" });
 assert.equal(resolveSidebarTabs(options).stats, "off");
 // The file the new build writes carries every earlier key unchanged: the last
 // legacy shape above is the one it started from, and only stats changed.
 const written = JSON.parse(readFileSync(path, "utf8"));
 assert.deepEqual([written.stats, written.memCloud, written.memLocal, written.mem, written.profile, written.tree, written.diff, written.gitHistory, written.git, written.main], ["off", "off", "on", "on", "on", "on", "on", "on", "on", "on"]);
 // A malformed stats value rejects the whole file.
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"on","memCloud":"on","stats":"maybe"}');
 assert.equal(resolveSidebarTabs(options).malformed, true);
 // An unknown key is still rejected: the ladder has no room for additions.
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"on","memCloud":"on","stats":"on","future":"on"}');
 assert.equal(resolveSidebarTabs(options).malformed, true);
 // Gaps in the ladder stay malformed, exactly as before this destination.
 writeFileSync(path, '{"schema":"gentle-pi.sidebar-tabs/v1","policy":"on","main":"on","git":"on","gitHistory":"on","diff":"on","tree":"on","profile":"on","mem":"on","memLocal":"on","stats":"on"}');
 assert.equal(resolveSidebarTabs(options).malformed, true);
});
