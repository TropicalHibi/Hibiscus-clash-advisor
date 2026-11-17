// npm run sync [-- --offline] (SPEC §9):
//   1. clash-of-clans-data (item images, TH weapons, backup source): newest within the current major,
//      known-good restore if it can't be loaded.
//   2. ClashKing static data (the game data): latest clashy.go release (main as fallback), downloaded at its
//      commit, validated, then pinned in data/clashking/; a file that fails keeps the previous copy.
//   3. Validation of the active data, snapshot + diff (public/data-changes.json), cross-check report.
//   4. Item images for new items (SPEC §13): items clash-of-clans-data has no picture for get one from ClashKing's
//      asset host or the Fandom wiki, resized to 96 px WebP in public/item-images-extra/ (never re-downloaded).
//      A lookup problem is a warning: it never changes the exit code.
// --offline skips npm, GitHub and the image lookups: validate + snapshot what's installed / pinned.
// Exit codes: 0 up to date / updated, 1 failed, restored or kept the previous ClashKing copy.
import { loadGameDataFresh, PKG_DIR, PROJECT_ROOT } from '../src/data/loadNode';
import { nodeExtraImageDeps, runExtraImages } from './lib/extraImages';
import { nodeFullSyncDeps } from './lib/nodeDeps';
import { syncAll } from './lib/sync';

const offline = process.argv.includes('--offline');
const r = syncAll(nodeFullSyncDeps({ root: PROJECT_ROOT }), { offline });
process.exitCode = r.outcome === 'up-to-date' || r.outcome === 'updated' ? 0 : 1;

if (!offline && r.outcome !== 'failed') {
  try {
    await runExtraImages(loadGameDataFresh(), await nodeExtraImageDeps(PROJECT_ROOT), PKG_DIR);
  } catch (e) {
    console.log(`  [WARN] item image lookup skipped: ${(e as Error).message}`);
  }
}
