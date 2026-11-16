// `npm run push-meta` (SPEC §15): commit public/meta.json alone with "meta: <generatedAt>" and push to main.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_PATH, pushMeta } from './lib/pushMeta';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outcome = pushMeta({
  git: (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  readMeta: () => fs.readFileSync(path.join(ROOT, META_PATH), 'utf8'),
  log: (line) => console.log(line),
});
process.exitCode = outcome === 'pushed' || outcome === 'unchanged' ? 0 : 1;
