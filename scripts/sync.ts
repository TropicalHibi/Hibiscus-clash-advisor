// npm run sync (SPEC §9): update clash-of-clans-data within the current major, validate it, and keep the
// last known-good version if the new one can't be loaded. Snapshots + diffs are Step 3.
// Exit codes: 0 up to date / updated, 1 failed or restored (so the predev refresh prints a warning).
import { PROJECT_ROOT } from '../src/data/loadNode';
import { nodeSyncDeps } from './lib/nodeDeps';
import { syncData } from './lib/sync';

const outcome = syncData(nodeSyncDeps({ root: PROJECT_ROOT }));
process.exitCode = outcome === 'up-to-date' || outcome === 'updated' ? 0 : 1;
