import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managedUpdatePlan, updateSelectedPi } from '../scripts/pi-update.mjs';
import { bundledUpdatePlan, bundledUpdateNext } from '../runtime/gentle-shell-bundled.mjs';

const PI = '@earendil-works/pi-coding-agent';
const piManifest = {name:PI,bin:{pi:'dist/bundle/cli.js'}};
function fixture({windows = false, adjacent = false, mismatch = false, badManifest = false, failed = false, npm = false, unrelated = false} = {}) {
 const base = windows ? 'C:/store' : '/store';
 const pi = `${base}/pi`;
 const shell = `${base}/shell`;
 const selected = `${pi}/dist/bundle/cli.js`;
 const mutations: string[][] = [];
 const modules = windows ? 'C:/pnpm/global/group/node_modules' : '/pnpm/global/group/node_modules';
 const dependencies = adjacent ? {'gentle-pi':{path:`${modules}/gentle-pi`}} : {[unrelated ? 'arbitrary-package' : PI]:{path:`${modules}/${unrelated ? 'arbitrary-package' : PI}`}};
 const group = {path:windows ? 'C:/pnpm/global' : '/pnpm/global',dependencies};
 return {
  mutations,
  input: {platform:windows ? 'win32' : 'linux',packageRoot:shell,
   runtime:{kind:adjacent ? 'bundled' : 'env',command:adjacent ? 'node' : selected,args:adjacent ? [selected] : []},
   adapters:{
    which:async (name: string) => name === (npm ? 'npm' : 'pnpm') ? `/fake/${name}` : null,
    fs:{realpath:async (value: string) => {
     const normalized = value.replaceAll('\\','/');
     if (normalized === `${modules}/gentle-pi`) return shell;
     if (normalized === `${modules}/${PI}`) return pi;
     if (normalized === `${shell}/node_modules/${PI}`) throw new Error('ENOENT: fabricated nested peer');
     return mismatch && value.endsWith('cli.js') && value.includes('\\') ? `${base}/other.js` : normalized;
    },
     readFile:async (value: string) => JSON.stringify(value.replaceAll('\\','/').startsWith(shell) ? {name:'gentle-pi'} : badManifest ? {name:'fake'} : piManifest)},
    run:async (_command: string, args: string[]) => {
     if(args.includes('list') || args.includes('ls')) return {code:failed ? 1 : 0,stdout:JSON.stringify(npm ? group : [group])};
     mutations.push(args); return {code:0};
    }
   }
  }
 };
}

test('prefix distribution still redirects self update and forwards only extensions for all', () => {
 assert.deepEqual(bundledUpdatePlan(['update']), {self:true});
 assert.deepEqual(bundledUpdateNext(bundledUpdatePlan(['update']), 0), {exitCode:0});
 assert.deepEqual(bundledUpdatePlan(['update','--all']), {self:true,piArgs:['update','--extensions']});
 assert.deepEqual(bundledUpdatePlan(['update','--extensions-only']), {self:false,piArgs:['update','--extensions-only']});
});

for (const args of [['update','--extensions-only'], ['update','--extensions'], ['update','npm:custom'], ['update','--models'], ['update','--help'], ['update','--unknown']]) test(`no ownership interception for ${args.join(' ')}`, () => {
 assert.deepEqual(managedUpdatePlan(args), {self:false,piArgs:args});
});

test('all strips only self update before forwarding extension flags', () => {
 assert.deepEqual(managedUpdatePlan(['update','--all','--approve']), {self:true,piArgs:['update','--extensions','--approve']});
});

for (const options of [{windows:true}, {windows:true,adjacent:true}, {npm:true}]) test(`linked global store update ${JSON.stringify(options)}`, async () => {
 const f = fixture(options);
 assert.equal(await updateSelectedPi(f.input), 0);
 assert.deepEqual(f.mutations, [options.npm ? ['install','-g',`${PI}@latest`,'--ignore-scripts'] : ['add','-g',options.adjacent ? 'gentle-pi@latest' : `${PI}@latest`, ...(options.adjacent ? ['--allow-build=gentle-pi'] : [])]]);
 assert.ok(f.mutations.every(args => args.every(arg => !arg.includes(','))));
});

for (const options of [{failed:true},{badManifest:true},{unrelated:true},{windows:true,mismatch:true}]) test(`ownership rejects without changing mutation log ${JSON.stringify(options)}`, async () => {
 const f = fixture(options);
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.mutations, []);
});

test('an unrelated selected override cannot authorize the adjacent Shell group', async () => {
 const f = fixture({adjacent:true});
 f.input.runtime = {kind:'env',command:'/unrelated/pi',args:[]};
 await assert.rejects(updateSelectedPi(f.input), /ownership/);
 assert.deepEqual(f.mutations, []);
});
