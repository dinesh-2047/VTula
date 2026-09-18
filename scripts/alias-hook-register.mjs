import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Installs the `@/*` alias resolver for scripts run directly by Node.
 *
 * Separate from `alias-hook.mjs` because `register()` has to run on the main
 * thread while the hook itself runs on a loader thread — they cannot be the same
 * module. Loaded via `--import` in the `migrate` and `seed` npm scripts.
 */
register('./alias-hook.mjs', pathToFileURL(import.meta.filename));
