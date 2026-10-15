/**
 * Node runs this package's TypeScript directly, but the source imports say
 * `.js` because TypeScript's bundler resolution wants that. Node will not
 * rewrite the suffix, so the command would die on the first import.
 *
 * Only relative `.js` specifiers are retried as `.ts`. Packages such as
 * qrcode stay `.js`.
 */

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier.slice(0, -3) + '.ts', context);
    } catch {
      // The .ts sibling is absent: it is a real JavaScript file.
    }
  }
  return nextResolve(specifier, context);
}
