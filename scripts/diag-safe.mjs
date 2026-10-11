// R723 diagnostic, removed before the end of the run: finds which part of safe() is quadratic on Node 22.
import { safe } from '../src/cards.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(`${tmpdir()}/diag-`);
writeFileSync(`${dir}/bad.js`, 'export const x = (;\n');
const r = spawnSync(process.execPath, ['--check', `${dir}/bad.js`], { encoding: 'utf8' });
console.log('node --check bad.js:', r.status, r.signal, JSON.stringify(r.stderr.slice(0, 300)), 'TMPDIR', process.env.TMPDIR, 'tmpdir', tmpdir());

const time = (label, f) => { const t = process.hrtime.bigint(); const r = f(); console.log(`${label}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms`); return r; };
console.log(process.version, process.versions.v8);
const LETTER = /^[\p{L}--[ᅟᅠㅤﾠ]]$/v;
for (const n of [4096, 16384]) {
  const sliced = 'abc'.repeat(Math.ceil(n / 3)).slice(0, n);
  const flat = 'a'.repeat(n);
  const sticky = (s, re) => { let c = 0; for (let i = 0, t; i < s.length; i += t.length) { re.lastIndex = i; t = re.exec(s)[0]; c++; } return c; };
  time(`A sticky v, sliced abc ${n}`, () => sticky(sliced, /\p{RGI_Emoji}|./ysv));
  time(`B sticky v, flat aaa ${n}`, () => sticky(flat, /\p{RGI_Emoji}|./ysv));
  time(`C sticky v, abc made flat ${n}`, () => sticky([...sliced].join(''), /\p{RGI_Emoji}|./ysv));
  time(`D sticky u (no emoji) ${n}`, () => sticky(sliced, /./ysu));
  time(`E matchAll gv ${n}`, () => { let c = 0; for (const m of sliced.matchAll(/\p{RGI_Emoji}|./gsv)) c += m[0].length; return c; });
  time(`F LETTER.test per char ${n}`, () => { let c = 0; for (const ch of sliced) c += LETTER.test(ch); return c; });
  time(`G out += ${n}`, () => { let o = ''; for (const ch of sliced) o += ch; return o.length; });
  time(`H safe ${n}`, () => safe(sliced));
}
