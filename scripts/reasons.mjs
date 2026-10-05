// The ballot reasons of one bridge gate for the chief: node scripts/reasons.mjs <gate file> <gate id>.
// The chief reads reasons only here, never from Discord. Each line is quoted data, cleaned for a model reader (src/clean.js).
import { load } from '../src/state.js';
import { forTerminal, reasonLines } from '../src/clean.js';

const [path, id] = process.argv.slice(2);
const entry = path && id ? load(path).entries.find((e) => e.gate.id === id || e.sage.includes(id)) : undefined;
if (!entry) {
  console.error(forTerminal(`no bridge gate ${id ?? ''}. Usage: node scripts/reasons.mjs <gate file> <gate id>`));
  process.exit(1);
}
const lines = reasonLines(entry);
console.log(lines.length ? lines.join('\n') : 'no reasons');
