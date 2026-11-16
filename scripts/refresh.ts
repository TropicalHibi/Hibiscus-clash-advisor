// `predev` hook (SPEC §9a): runs before `npm run dev`; `npm run dev:fast` skips it.
// - game data: if the last check was >24h ago, ask npm for a newer clash-of-clans-data → full `npm run sync`
// - meta: if public/meta.json is >24h old and .env has a token → `npm run meta`
// Every failure is a one-line warning; this script always exits 0 so the site starts anyway.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { refresh, type RefreshState } from './lib/refresh';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'data', 'refresh-state.json');
const META = path.join(ROOT, 'public', 'meta.json');
const PKG = path.join(ROOT, 'node_modules', 'clash-of-clans-data', 'package.json');

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

try {
  refresh({
    now: () => Date.now(),
    readState: () => readJson<RefreshState>(STATE) ?? {},
    writeState: (s) => {
      fs.mkdirSync(path.dirname(STATE), { recursive: true });
      fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
    },
    installedVersion: () => readJson<{ version?: string }>(PKG)?.version,
    latestVersion: () => {
      try {
        return execSync('npm view clash-of-clans-data version --fetch-retries=0 --fetch-timeout=10000', {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        const stderr = String((e as { stderr?: unknown }).stderr ?? '');
        const code = /npm error code (\S+)/.exec(stderr)?.[1] ?? ((e as { code?: string }).code === 'ETIMEDOUT' ? 'timed out' : undefined);
        throw new Error(`npm registry unreachable${code ? `: ${code}` : ''}`);
      }
    },
    runSync: () => {
      execSync('npm run sync', { cwd: ROOT, stdio: 'inherit', timeout: 10 * 60_000 });
    },
    metaGeneratedAt: () => {
      const t = Date.parse(readJson<{ generatedAt?: string | null }>(META)?.generatedAt ?? '');
      return Number.isFinite(t) ? t : undefined;
    },
    hasToken: () => {
      if (process.env.COC_API_TOKEN?.trim()) return true;
      try {
        return Boolean(parseDotenv(fs.readFileSync(path.join(ROOT, '.env'))).COC_API_TOKEN?.trim());
      } catch {
        return false;
      }
    },
    runMeta: () => {
      // stdout (progress + summary) is shown live; stderr is captured for the one-line warning.
      const r = spawnSync('npm run meta', { cwd: ROOT, shell: true, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 30 * 60_000 });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stderr: r.stderr ?? '' };
    },
    log: (line) => console.log(line),
  });
} catch (e) {
  console.log(`[refresh] warning: ${(e as Error).message}; starting the site anyway.`);
}
process.exitCode = 0;
