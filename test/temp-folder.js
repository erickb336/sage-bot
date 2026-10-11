// The one place where a test makes a temp folder (T57). Each folder goes when the test process exits, also when a test fails or
// the file stops with process.exit, so that `npm run check` leaves nothing in TMPDIR. Only a signal that kills the process (SIGKILL)
// skips it. Node runs each test file in its own process, so the folders of one file go at the end of that file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A new empty folder `<TMPDIR>/<prefix><random>` (or `<where>/<prefix><random>`), removed when the process exits. */
export function tempFolder(prefix, where = tmpdir()) {
  const dir = mkdtempSync(join(where, prefix));
  made.push(dir);
  return dir;
}
