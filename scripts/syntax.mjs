// Syntax check of every .js and .mjs file in src/, test/, scripts/ and examples/ (node --check).
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const files = ['src', 'test', 'scripts', 'examples'].flatMap((dir) =>
  readdirSync(dir).filter((f) => /\.m?js$/.test(f)).map((f) => join(dir, f)));
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length} files`);
