import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export type SidebarTabsPolicy = "on" | "off";
const SCHEMA = "gentle-pi.sidebar-tabs/v1";
type Options = { gentlePiConfigHome?: string };
type Destinations = { main: SidebarTabsPolicy; git: SidebarTabsPolicy; gitHistory?: SidebarTabsPolicy; diff?: SidebarTabsPolicy; tree?: SidebarTabsPolicy; profile?: SidebarTabsPolicy; mem?: SidebarTabsPolicy; memLocal?: SidebarTabsPolicy; memCloud?: SidebarTabsPolicy; stats?: SidebarTabsPolicy };
// Destinations were added one release at a time, and each file that release
// wrote lists every destination known then. A file is readable when its
// destination keys are exactly the first N of this ladder, in any order: no
// earlier release wrote 1 or 3 keys, so a gap is still malformed or hand-edited.
const LADDER = ["main", "git", "gitHistory", "diff", "tree", "profile", "mem", "memLocal", "memCloud", "stats"] as const;
/** A file may stop after 0 or 2 destinations, or after 4 or more; 1 and 3 never existed. Key order never mattered. */
const ladderComplete = (present: readonly string[]): boolean => {
	const size = present.length;
	if (size !== 0 && size !== 2 && size < 4) return false;
	if (size > LADDER.length || !present.every(key => (LADDER as readonly string[]).includes(key))) return false;
	return LADDER.slice(0, size).every(key => present.includes(key));
};
/** Every destination the policy can store and the customizer can toggle, in rail order. */
export type SidebarTabsDestination = (typeof LADDER)[number];
export function resolveSidebarTabs(options: Options = {}): { policy: SidebarTabsPolicy; main: SidebarTabsPolicy; git: SidebarTabsPolicy; gitHistory: SidebarTabsPolicy; diff: SidebarTabsPolicy; tree: SidebarTabsPolicy; profile: SidebarTabsPolicy; mem: SidebarTabsPolicy; memLocal: SidebarTabsPolicy; memCloud: SidebarTabsPolicy; stats: SidebarTabsPolicy; malformed: boolean; globalFile: string } {
 const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "sidebar-tabs.json");
 const fallback = { policy: "off", main: "on", git: "on", gitHistory: "on", diff: "on", tree: "off", profile: "off", mem: "off", memLocal: "on", memCloud: "on", stats: "off", globalFile } as const;
 try {
  const value: unknown = JSON.parse(readFileSync(globalFile, "utf8"));
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
   const record = value as Record<string, unknown>;
   const validChoice = (key: string) => record[key] === "on" || record[key] === "off";
   const destinations = Object.keys(record).filter(key => key !== "schema" && key !== "policy");
   if (record.schema === SCHEMA && validChoice("policy") && ladderComplete(destinations) && destinations.every(validChoice)) return { policy: record.policy as SidebarTabsPolicy, main: record.main === "off" ? "off" : "on", git: record.git === "off" ? "off" : "on", gitHistory: record.gitHistory === "off" ? "off" : "on", diff: record.diff === "off" ? "off" : "on", tree: record.tree === "on" ? "on" : "off", profile: record.profile === "on" ? "on" : "off", mem: record.mem === "on" ? "on" : "off", memLocal: record.memLocal === "off" ? "off" : "on", memCloud: record.memCloud === "off" ? "off" : "on", stats: record.stats === "on" ? "on" : "off", malformed: false, globalFile };
  }
  return { ...fallback, malformed: true };
 } catch (error) {
  const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  return { ...fallback, malformed: !missing };
 }
}
export function writeSidebarTabs(policy: SidebarTabsPolicy, options: Options = {}, destinations?: Destinations): string {
 const current = resolveSidebarTabs(options);
 if (current.malformed) throw new Error(`Cannot update malformed or unreadable Tabs policy: ${current.globalFile}`);
 const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
 const temporary = `${current.globalFile}.${randomUUID()}.tmp`;
 mkdirSync(home, { recursive: true });
 try {
  const selected = { main: destinations?.main ?? current.main, git: destinations?.git ?? current.git, gitHistory: destinations?.gitHistory ?? current.gitHistory, diff: destinations?.diff ?? current.diff, tree: destinations?.tree ?? current.tree, profile: destinations?.profile ?? current.profile, mem: destinations?.mem ?? current.mem, memLocal: destinations?.memLocal ?? current.memLocal, memCloud: destinations?.memCloud ?? current.memCloud, stats: destinations?.stats ?? current.stats };
  writeFileSync(temporary, `${JSON.stringify({ schema: SCHEMA, policy, ...selected })}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, current.globalFile);
 } finally { try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ } }
 return current.globalFile;
}
