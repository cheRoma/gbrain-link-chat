/**
 * Tier 0 chat distiller — `link_chat` cycle phase tests.
 *
 * Hermetic: drives `runPhaseLinkChat` against PGLite. The phase is fully
 * deterministic (zero LLM calls), so the REAL write path is exercised — no
 * gateway, no API key, no mock.module needed. The core behavior under test:
 * a raw orphan `chat/` capture gets an inbound link from an auto-created
 * per-project hub, so it stops being an orphan.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseLinkChat, deriveProjectFromSlug } from '../src/core/cycle/link-chat.ts';
import { findOrphans } from '../src/commands/orphans.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedChat(slug: string) {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: 'Raw Claude Code transcript capture.',
    timeline: '',
    frontmatter: {},
  });
}

describe('deriveProjectFromSlug', () => {
  test.each([
    ['chat/2026-06-10-studio-f7f20617', 'studio'],
    ['chat/2026-06-09-itis-market-readonly-aaf5b19c-p1', 'itis-market-readonly'],
    ['chat/2026-05-30-m-planner-a89d8b9a-p1', 'm-planner'],
    ['chat/2026-05-29-roma-242e4067', 'roma'],
    ['chat/2026-06-10-vatutinki-1b4e4efe', 'vatutinki'],
  ])('%s → %s', (slug, expected) => {
    expect(deriveProjectFromSlug(slug)).toBe(expected);
  });

  test.each([
    ['chat/__probe-large'],
    ['chat/sess-2026-06-03'],
    ['chat/upper-test'],
    ['notes/foo'],
  ])('%s → null (not a session-capture slug)', (slug) => {
    expect(deriveProjectFromSlug(slug)).toBeNull();
  });
});

describe('runPhaseLinkChat', () => {
  test('disabled by default → skipped with enable hint', async () => {
    const r = await runPhaseLinkChat(engine, {});
    expect(r.status).toBe('skipped');
    expect(r.details.reason).toBe('disabled');
    expect(String(r.details.enable_hint)).toContain('cycle.link_chat.enabled true');
  });

  test('enabled, no chat orphans → ok, nothing linked', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    const r = await runPhaseLinkChat(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.linked).toBe(0);
    expect(r.details.hubs_created).toBe(0);
  });

  test('links a chat orphan to an auto-created project hub, clearing its orphan status', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-06-10-studio-f7f20617');

    // precondition: the raw capture is an orphan
    const before = await findOrphans(engine, { sourceId: 'default' });
    expect(before.orphans.some((o) => o.slug === 'chat/2026-06-10-studio-f7f20617')).toBe(true);

    const r = await runPhaseLinkChat(engine, {});
    expect(r.status).toBe('ok');
    expect(r.details.linked).toBe(1);
    expect(r.details.hubs_created).toBe(1);

    // hub exists and uses the orphan-excluded /_index suffix
    const hub = await engine.getPage('projects/studio/_index', { sourceId: 'default' });
    expect(hub).toBeTruthy();

    // hub → chat link gives the chat page an inbound link
    const backlinks = await engine.getBacklinks('chat/2026-06-10-studio-f7f20617', { sourceId: 'default' });
    expect(backlinks.length).toBeGreaterThan(0);

    // chat page is no longer an orphan
    const after = await findOrphans(engine, { sourceId: 'default' });
    expect(after.orphans.some((o) => o.slug === 'chat/2026-06-10-studio-f7f20617')).toBe(false);
  });

  test('reuses an existing hub for a second session of the same project', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-06-10-studio-aaaaaaaa');
    await seedChat('chat/2026-06-11-studio-bbbbbbbb');

    const r = await runPhaseLinkChat(engine, {});
    expect(r.details.linked).toBe(2);
    expect(r.details.hubs_created).toBe(1); // one hub, two sessions
  });

  test('respects max_pages_per_tick cap', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await engine.setConfig('cycle.link_chat.max_pages_per_tick', '2');
    for (let i = 0; i < 5; i++) await seedChat(`chat/2026-06-10-proj${i}-0000000${i}`);

    const r = await runPhaseLinkChat(engine, {});
    expect(r.details.linked).toBe(2);
  });

  test('skips unparseable chat slugs (probe/test pages)', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/__probe-large');

    const r = await runPhaseLinkChat(engine, {});
    expect(r.details.linked).toBe(0);
    expect(r.details.skipped_unparseable).toBe(1);
  });

  test('idempotent: a second run links nothing new', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-06-10-studio-f7f20617');

    const r1 = await runPhaseLinkChat(engine, {});
    expect(r1.details.linked).toBe(1);

    const r2 = await runPhaseLinkChat(engine, {});
    expect(r2.details.linked).toBe(0);
  });

  test('dry-run counts candidates but writes nothing', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-06-10-studio-f7f20617');

    const r = await runPhaseLinkChat(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.would_link).toBe(1);
    expect(r.details.linked).toBe(0);

    const hub = await engine.getPage('projects/studio/_index', { sourceId: 'default' });
    expect(hub).toBeNull();
  });
});

describe('runPhaseLinkChat — existing hub reuse', () => {
  async function seedHub(slug: string) {
    await engine.putPage(slug, {
      type: 'hub',
      title: slug,
      compiled_truth: 'Hand-made project hub.',
      timeline: '',
      frontmatter: {},
    });
  }

  test('links from an existing projects/<name> hub instead of minting an _index duplicate', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedHub('projects/vatutinki');
    await seedChat('chat/2026-06-10-vatutinki-1b4e4efe');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.linked).toBe(1);
    expect(r.details.hubs_created).toBe(0);
    expect(await engine.getPage('projects/vatutinki/_index', { sourceId: 'default' })).toBeNull();

    const backlinks = await engine.getBacklinks('chat/2026-06-10-vatutinki-1b4e4efe', {
      sourceId: 'default',
    });
    expect(backlinks.map((b) => b.from_slug)).toContain('projects/vatutinki');
  });

  test('links from an existing projects/<name>/index hub', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedHub('projects/ks2builder/index');
    await seedChat('chat/2026-06-10-ks2builder-1b4e4efe');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.hubs_created).toBe(0);
    expect(await engine.getPage('projects/ks2builder/_index', { sourceId: 'default' })).toBeNull();

    const backlinks = await engine.getBacklinks('chat/2026-06-10-ks2builder-1b4e4efe', {
      sourceId: 'default',
    });
    expect(backlinks.map((b) => b.from_slug)).toContain('projects/ks2builder/index');
  });

  test('matches an existing hub across underscore/hyphen spelling', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedHub('projects/crm-detailing/index');
    await seedChat('chat/2026-07-26-crm_detailing-f4aa0ece');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.hubs_created).toBe(0);
    expect(await engine.getPage('projects/crm_detailing/_index', { sourceId: 'default' })).toBeNull();

    const backlinks = await engine.getBacklinks('chat/2026-07-26-crm_detailing-f4aa0ece', {
      sourceId: 'default',
    });
    expect(backlinks.map((b) => b.from_slug)).toContain('projects/crm-detailing/index');
  });

  test('prefers a real hub over a previously auto-created _index duplicate', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedHub('projects/crm-detailing/index');
    await seedHub('projects/crm_detailing/_index'); // legacy duplicate from an earlier run
    await seedChat('chat/2026-07-27-crm_detailing-88b08bbc');

    await runPhaseLinkChat(engine, {});

    const backlinks = await engine.getBacklinks('chat/2026-07-27-crm_detailing-88b08bbc', {
      sourceId: 'default',
    });
    expect(backlinks.map((b) => b.from_slug)).toContain('projects/crm-detailing/index');
    expect(backlinks.map((b) => b.from_slug)).not.toContain('projects/crm_detailing/_index');
  });

  test('still creates an _index hub when no existing hub matches', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-06-10-brandnew-1b4e4efe');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.hubs_created).toBe(1);
    expect(await engine.getPage('projects/brandnew/_index', { sourceId: 'default' })).toBeTruthy();
  });
});

describe('runPhaseLinkChat — ignored directories', () => {
  test('skips captures whose project is a non-project working directory', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await seedChat('chat/2026-07-26-tmp-90a07150');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.linked).toBe(0);
    expect(r.details.skipped_ignored).toBe(1);
    expect(await engine.getPage('projects/tmp/_index', { sourceId: 'default' })).toBeNull();
  });

  test('ignore list is configurable and replaces the default', async () => {
    await engine.setConfig('cycle.link_chat.enabled', 'true');
    await engine.setConfig('cycle.link_chat.ignore_projects', 'roma');
    await seedChat('chat/2026-07-26-roma-90a07150');
    await seedChat('chat/2026-07-26-tmp-90a07151');

    const r = await runPhaseLinkChat(engine, {});

    expect(r.details.skipped_ignored).toBe(1); // only `roma` is ignored now
    expect(r.details.linked).toBe(1); // `tmp` is no longer on the list
  });
});
