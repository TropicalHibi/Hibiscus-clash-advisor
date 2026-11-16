// `npm run push-meta` (SPEC §15): commit public/meta.json — and only that file — then push,
// so the GitHub Pages workflow redeploys the live site with the new meta. Never run automatically.

export const META_PATH = 'public/meta.json';
export const DEPLOY_BRANCH = 'main';

export interface PushMetaDeps {
  /** Runs `git <args>` in the repo root; returns stdout. Throws on a non-zero exit. */
  git(args: string[]): string;
  readMeta(): string;
  log(line: string): void;
}

export type PushMetaOutcome = 'unchanged' | 'wrong-branch' | 'pushed' | 'push-failed';

export function pushMeta(d: PushMetaDeps): PushMetaOutcome {
  if (!d.git(['status', '--porcelain', '--', META_PATH]).trim()) {
    d.log(`[push-meta] ${META_PATH} is unchanged; nothing to push.`);
    return 'unchanged';
  }
  const branch = d.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== DEPLOY_BRANCH) {
    d.log(`[push-meta] on branch "${branch}"; the live site deploys from ${DEPLOY_BRANCH}. Switch to ${DEPLOY_BRANCH} and run it again.`);
    return 'wrong-branch';
  }
  let generatedAt = 'unknown';
  try {
    const g = (JSON.parse(d.readMeta()) as { generatedAt?: unknown }).generatedAt;
    if (typeof g === 'string' || typeof g === 'number') generatedAt = String(g);
  } catch {
    // Unreadable meta.json still gets committed; the message just says "unknown".
  }
  d.git(['add', '--', META_PATH]);
  // `commit --only -- <path>` commits that path alone and leaves anything else that was staged untouched.
  d.git(['commit', '--only', '-m', `meta: ${generatedAt}`, '--', META_PATH]);
  d.log(`[push-meta] committed ${META_PATH} (meta: ${generatedAt}); pushing…`);
  try {
    d.git(['push', 'origin', DEPLOY_BRANCH]);
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split(/\r?\n/).find((l) => l.trim()) ?? 'git push failed';
    d.log(`[push-meta] push failed (${first.trim().slice(0, 200)}). The commit is kept; fix it (e.g. git pull --rebase) and run git push.`);
    return 'push-failed';
  }
  d.log('[push-meta] pushed; the GitHub Pages workflow will redeploy the live site in a minute or two.');
  return 'pushed';
}
