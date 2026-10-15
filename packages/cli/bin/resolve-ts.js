/**
 * Core is TypeScript that imports its own files as `.js` (the ESM convention).
 * Node's type stripper loads `.ts` but does not rewrite those specifiers, so a
 * direct import of `@chapterize/core` dies on `./types.js`. Rewrite a relative
 * `.js` import to the sibling `.ts` when that file is the one that exists.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const tsPath = path.resolve(parentDir, specifier.slice(0, -3) + '.ts');
    if (existsSync(tsPath)) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
