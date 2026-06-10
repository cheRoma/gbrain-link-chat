/**
 * Guard that stops the test suite from TRUNCATEing the developer's personal
 * gbrain brain. The e2e helpers (`test/e2e/helpers.ts:setupDB`) and ~10 direct
 * connectors run destructive schema ops against `$DATABASE_URL`. When that URL
 * points at the user's real brain (`~/.gbrain/config.json` connection), the
 * suite wipes it. This guard neutralizes that by clearing the env var for the
 * test run. Pinned here so the guard logic can't silently regress.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseDbTarget,
  isSameDatabase,
  guardProdBrainFromEnv,
} from './helpers/prod-brain-guard.ts';

const PROD = 'postgresql://gbrain:secret@127.0.0.1:5434/gbrain';

describe('isSameDatabase', () => {
  test('same host:port/db → true (userinfo differs)', () => {
    expect(isSameDatabase(PROD, 'postgresql://other:pw@127.0.0.1:5434/gbrain')).toBe(true);
  });
  test('localhost ≡ 127.0.0.1 (loopback normalized)', () => {
    expect(isSameDatabase(PROD, 'postgresql://gbrain:secret@localhost:5434/gbrain')).toBe(true);
  });
  test('different database name → false', () => {
    expect(isSameDatabase(PROD, 'postgresql://gbrain:secret@127.0.0.1:5434/gbrain_test')).toBe(false);
  });
  test('different port → false', () => {
    expect(isSameDatabase(PROD, 'postgresql://gbrain:secret@127.0.0.1:5433/gbrain')).toBe(false);
  });
  test('unparseable input → false (never a false match)', () => {
    expect(isSameDatabase('not-a-url', PROD)).toBe(false);
    expect(isSameDatabase(PROD, '')).toBe(false);
  });
});

describe('parseDbTarget', () => {
  test('extracts host/port/database, defaults port 5432', () => {
    expect(parseDbTarget('postgresql://u:p@db.example.com/mydb')).toEqual({
      host: 'db.example.com',
      port: '5432',
      database: 'mydb',
    });
  });
});

describe('guardProdBrainFromEnv', () => {
  test('clears DATABASE_URL when it matches the personal brain', () => {
    const env: Record<string, string> = { DATABASE_URL: PROD };
    const warned: string[] = [];
    const r = guardProdBrainFromEnv(env, { configUrl: PROD, warn: (m) => warned.push(m) });
    expect(r.action).toBe('cleared');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(warned.length).toBe(1);
  });

  test('also clears GBRAIN_DATABASE_URL', () => {
    const env: Record<string, string> = { GBRAIN_DATABASE_URL: PROD };
    const r = guardProdBrainFromEnv(env, { configUrl: PROD, warn: () => {} });
    expect(r.action).toBe('cleared');
    expect(env.GBRAIN_DATABASE_URL).toBeUndefined();
  });

  test('leaves a non-matching DATABASE_URL alone', () => {
    const testUrl = 'postgresql://gbrain:secret@127.0.0.1:5434/gbrain_test';
    const env: Record<string, string> = { DATABASE_URL: testUrl };
    const r = guardProdBrainFromEnv(env, { configUrl: PROD, warn: () => {} });
    expect(r.action).toBe('no_match');
    expect(env.DATABASE_URL).toBe(testUrl);
  });

  test('GBRAIN_ALLOW_PROD_TEST=1 overrides the guard', () => {
    const env: Record<string, string> = { DATABASE_URL: PROD, GBRAIN_ALLOW_PROD_TEST: '1' };
    const r = guardProdBrainFromEnv(env, { configUrl: PROD, warn: () => {} });
    expect(r.action).toBe('allowed_override');
    expect(env.DATABASE_URL).toBe(PROD);
  });

  test('no config (e.g. CI) → never fires', () => {
    const env: Record<string, string> = { DATABASE_URL: PROD };
    const r = guardProdBrainFromEnv(env, { configUrl: null, warn: () => {} });
    expect(r.action).toBe('no_match');
    expect(env.DATABASE_URL).toBe(PROD);
  });

  test('no DATABASE_URL set → no-op', () => {
    const env: Record<string, string> = {};
    const r = guardProdBrainFromEnv(env, { configUrl: PROD, warn: () => {} });
    expect(r.action).toBe('no_match');
  });
});
