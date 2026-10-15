#!/usr/bin/env node
/**
 * The reading code is TypeScript. This file is plain JS so `npx chapterize`
 * works, and it forwards Ctrl-C to the server it starts — killing only this
 * process would leave the book still being served.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const register = fileURLToPath(new URL('./register.js', import.meta.url));
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const child = spawn(process.execPath, [
  '--experimental-strip-types',
  '--import', register,
  entry,
  ...process.argv.slice(2),
], { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (code === null) process.exit(signal ? 0 : 1);
  process.exit(code);
});
