// Narrow update ownership proof. Deliberately independent of Shell upgrade/uninstall.
import { posix, win32 } from 'node:path';
import { bundledUpdatePlan } from '../runtime/gentle-shell-bundled.mjs';

const PI = '@earendil-works/pi-coding-agent';
const SHELL = 'gentle-pi';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const succeeded = result => result?.code === 0 && !result.timedOut && result.signal == null;
const refusal = detail => new Error(`gentle-shell update: ownership ${detail}; update Pi with the package manager or source checkout that supplies the selected runtime. No installation changed.`);

export function managedUpdatePlan(args) {
 // The legacy extension-only alias must never trigger self-update.
 if (args.includes('--extensions-only')) return {self:false, piArgs:args};
 return bundledUpdatePlan(args);
}

/** A single, listed package root must supply the exact selected executable.
 * pnpm v11 may list separate global groups whose packages resolve into a linked
 * store outside PNPM_HOME. Neither containment nor a package name proves ownership.
 */
export async function resolveUpdateOwner({runtime, packageRoot, platform = process.platform, adapters}) {
 const path = platform === 'win32' ? win32 : posix;
 const key = value => platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
 const canonical = async value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw refusal('has no absolute package path');
  const result = await adapters.fs.realpath(value);
  if (typeof result !== 'string' || !path.isAbsolute(result)) throw refusal('has an invalid canonical path');
  return result;
 };
 const selected = await canonical(runtime.args.length ? runtime.args[0] : runtime.command);
 const shellRoot = await canonical(packageRoot);
 const candidates = [];
 let invalid = false;
 for (const name of ['pnpm', 'npm']) {
  const invocation = adapters.invocation ? await adapters.invocation(name) : await adapters.which(name).then(command => command ? {command, prefix:[]} : null);
  if (!invocation) continue;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) { invalid = true; continue; }
  const argv = name === 'pnpm' ? ['list', '-g', '--depth', '0', '--json'] : ['ls', '-g', '--depth=0', '--json', '--long'];
  try {
   const result = await adapters.run(invocation.command, [...invocation.prefix, ...argv], {deadlineMs:30_000});
   if (!succeeded(result)) throw refusal('listing failed');
   const json = JSON.parse(result.stdout);
   const groups = name === 'pnpm' ? json : [json];
   if (!Array.isArray(groups) || groups.length === 0) throw refusal('listing is malformed');
   const entries = [];
   const topLevelGroups = new Map();
   for (const group of groups) {
    if (!object(group) || typeof group.path !== 'string' || !object(group.dependencies)) throw refusal('listing is malformed');
    for (const [pkg, dependency] of Object.entries(group.dependencies)) {
     if (!object(dependency) || !/^(?:@[^/\\\\]+\/)?[^/\\\\]+$/.test(pkg)) throw refusal('listing is malformed');
     // pnpm's JSON may aggregate several global groups. The dependency's
     // listed link location, not the aggregate group.path or canonical store
     // package root, identifies which old group add -g would remove.
     const listed = dependency.path;
     if (typeof listed !== 'string' || !path.isAbsolute(listed)) throw refusal('listed package path is missing');
     const modules = pkg.startsWith('@') ? path.dirname(path.dirname(listed)) : path.dirname(listed);
     if (path.basename(modules) !== 'node_modules' || key(path.join(modules, pkg)) !== key(listed)) throw refusal('listed top-level group is unknown');
     const groupRoot = await canonical(modules);
     const members = topLevelGroups.get(key(groupRoot)) ?? new Set();
     members.add(pkg);
     topLevelGroups.set(key(groupRoot), members);
     entries.push({pkg, dependency, groupRoot});
    }
   }
   for (const {pkg, dependency, groupRoot} of entries) {
     if (pkg !== PI && pkg !== SHELL) continue;
     if (dependency.link === true || [dependency.resolved, dependency.version].some(value => typeof value === 'string' && /^(?:file|link|workspace):/i.test(value))) throw refusal('listed supplier is a source or linked package');
     const root = await canonical(dependency.path);
     const manifest = JSON.parse(await adapters.fs.readFile(path.join(root, 'package.json'), 'utf8'));
     if (manifest.name !== pkg) throw refusal('listed package identity differs');
     let cli;
     if (pkg === PI) {
      if (manifest.bin?.pi !== 'dist/bundle/cli.js') throw refusal('listed Pi bin is unsupported');
      cli = await canonical(path.join(root, manifest.bin.pi));
      if (key(cli) !== key(path.join(root, manifest.bin.pi))) throw refusal('listed Pi package root does not supply its CLI');
     } else {
      // Only the actually selected adjacent peer can bind a supplying Shell
      // group; an env/PATH runtime cannot authorize reinstalling Shell.
      if (runtime.kind !== 'bundled' || key(root) !== key(shellRoot)) continue;
      // Resolve the actual peer link in the supplier's canonical global
      // node_modules. pnpm stores the peer beside Shell, not inside it.
      const peerRoot = await canonical(path.join(groupRoot, PI));
      const peer = JSON.parse(await adapters.fs.readFile(path.join(peerRoot, 'package.json'), 'utf8'));
      if (peer.name !== PI || peer.bin?.pi !== 'dist/bundle/cli.js') throw refusal('adjacent Pi identity differs');
      cli = await canonical(path.join(peerRoot, peer.bin.pi));
      if (key(cli) !== key(path.join(peerRoot, peer.bin.pi))) throw refusal('adjacent Pi package root does not supply its CLI');
     }
     if (key(cli) === key(selected)) {
      if (name === 'pnpm' && topLevelGroups.get(key(groupRoot)).size !== 1) throw refusal('selected supplier shares its global install group');
      candidates.push({name, ...invocation, package:pkg});
     }
   }
  } catch { invalid = true; }
 }
 if (invalid || candidates.length !== 1) throw refusal(candidates.length > 1 ? 'is ambiguous' : 'could not be verified from global listings');
 return candidates[0];
}

export async function updateSelectedPi(input) {
 let owner;
 try { owner = await resolveUpdateOwner(input); }
 catch (error) { throw error.message?.includes('ownership') ? error : refusal('could not be resolved'); }
 // Exactly one approved package per command; never create a comma group or
 // reinstall arbitrary dependencies merely because they share a store.
 const spec = `${owner.package}@latest`;
 const args = owner.name === 'pnpm' ? ['add', '-g', spec, ...(owner.package === SHELL ? ['--allow-build=gentle-pi'] : [])] : ['install', '-g', spec, ...(owner.package === PI ? ['--ignore-scripts'] : [])];
 const result = await input.adapters.run(owner.command, [...owner.prefix, ...args], {deadlineMs:20 * 60_000});
 if (!succeeded(result)) throw new Error(`gentle-shell update: ${owner.name} could not update ${owner.package}${result?.stderrTail ? `\n${result.stderrTail}` : ''}`);
 input.out?.(`${owner.name} completed the ${owner.package}@latest install request. The selected Pi version after installation has not been verified; rerun 'gentle-shell --version' to check it.`);
 return 0;
}
