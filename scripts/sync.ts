// npm run sync [-- --offline] (SPEC §9):
//   1. clash-of-clans-data (item images, TH weapons, backup source): newest within the current major,
//      known-good restore if it can't be loaded.
//   2. ClashKing static data (the game data): latest clashy.go release (main as fallback), downloaded at its
//      commit, validated, then pinned in data/clashking/; a file that fails keeps the previous copy.
//   3. Validation of the active data, snapshot + diff (public/data-changes.json), cross-check report.
// --offline skips npm and GitHub: validate + snapshot what's installed / pinned.
// Exit codes: 0 up to date / updated, 1 failed, restored or kept the previous ClashKing copy.
import { PROJECT_ROOT } from '../src/data/loadNode';
import { nodeFullSyncDeps } from './lib/nodeDeps';
import { syncAll } from './lib/sync';

const r = syncAll(nodeFullSyncDeps({ root: PROJECT_ROOT }), { offline: process.argv.includes('--offline') });
process.exitCode = r.outcome === 'up-to-date' || r.outcome === 'updated' ? 0 : 1;
