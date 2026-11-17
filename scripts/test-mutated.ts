// npm run test:mutated — the test suite on "the next data release" (REVIEW-2 #1, SPEC §13): a mutated copy of
// the pinned ClashKing data (a new Town Hall level, new top levels for a few items) in a temp dir, pointed to by
// CK_DATA_DIR. Rule tests must still pass; tests/current-data.test.ts (facts about today's pinned data) is skipped.
// Never touches the network or the committed data.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CK_DIR } from '../src/data/loadNode';
import { mutateForNextRelease } from './lib/mutateData';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-mutated-'));
try {
  const raw = JSON.parse(fs.readFileSync(path.join(CK_DIR, 'static_data.json'), 'utf8'));
  const pin = JSON.parse(fs.readFileSync(path.join(CK_DIR, 'pin.json'), 'utf8'));
  const maxTH = mutateForNextRelease(raw);
  fs.writeFileSync(path.join(dir, 'static_data.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, 'pin.json'), JSON.stringify({ ...pin, maxTH }));
  console.log(`test:mutated: TH${maxTH} + new top levels, data in ${dir}`);
  const r = spawnSync('npx', ['vitest', 'run', '--exclude', 'tests/current-data.test.ts', ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CK_DATA_DIR: dir },
  });
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
