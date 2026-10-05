// SAMPLE DATA ONLY for the tests and the preview: made-up people, role ids, tasks and questions
// from the approved T1 design. No real Discord ids, no real accounts.
import { openGate } from '../src/vote.js';

export const CONFIG = { driverRole: 'role-sample-driver', leadRole: 'role-sample-lead' };
const { driverRole, leadRole } = CONFIG;

/** The guild members as the bridge sees them: id, display name, role ids and whether the account is a bot. */
export const MEMBERS = [
  { id: 'sample-erick', name: 'Erick', roles: [driverRole, leadRole] },
  { id: 'sample-maya', name: 'Maya', roles: [driverRole] },
  { id: 'sample-jon', name: 'Jon', roles: [driverRole, leadRole] },
  { id: 'sample-sam', name: 'Sam', roles: [] },
  { id: 'sample-bridge', name: 'sage bridge', roles: [driverRole, leadRole], bot: true },
];
export const [ERICK, MAYA, JON, SAM, BRIDGE] = MEMBERS.map((m) => m.id);

/**
 * An ask: what the card shows about a gate, beside the gate itself. B3 builds it from sage's logbook.
 * `kind` and the option keys match the gate's `kind` and `options`; the labels are only for the card.
 */
export const ASKS = {
  G5: { kind: 'single', task: 'T8', title: 'Fix login timeout on mobile', parts: [
    { question: 'When a session expires on mobile, what does the user see?', why: 'A keeps the user in flow; the token refresh exists.',
      recommended: 'A', default: 'A',
      options: { A: 'Sign in again silently and keep the page', B: 'Show a "Session ended" screen with a Sign-in button', C: 'Ask first if the page has unsaved work' } },
  ] },
  B7: { kind: 'batch', task: 'T7', title: 'CSV export for reports', parts: [
    { question: 'Which columns go in the export?', why: 'A matches what the user sees; B can leak internal ids.', recommended: 'A',
      options: { A: 'Only the columns visible in the table', B: 'All fields, also the hidden ones', C: 'Visible columns, plus an "Include hidden fields" box' } },
    { question: 'How do dates look in the file?', why: 'A sorts well and every spreadsheet reads it.', recommended: 'A',
      options: { A: '2026-10-04 (ISO)', B: "04/10/2026 (the user's locale)", C: 'Both, in two columns' } },
    { question: 'What is the file name?', why: 'A is short and sorts by date.', recommended: 'A',
      options: { A: 'reports-2026-10-04.csv', B: 'The report title and the date' } },
  ] },
  B9: { kind: 'batch', task: 'T9', title: 'Empty state for the reports page', parts: [
    { question: 'What does the empty reports page show?', why: 'An example teaches the page in one look.', recommended: 'A',
      options: { A: 'An example report and a "Create report" button', B: 'Only a "Create report" button' } },
    { question: 'Does the empty page link to the help article?', why: 'The help article answers the top 3 support questions.', recommended: 'A',
      options: { A: 'Yes, under the button', B: 'No' } },
  ] },
};

/** A sample time: 2026-10-04 at hh:mm UTC. The preview renders times in UTC, so they read as in the design. */
export const clock = (hh, mm, ss = 0) => Date.UTC(2026, 9, 4, hh, mm, ss);

/** Open the gate of an ask, with the option keys of each part as the gate's options. */
export function openAsk(id, at, askedBy = ERICK) {
  const ask = ASKS[id];
  const keys = ask.parts.map((p) => Object.keys(p.options));
  return openGate(ask.kind === 'single' ? { id, kind: 'single', options: keys[0], askedBy, at } : { id, kind: 'batch', parts: keys, askedBy, at });
}
