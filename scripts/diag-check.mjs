// R723 diagnostic, removed before the end of the run: why `node --check` passes a file that does not parse on the runner.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

console.log('NODE_OPTIONS', JSON.stringify(process.env.NODE_OPTIONS), 'execPath', process.execPath, 'execArgv', process.execArgv);
const dir = mkdtempSync(`${tmpdir()}/diag-`);
for (const [name, text] of [['bad.js', 'export const x = (;\n'], ['bad.mjs', 'export const x = (;\n'], ['bad2.js', 'const x = (;\n']]) {
  writeFileSync(`${dir}/${name}`, text);
  for (const args of [['--check'], [], ['--check', '--no-experimental-detect-module']]) {
    const r = spawnSync(process.execPath, [...args, `${dir}/${name}`], { encoding: 'utf8' });
    console.log(name, args.join(' '), '->', r.status, r.signal, JSON.stringify(r.stdout.slice(0, 200)), JSON.stringify(r.stderr.slice(0, 200)));
  }
}
const env = Object.keys(process.env).filter((k) => /^(NODE|npm_|CI|RUNNER)/.test(k)).sort();
console.log('env names', env.join(' '));
