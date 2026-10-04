// A batch vote with two parts, from opening to the final answers. Sample ids and times only.
import { openGate, step, MINUTE } from '../src/vote.js';

const holders = new Set(['maya', 'jon', 'ana']);
const leads = new Set(['jon']);
const t0 = 1_800_000_000_000; // the bridge's own clock, in ms

let gate = openGate({ id: 'g1', kind: 'batch', parts: [['x', 'y'], ['p', 'q']], askedBy: 'owner', at: t0 });
const send = (event) => {
  const out = step(gate, event, holders, leads);
  gate = out.gate;
  for (const effect of out.effects) console.log(JSON.stringify(effect));
};

send({ type: 'press', by: 'maya', part: 0, option: 'x', at: t0 + MINUTE, via: 'discord' });
send({ type: 'press', by: 'ana', part: 0, option: 'x', at: t0 + 2 * MINUTE, via: 'discord', reason: 'cheaper' });
send({ type: 'press', by: 'jon', part: 1, option: 'p', at: t0 + 3 * MINUTE, via: 'discord' });
send({ type: 'press', by: 'ana', part: 1, option: 'q', at: t0 + 4 * MINUTE, via: 'discord' });
send({ type: 'tick', at: gate.endsAt }); // part 0 goes to x; part 1 is tied, so the batch stays open
send({ type: 'tiebreak', by: 'jon', part: 1, option: 'q', at: gate.endsAt + MINUTE, via: 'discord' });
console.log(gate.phase, JSON.stringify(gate.outcome));
