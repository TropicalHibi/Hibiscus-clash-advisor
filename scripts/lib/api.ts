// Minimal Clash of Clans API client for Node scripts (SPEC §3.3).
// The token is read from .env (COC_API_TOKEN) and is never printed or logged.
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { PROJECT_ROOT } from '../../src/data/loadNode';

export const API_BASE = 'https://api.clashofclans.com/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public apiMessage: string,
    public urlPath: string,
  ) {
    super(`HTTP ${status} on ${urlPath}: ${reason}${apiMessage ? ` — ${apiMessage}` : ''}`);
  }
}

export function loadToken(): string {
  loadDotenv({ path: path.join(PROJECT_ROOT, '.env'), quiet: true } as never);
  const t = process.env.COC_API_TOKEN?.trim();
  if (!t) {
    console.error('COC_API_TOKEN is missing. Put it in .env at the project root: COC_API_TOKEN=<your key from developer.clashofclans.com>');
    process.exit(1);
  }
  return t;
}

export interface ClientOptions {
  token: string;
  requestsPerSecond?: number;
  maxRetries?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { path: string; status: number; attempt: number; waitMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Encodes a player tag for a URL path ("#ABC" → "%23ABC"). */
export const encTag = (tag: string) => encodeURIComponent(tag.startsWith('#') ? tag : `#${tag}`);

export function createClient(opts: ClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const minGapMs = 1000 / Math.max(0.1, opts.requestsPerSecond ?? 10);
  const maxRetries = opts.maxRetries ?? 5;
  let nextSlot = 0;
  let requests = 0;

  async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(now, nextSlot) + minGapMs;
    if (wait > 0) await sleep(wait);
  }

  async function get<T>(urlPath: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      requests++;
      let res: Response;
      try {
        res = await fetchImpl(API_BASE + urlPath, { headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' } });
      } catch (e) {
        // Network error: retry like a 5xx.
        if (attempt >= maxRetries) throw e;
        const waitMs = backoff(attempt);
        opts.onRetry?.({ path: urlPath, status: 0, attempt: attempt + 1, waitMs });
        await sleep(waitMs);
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const waitMs = retryAfterMs(res.headers?.get?.('retry-after'), attempt);
        opts.onRetry?.({ path: urlPath, status: res.status, attempt: attempt + 1, waitMs });
        await sleep(waitMs);
        continue;
      }
      let reason = res.statusText;
      let message = '';
      try {
        const body = (await res.json()) as { reason?: string; message?: string };
        reason = body.reason ?? reason;
        message = body.message ?? '';
      } catch {
        /* non-JSON body */
      }
      throw new ApiError(res.status, reason, message, urlPath);
    }
  }

  return {
    get,
    get requestCount() {
      return requests;
    },
  };
}

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s (+ up to 250ms jitter), capped at 30s. */
export function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Wait before a retry: the server's Retry-After (seconds) when given and longer than our backoff, capped at 60s. */
export function retryAfterMs(header: string | null | undefined, attempt: number): number {
  const base = backoff(attempt);
  const sec = header ? Number(header) : NaN;
  return Number.isFinite(sec) && sec > 0 ? Math.min(60_000, Math.max(base, sec * 1000)) : base;
}

export type ApiClient = ReturnType<typeof createClient>;

// ── Response shapes (confirmed by scripts/probe.ts; see tests/fixtures/api/) ──
export interface ApiPage<T> {
  items: T[];
  paging?: { cursors?: { before?: string; after?: string } };
}
export interface ApiLocation {
  id: number;
  name: string;
  isCountry: boolean;
  countryCode?: string;
}
export interface ApiRankedPlayer {
  tag: string;
  name: string;
  expLevel?: number;
  trophies?: number;
  rank?: number;
  previousRank?: number;
  leagueTier?: { id: number; name: string };
  league?: { id: number; name: string };
  clan?: { tag: string; name: string };
}
export interface ApiBattle {
  battleType: string;
  attack: boolean;
  armyShareCode?: string;
  opponentPlayerTag?: string;
  stars: number;
  destructionPercentage: number;
  battleTimestamp?: string;
  opponentTownHallLevel?: number;
  battleTime?: string | number;
  [k: string]: unknown;
}
