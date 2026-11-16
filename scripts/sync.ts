// npm run sync [-- --offline] (SPEC §9): update clash-of-clans-data within the current major, validate it,
// keep the last known-good version if the new one can't be loaded, then snapshot the normalized data and
// print the diff vs the previous snapshot (also saved to public/data-changes.json for the site banner).
// --offline skips npm entirely: validate + snapshot the installed version.
// Exit codes: 0 up to date / updated, 1 failed or restored (so the predev refresh prints a warning).
import { PROJECT_ROOT } from '../src/data/loadNode';
import { nodeSyncDeps } from './lib/nodeDeps';
import { syncData } from './lib/sync';

const outcome = syncData(nodeSyncDeps({ root: PROJECT_ROOT }), { offline: process.argv.includes('--offline') });
process.exitCode = outcome === 'up-to-date' || outcome === 'updated' ? 0 : 1;
