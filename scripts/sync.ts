// npm run sync (Step 1 = minimal): update clash-of-clans-data and print the version.
// Snapshots, diffs and validation checks are Step 3 (SPEC §9).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/data/loadNode';

const pkgFile = path.join(PROJECT_ROOT, 'node_modules', 'clash-of-clans-data', 'package.json');
const readVersion = (): string => (fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version : 'not installed');

const before = readVersion();
console.log(`clash-of-clans-data before: ${before}`);
try {
  execSync('npm install clash-of-clans-data@latest', { cwd: PROJECT_ROOT, stdio: 'inherit' });
} catch (e) {
  console.error(`npm install failed: ${(e as Error).message}`);
  process.exit(1);
}
const after = readVersion();
console.log(`clash-of-clans-data after:  ${after}${after === before ? ' (unchanged)' : ' (UPDATED: restart npm run dev)'}`);
