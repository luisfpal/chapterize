#!/usr/bin/env node
import { register } from 'node:module';

// Type stripping is on by default from Node 22.18. Earlier 22s parse the
// sources as JavaScript and fail with a syntax error that names no fix.
const [major, minor] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 18)) {
  console.error(`Chapterize needs Node 22.18 or newer. This is ${process.version}.`);
  process.exit(1);
}

// Registered before the app is imported. See resolve-ts.js for why.
register(new URL('./src/resolve-ts.js', import.meta.url));

const { main } = await import('./src/main.ts');

try {
  const code = await main(process.argv.slice(2));
  if (code) process.exitCode = code;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
}
