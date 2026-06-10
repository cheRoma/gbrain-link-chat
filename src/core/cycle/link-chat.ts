/**
 * Tier 0 chat distiller — `link_chat` cycle phase.
 *
 * Deterministic, zero-LLM, ~$0 (only one-time hub-stub embeddings). The
 * SessionEnd capture hook writes raw Claude Code transcripts to
 * `chat/<date>-<project>-<shortid>` with no links, so every capture lands as
 * an orphan. This phase gives each orphan `chat/` page an INBOUND link from an
 * auto-created per-project hub (`projects/<project>/_index`) so it stops being
 * an orphan. The hub uses the `/_index` suffix that orphan-reporting already
 * excludes (see `shouldExclude` in commands/orphans.ts), so there is no
 * hub-chain regress. Idempotent by construction: a linked page is no longer an
 * orphan, so it is not re-considered on the next tick.
 *
 * Architecture mirrors `enrich-thin.ts` (per-source loop over `listSources`,
 * `PHASE_SCOPE='source'`), minus the LLM/budget machinery — linking is
 * deterministic, so the only throttle is `max_pages_per_tick`.
 *
 * Default OFF; enable with `gbrain config set cycle.link_chat.enabled true`.
 *
 * Config keys (defaults explicit):
 *   cycle.link_chat.enabled            (false)
 *   cycle.link_chat.max_pages_per_tick (50)      per source per tick
 *   cycle.link_chat.slug_prefix        ('chat/')
 */

import type { BrainEngine } from '../engine.ts';
import { listSources } from '../sources-ops.ts';
import { findOrphans } from '../../commands/orphans.ts';

export interface LinkChatPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface LinkChatPhaseResult {
  phase: 'link_chat';
  status: 'ok' | 'warn' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const CFG_PREFIX = 'cycle.link_chat';

/**
 * Derive the project name from a capture slug
 * `chat/YYYY-MM-DD-<project>-<shortid>[-pN]`. The short id is the first 8 hex
 * chars of the session id (or the literal `nosession`); `-pN` is the optional
 * multi-part suffix the hook appends to long transcripts. Returns null for
 * slugs that don't match the session-capture shape (probe/test pages,
 * hand-made notes), so callers skip them rather than mis-linking.
 */
export function deriveProjectFromSlug(slug: string): string | null {
  const m = slug.match(
    /^chat\/\d{4}-\d{2}-\d{2}-(.+)-(?:[0-9a-f]{6,}|nosession)(?:-p\d+)?$/,
  );
  if (!m) return null;
  const project = m[1].trim();
  return project.length > 0 ? project : null;
}

interface ResolvedConfig {
  enabled: boolean;
  maxPagesPerTick: number;
  slugPrefix: string;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxPages, slugPrefix] = await Promise.all([
    get('enabled'),
    get('max_pages_per_tick'),
    get('slug_prefix'),
  ]);

  const enabledFlag = (() => {
    if (enabled == null) return false;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const n = maxPages != null ? parseInt(maxPages, 10) : NaN;

  return {
    enabled: enabledFlag,
    maxPagesPerTick: Number.isFinite(n) && n >= 1 ? n : 50,
    slugPrefix: slugPrefix && slugPrefix.trim() ? slugPrefix.trim() : 'chat/',
  };
}

/**
 * Ensure `projects/<project>/_index` exists; create a stub if missing.
 * Returns true when a new hub was created (for accounting).
 */
async function ensureHub(
  engine: BrainEngine,
  hubSlug: string,
  project: string,
  sourceId: string,
): Promise<boolean> {
  const existing = await engine.getPage(hubSlug, { sourceId });
  if (existing) return false;
  await engine.putPage(
    hubSlug,
    {
      type: 'project',
      title: `${project} — project hub`,
      compiled_truth: `Auto-created hub for project \`${project}\`. Collects captured Claude Code sessions for this project.`,
      timeline: '',
      frontmatter: { auto_created_by: 'link_chat' },
    },
    { sourceId },
  );
  return true;
}

export async function runPhaseLinkChat(
  engine: BrainEngine,
  opts: LinkChatPhaseOpts = {},
): Promise<LinkChatPhaseResult> {
  const cfg = await loadCfg(engine);

  if (!cfg.enabled) {
    return {
      phase: 'link_chat',
      status: 'skipped',
      duration_ms: 0,
      summary: 'cycle.link_chat.enabled=false (default OFF)',
      details: {
        reason: 'disabled',
        enable_hint: 'gbrain config set cycle.link_chat.enabled true',
      },
    };
  }

  const startedAt = Date.now();
  const sources = await listSources(engine);

  let linked = 0;
  let hubsCreated = 0;
  let skippedUnparseable = 0;
  let wouldLink = 0;
  let chatOrphansTotal = 0;
  const perSource: Record<string, unknown> = {};

  for (const src of sources) {
    if (opts.signal?.aborted) throw new Error('aborted'); // propagates; cycle handles

    const result = await findOrphans(engine, { sourceId: src.id });
    const chatOrphans = result.orphans.filter((o) => o.slug.startsWith(cfg.slugPrefix));
    chatOrphansTotal += chatOrphans.length;

    let processed = 0;
    let srcLinked = 0;
    let srcHubs = 0;
    let srcSkipped = 0;
    let srcWould = 0;

    for (const o of chatOrphans) {
      if (processed >= cfg.maxPagesPerTick) break;
      const project = deriveProjectFromSlug(o.slug);
      if (!project) {
        skippedUnparseable++;
        srcSkipped++;
        continue;
      }
      processed++;

      if (opts.dryRun) {
        wouldLink++;
        srcWould++;
        continue;
      }

      const hubSlug = `projects/${project}/_index`;
      const created = await ensureHub(engine, hubSlug, project, src.id);
      if (created) {
        hubsCreated++;
        srcHubs++;
      }
      // hub → chat: the chat page gains an inbound link and stops being an
      // orphan. ON CONFLICT DO NOTHING makes re-runs cheap and idempotent.
      await engine.addLink(
        hubSlug,
        o.slug,
        'session capture',
        'session',
        'link-chat',
        undefined,
        undefined,
        { fromSourceId: src.id, toSourceId: src.id },
      );
      linked++;
      srcLinked++;
    }

    perSource[src.id] = {
      chat_orphans: chatOrphans.length,
      linked: srcLinked,
      hubs_created: srcHubs,
      skipped_unparseable: srcSkipped,
      would_link: srcWould,
    };
  }

  const summary = opts.dryRun
    ? `${wouldLink} chat page(s) would be linked across ${sources.length} source(s) (dry-run)`
    : `${linked} chat page(s) linked to ${hubsCreated} new hub(s) across ${sources.length} source(s)`;

  return {
    phase: 'link_chat',
    status: 'ok',
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      sources_count: sources.length,
      chat_orphans: chatOrphansTotal,
      linked,
      hubs_created: hubsCreated,
      skipped_unparseable: skippedUnparseable,
      would_link: wouldLink,
      max_pages_per_tick: cfg.maxPagesPerTick,
      per_source: perSource,
    },
  };
}
