# Current Snapshot

Updated: 2026-03-22

This file is the home for high-drift facts that change more often than the narrative docs should.
Use it for version baselines, repo-size snapshots, and similar volatile counts.
Do **not** use it as a behavior spec.

## Current Host And Tooling Snapshot

- package version: `0.1.0`
- required Node engine from `package.json`: `>=24.0.0`
- supported Node lines in CI: `24`, `25`
- live `codex --version`: `codex-cli 0.116.0`
- live `codex app-server --help` confirms:
  - `--listen stdio://` default transport
  - `--listen ws://IP:PORT` available
  - `generate-ts`
  - `generate-json-schema`

## Current Repo Size Snapshot

Measured against the current `src/` tree on 2026-03-21.

- production TypeScript: `57` files, `30,877` lines
- test TypeScript: `28` files, `22,260` lines

Largest current non-test modules:
- `src/service.ts` — `3125`
- `src/service/runtime-surface-controller.ts` — `2878`
- `src/telegram/ui-runtime.ts` — `2057`
- `src/service/interaction-broker.ts` — `1561`
- `src/activity/tracker.ts` — `1547`
- `src/service/turn-coordinator.ts` — `1427`
- `src/service/codex-command-coordinator.ts` — `1272`
- `src/install.ts` — `1064`
- `src/codex/app-server.ts` — `1014`
- `src/service/session-project-coordinator.ts` — `991`

Largest current test modules:
- `src/service.test.ts` — `8744`
- `src/service/runtime-surface-controller.test.ts` — `2130`
- `src/telegram/ui.test.ts` — `1608`
- `src/state/store.test.ts` — `1539`
- `src/activity/tracker.test.ts` — `1529`

## Refresh Hints

Refresh this file with live commands rather than memory.
Typical checks:

```bash
codex --version
codex app-server --help
node - <<'NODE'
const fs = require('fs');
const path = require('path');
function walk(dir){
  let res=[];
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,ent.name);
    if(ent.isDirectory()) res=res.concat(walk(p));
    else if(ent.isFile() && p.endsWith('.ts')) res.push(p);
  }
  return res;
}
const files=walk('src');
const prod=[], tests=[];
for(const f of files){
  const lines=fs.readFileSync(f,'utf8').split('\n').length;
  (f.endsWith('.test.ts') ? tests : prod).push([lines,f]);
}
const sum = (arr) => arr.reduce((a,[n]) => a + n, 0);
console.log({
  prodFiles: prod.length,
  prodLines: sum(prod),
  testFiles: tests.length,
  testLines: sum(tests)
});
NODE
```
