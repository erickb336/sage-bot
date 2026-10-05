// The ballot reasons of one bridge gate for sage: node scripts/reasons.mjs <gate file> <gate id>.
// sage reads reasons only here, never from Discord. Each line is quoted data, cleaned for a model reader (src/clean.js).
import { load } from '../src/state.js';
import { forTerminal, reasonLines } from '../src/clean.js';

const fail = (message) => {
  console.error(forTerminal(`sage-bot reasons: ${message}`));
  process.exit(1);
};
const [path, id] = process.argv.slice(2);
let entries = [];
try {
  if (path && id) entries = load(path).entries;
} catch (e) {
  fail(e.message);
}
const entry = entries.find((e) => e.gate.id === id || e.sage.includes(id));
if (!entry) fail(`no bridge gate ${id ?? ''}. Usage: node scripts/reasons.mjs <gate file> <gate id>`);
const lines = reasonLines(entry);
console.log(lines.length ? lines.join('\n') : 'no reasons');
