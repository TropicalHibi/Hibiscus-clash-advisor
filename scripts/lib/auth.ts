// Clash of Clans API token for `npm run meta` (SPEC §8.1). Two sources:
//   1. Developer-site login (COC_DEV_EMAIL / COC_DEV_PASSWORD): clashofclans.js logs in and returns a key
//      for the current public IP under a dedicated key name ("hibiscus-ci" in GitHub Actions,
//      "hibiscus-local" on the PC). It only revokes/creates keys with that exact name, so the owner's other
//      keys are never touched; a changed IP just replaces that one key.
//   2. COC_API_TOKEN (a fixed key), the old way, when no login is configured.
// The email, password and token are never printed. In GitHub Actions the token is masked
// (::add-mask::) the moment it exists, so it can't leak into later log lines.
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

export const CI_KEY_NAME = 'hibiscus-ci';
export const LOCAL_KEY_NAME = 'hibiscus-local';
export const KEY_DESCRIPTION = 'Hibiscus clash advisor (auto-managed by npm run meta; safe to revoke)';

/** clashofclans.js login: returns the key(s) for the current IP. Injected in tests. */
export type LoginFn = (o: { email: string; password: string; keyName: string; keyCount: number; keyDescription: string }) => Promise<string[]>;

export class AuthError extends Error {
  constructor(
    message: string,
    public kind: 'no-credentials' | 'login',
  ) {
    super(message);
  }
}

export const realLogin: LoginFn = async (o) => {
  const { RestManager } = await import('clashofclans.js');
  return new RestManager().login(o);
};

/** Removes secrets, tokens (JWT-like strings), email addresses and player tags from a message. */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let s = String(text);
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('[redacted]');
  return s
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/#[0-9A-Z]{3,}\b/g, '#[tag]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
}

export interface TokenSource {
  token: string;
  source: 'login' | 'token';
  keyName?: string;
}

export interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  /** Project root whose .env is read (locally). */
  root?: string;
  login?: LoginFn;
  /** Where ::add-mask:: goes (stdout in Actions). */
  print?: (line: string) => void;
}

/**
 * The token to use: developer-site login when COC_DEV_EMAIL + COC_DEV_PASSWORD are set (environment or
 * .env), else COC_API_TOKEN. In GitHub Actions (GITHUB_ACTIONS=true) the key name is "hibiscus-ci",
 * otherwise "hibiscus-local". Errors are AuthErrors with redacted messages.
 */
export async function obtainToken(o: AuthOptions = {}): Promise<TokenSource> {
  const env = o.env ?? process.env;
  if (o.root && !o.env) loadDotenv({ path: path.join(o.root, '.env'), quiet: true } as never);
  const ci = env.GITHUB_ACTIONS === 'true';
  const print = o.print ?? ((l: string) => console.log(l));
  const mask = (v: string) => {
    if (ci && v) print(`::add-mask::${v}`);
  };
  const email = env.COC_DEV_EMAIL?.trim();
  const password = env.COC_DEV_PASSWORD?.trim();
  if (email && password) {
    const keyName = ci ? CI_KEY_NAME : LOCAL_KEY_NAME;
    let keys: string[];
    try {
      keys = await (o.login ?? realLogin)({ email, password, keyName, keyCount: 1, keyDescription: KEY_DESCRIPTION });
    } catch (e) {
      throw new AuthError(`Developer-site login failed: ${redact((e as Error).message ?? String(e), [email, password])}`, 'login');
    }
    const token = keys?.[0]?.trim();
    if (!token) throw new AuthError('Developer-site login returned no API key.', 'login');
    mask(token);
    return { token, source: 'login', keyName };
  }
  const token = env.COC_API_TOKEN?.trim();
  if (token) {
    mask(token);
    return { token, source: 'token' };
  }
  throw new AuthError(
    ci
      ? 'No credentials: set the COC_DEV_EMAIL and COC_DEV_PASSWORD repository secrets.'
      : 'No credentials: put COC_DEV_EMAIL and COC_DEV_PASSWORD (or COC_API_TOKEN) in .env at the project root.',
    'no-credentials',
  );
}

/** True when a token can be obtained without asking (login credentials or a fixed token are configured). */
export function hasCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.COC_DEV_EMAIL?.trim() && env.COC_DEV_PASSWORD?.trim()) || env.COC_API_TOKEN?.trim());
}
