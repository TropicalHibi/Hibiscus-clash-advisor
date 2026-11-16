// `predev` hook (SPEC §9a): runs before `npm run dev`; `npm run dev:fast` skips it.
// - git: `git pull --ff-only` first, so the local copy has what the daily data-update Action committed
// - game data: if the last check was >24h ago, ask npm for a newer clash-of-clans-data (same major) → `npm run sync`
// - meta: if public/meta.json is >24h old and .env has a token → `npm run meta`
// Every failure is a one-line warning; this script always exits 0 so the site starts anyway.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRefreshDeps, runRefresh } from './lib/nodeDeps';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
runRefresh(nodeRefreshDeps({ root: ROOT }));
process.exitCode = 0;
