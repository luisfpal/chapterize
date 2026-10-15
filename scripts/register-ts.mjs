import { existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * packages/core imports its siblings as `.js`. That is what TypeScript's
 * bundler resolution requires, and Node's type stripper does not rewrite it.
 * The file on disk is `.ts`, so the hook opens that.
 *
 * `registerHooks` is synchronous (Node 22.15+), which is why `--import` of
 * this file is enough: the hook is in place before the entry point loads.
 * A named import would fail earlier, with no message about which Node is required.
 */
if (typeof nodeModule.registerHooks !== 'function') {
  throw new Error(
    'scripts/register-ts.mjs needs Node.js 22.15 or newer (module.registerHooks). This runtime cannot load packages/core.',
  );
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const parent = fileURLToPath(context.parentURL);
      const candidate = resolvePath(dirname(parent), `${specifier.slice(0, -3)}.ts`);
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
