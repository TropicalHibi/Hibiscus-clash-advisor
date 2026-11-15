// npm run sync (Step 1 = minimal): update clash-of-clans-data and print the version.
// Snapshots + diffs are Step 3 (SPEC §9). Validation checks are printed as warnings (never block the site).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadGameDataNode, PROJECT_ROOT } from '../src/data/loadNode';
import { checkHeroCaps, checkLevels, checkMergeConsumption } from '../src/data/validate';

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

const data = loadGameDataNode();
console.log(`Max TH in data: ${data.maxTH} · hero book threshold: ${data.bookThresholdSec / 86400}d · items: ${data.items.size}`);
const issues = [...checkLevels(data), ...checkMergeConsumption(data), ...checkHeroCaps(data)];
if (!issues.length) console.log('Validation: all checks passed.');
for (const i of issues) console.log(`  [${i.level.toUpperCase()}] ${i.check}: ${i.message}`);
