/**
 * Test-suite safety guard: never TRUNCATE the developer's personal gbrain brain.
 *
 * The e2e helpers (`test/e2e/helpers.ts:setupDB`) and ~10 tests that connect
 * directly run destructive schema ops (`initSchema` + `TRUNCATE ... CASCADE`)
 * against `process.env.DATABASE_URL`. On a dev box, `~/.gbrain/.env` exports
 * `DATABASE_URL` pointing at the real brain (Postgres :5434/gbrain), so a bare
 * `bun test` wipes it (happened 2026-06-10: 336 pages → 6 rows mid-/ship).
 *
 * This guard runs as a bun test `preload` (see bunfig.toml). If `DATABASE_URL`
 * (or `GBRAIN_DATABASE_URL`) resolves to the same host:port/database as the
 * configured personal brain, it CLEARS the env var for the test run and warns,
 * so the e2e suite falls back to PGLite / skips real-Postgres tests instead of
 * truncating the brain. `GBRAIN_ALLOW_PROD_TEST=1` opts back in.
 *
 * CI is unaffected: there is no `~/.gbrain/config.json` there, so `configUrl`
 * is null and the guard is a no-op.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface DbTarget {
  host: string;
  port: string;
  database: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

function canonHost(h: string | null | undefined): string {
  const x = (h ?? '').toLowerCase();
  return LOOPBACK.has(x) ? 'localhost' : x;
}

/** Parse a postgres URL into {host, port, database}. Returns null if unparseable. */
export function parseDbTarget(url: string | null | undefined): DbTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: u.port || '5432',
      database: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

/**
 * True iff two postgres URLs point at the same database (loopback hosts
 * normalized; userinfo/query ignored). Unparseable input is never a match —
 * fail open to "different" only for the COMPARISON; the caller treats a
 * non-match as "safe to leave alone".
 */
export function isSameDatabase(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseDbTarget(a);
  const pb = parseDbTarget(b);
  if (!pa || !pb) return false;
  return canonHost(pa.host) === canonHost(pb.host) && pa.port === pb.port && pa.database === pb.database;
}

/** Read the configured personal brain's connection URL from ~/.gbrain/config.json. */
export function readBrainConfigUrl(): string | null {
  const home = process.env.GBRAIN_HOME || join(homedir(), '.gbrain');
  const cfgPath = join(home, 'config.json');
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    const url = cfg.connection || cfg.database_url;
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export type GuardAction = 'cleared' | 'no_match' | 'allowed_override';

export interface GuardResult {
  action: GuardAction;
  target?: DbTarget;
}

export interface GuardOpts {
  /** Personal brain URL to compare against. Defaults to readBrainConfigUrl(). */
  configUrl?: string | null;
  /** Sink for the warning line. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

/**
 * Clear DATABASE_URL / GBRAIN_DATABASE_URL on `env` when they point at the
 * personal brain. Pure-ish: env, configUrl, and warn are injectable so the
 * logic is unit-testable without touching the real environment.
 */
export function guardProdBrainFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: GuardOpts = {},
): GuardResult {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  if (env.GBRAIN_ALLOW_PROD_TEST === '1') return { action: 'allowed_override' };

  const configUrl = opts.configUrl !== undefined ? opts.configUrl : readBrainConfigUrl();
  const envUrl = env.GBRAIN_DATABASE_URL || env.DATABASE_URL;
  if (!envUrl || !configUrl) return { action: 'no_match' };
  if (!isSameDatabase(envUrl, configUrl)) return { action: 'no_match' };

  const target = parseDbTarget(envUrl)!;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  warn(
    `\n⚠️  gbrain test guard: DATABASE_URL pointed at your PERSONAL brain ` +
      `(${target.host}:${target.port}/${target.database}). The e2e suite TRUNCATEs ` +
      `all tables, so it has been UNSET for this test run to protect your data. ` +
      `Point DATABASE_URL at a throwaway test DB, or set GBRAIN_ALLOW_PROD_TEST=1 to override.\n`,
  );
  return { action: 'cleared', target };
}
