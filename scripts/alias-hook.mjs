import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves the project's `@/*` path alias for scripts run directly by Node.
 *
 * The alias is declared in `tsconfig.json` and understood by the Next compiler,
 * which is all the application itself ever needs. A maintenance script is not
 * compiled by Next, so `import Certificate from '@/models/Certificate'` fails
 * there with `ERR_MODULE_NOT_FOUND` — and the alternative to teaching Node the
 * alias is re-declaring every Mongoose schema inside the script, which guarantees
 * the migration drifts away from the models it is migrating.
 *
 * Node 22 strips TypeScript types natively, so with this hook a script can import
 * the real models and the real constants with no build step and no new
 * dependency (`tsx` and `ts-node` are both absent, deliberately).
 *
 * Two things are handled that the bare alias substitution misses: an extensionless
 * specifier (`@/lib/constants`), which TypeScript permits and Node does not, and a
 * directory import resolving to `index.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('@/')) return next(specifier, context);

  const base = path.join(ROOT, 'src', specifier.slice(2));
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    // The empty extension is only a hit for a file that already carries one.
    if (ext === '' && !path.extname(candidate)) continue;
    if (existsSync(candidate)) {
      return next(pathToFileURL(candidate).href, context);
    }
  }

  // Nothing matched — hand the original specifier back so Node reports the
  // failure against the name the author actually wrote.
  return next(specifier, context);
}
