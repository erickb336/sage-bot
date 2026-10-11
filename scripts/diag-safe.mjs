// R723 diagnostic, removed before the end of the run: times safe() and its regexes on growing texts, to find what is slow on Node 22.
import { safe } from '../src/cards.js';

const time = (label, f) => { const t = process.hrtime.bigint(); f(); console.log(`${label}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms`); };
console.log(process.version, process.versions.v8);
for (const unit of ['abc', 'क्‍', 'ب‍']) {
  for (const n of [1024, 4096, 16384, 65536]) {
    const s = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    time(`safe ${JSON.stringify(unit)} ${n}`, () => safe(s));
  }
}
const TOKEN = /\p{RGI_Emoji}|./ysv;
const s = 'a'.repeat(65536);
time('TOKEN sticky exec 65536 times', () => { for (let i = 0; i < s.length; i++) { TOKEN.lastIndex = i; TOKEN.exec(s); } });
const NOSTICKY = /^(?:\p{RGI_Emoji}|.)/sv;
time('anchored exec on slice 65536 times', () => { for (let i = 0; i < 65536; i++) NOSTICKY.exec(s.slice(i, i + 16)); });
