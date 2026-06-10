/**
 * bun test preload: neutralize a DATABASE_URL that points at the developer's
 * personal gbrain brain so the destructive e2e suite can't TRUNCATE it.
 * Pure logic + tests live in `prod-brain-guard.ts`. See bunfig.toml `preload`.
 */
import { guardProdBrainFromEnv } from './prod-brain-guard.ts';

guardProdBrainFromEnv();
