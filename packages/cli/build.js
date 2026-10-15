import { chmodSync } from 'node:fs';
import * as esbuild from 'esbuild';

// Node cannot run the core sources: they import "./types.js" while the file
// on disk is types.ts. A bundler resolves that. The result is one file the
// `chapterize` command can execute without a loader.
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/chapterize.js',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});

chmodSync('dist/chapterize.js', 0o755);
