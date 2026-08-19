/**
 * Tier 0 chat distiller — `link_chat` cycle phase.
 *
 * Deterministic, zero-LLM, ~$0 (only one-time hub-stub embeddings). The
 * SessionEnd capture hook writes raw Claude Code transcripts to
 * `chat/<date>-<project>-<shortid>` with no links, so every capture lands as
 * an orphan. This phase gives each orphan `chat/` page an INBOUND link from a
 * per-project hub so it stops being an orphan.
 *
 * The hub is the brain's OWN hub when it has one (`projects/<project>/index`,
 * `projects/<project>`, matched across underscore/hyphen spelling); only when
 * nothing matches does the phase create `projects/<project>/_index`. Linking
 * into the existing structure rather than shadowing it is what keeps a brain
 * from growing a parallel hub namespace keyed on working-directory names. The
 * `/_index` fallback uses the suffix that orphan-reporting already excludes
 * (see `shouldExclude` in commands/orphans.ts), so there is no hub-chain
 * regress. Idempotent by construction: a linked page is no longer an orphan,
 * so it is not re-considered on the next tick.
 *
 * Captures whose derived "project" is a non-project working directory (`tmp`,
 * `home`, a user's own home-directory name) are skipped rather than turned
 * into hubs — see `DEFAULT_IGNORED_PROJECTS`.
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
 *   cycle.link_chat.ignore_projects    (DEFAULT_IGNORED_PROJECTS) comma-separated;
 *                                      replaces the default list wholesale
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

/**
 * Working directories that are not projects. The capture hook derives the
 * project from the session's cwd, so sessions started from a home directory,
 * `/tmp`, or a generic `site`/`web` folder would otherwise mint a hub for
 * something that isn't a project. Replaced wholesale (not extended) by
 * `cycle.link_chat.ignore_projects`, so an operator can name their own home
 * directory — the one non-project name this list can't know in advance.
 */
const DEFAULT_IGNORED_PROJECTS = [
  'tmp',
  'home',
  'projects',
  'src',
  'web',
  'site',
  'downloads',
  'desktop',
  'documents',
];

interface ResolvedConfig {
  enabled: boolean;
  maxPagesPerTick: number;
  slugPrefix: string;
  ignoreProjects: Set<string>;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxPages, slugPrefix, ignoreProjects] = await Promise.all([
    get('enabled'),
    get('max_pages_per_tick'),
    get('slug_prefix'),
    get('ignore_projects'),
  ]);

  const enabledFlag = (() => {
    if (enabled == null) return false;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const n = maxPages != null ? parseInt(maxPages, 10) : NaN;

  const ignoreList = (
    ignoreProjects && ignoreProjects.trim() ? ignoreProjects.split(',') : DEFAULT_IGNORED_PROJECTS
  )
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  return {
    enabled: enabledFlag,
    maxPagesPerTick: Number.isFinite(n) && n >= 1 ? n : 50,
    slugPrefix: slugPrefix && slugPrefix.trim() ? slugPrefix.trim() : 'chat/',
    ignoreProjects: new Set(ignoreList),
  };
}

/**
 * Candidate hub slugs for a project, most canonical first. A brain that already
 * keeps a hand-made hub (`projects/vatutinki`, `projects/ks2builder/index`)
 * should be linked INTO rather than shadowed by a second `_index` hub. The
 * underscore/hyphen variants catch the common mismatch between a working
 * directory (`crm_detailing`) and the page that documents it
 * (`projects/crm-detailing/index`).
 */
export function hubCandidates(project: string): string[] {
  const names = [...new Set([project, project.replace(/_/g, '-'), project.replace(/-/g, '_')])];
  // Hand-made hubs across EVERY spelling outrank an auto-created `_index` from
  // an earlier run, so a brain that accumulated duplicates converges on the
  // real hub instead of entrenching the split.
  const canonical = names.flatMap((n) => [
    `projects/${n}/index`,
    `projects/${n}/hub`,
    `projects/${n}`,
  ]);
  const autoCreated = names.map((n) => `projects/${n}/_index`);
  return [...canonical, ...autoCreated];
}

/**
 * Resolve the hub to link from: an existing page if the brain already has one,
 * otherwise null (the caller then creates the `_index` stub).
 */
async function findExistingHub(
  engine: BrainEngine,
  project: string,
  sourceId: string,
): Promise<string | null> {
  for (const slug of hubCandidates(project)) {
    const page = await engine.getPage(slug, { sourceId });
    if (page) return slug;
  }
  return null;
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
  let hubsReused = 0;
  let skippedUnparseable = 0;
  let skippedIgnored = 0;
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
    let srcReused = 0;
    let srcSkipped = 0;
    let srcIgnored = 0;
    let srcWould = 0;

    for (const o of chatOrphans) {
      if (processed >= cfg.maxPagesPerTick) break;
      const project = deriveProjectFromSlug(o.slug);
      if (!project) {
        skippedUnparseable++;
        srcSkipped++;
        continue;
      }
      if (cfg.ignoreProjects.has(project.toLowerCase())) {
        skippedIgnored++;
        srcIgnored++;
        continue;
      }
      processed++;

      if (opts.dryRun) {
        wouldLink++;
        srcWould++;
        continue;
      }

      const existingHub = await findExistingHub(engine, project, src.id);
      const hubSlug = existingHub ?? `projects/${project}/_index`;
      if (existingHub) {
        hubsReused++;
        srcReused++;
      } else {
        const created = await ensureHub(engine, hubSlug, project, src.id);
        if (created) {
          hubsCreated++;
          srcHubs++;
        }
      }
      // hub → chat: the chat page gains an inbound link and stops being an
      // orphan. ON CONFLICT DO NOTHING makes re-runs cheap and idempotent.
      await engine.addLink( // gbrain-allow-direct-insert: link_chat IS a cycle phase — the hub→chat edge is its reconcile output
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
      hubs_reused: srcReused,
      skipped_unparseable: srcSkipped,
      skipped_ignored: srcIgnored,
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
      hubs_reused: hubsReused,
      skipped_unparseable: skippedUnparseable,
      skipped_ignored: skippedIgnored,
      would_link: wouldLink,
      max_pages_per_tick: cfg.maxPagesPerTick,
      per_source: perSource,
    },
  };
}
