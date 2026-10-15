import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReaderModel } from '@chapterize/core';
import { bookIcon } from './icon.js';

/**
 * Writes the static site the phone installs.
 *
 * The directory is marked with chapterize.json. A later run may replace a
 * directory it created; it will not empty a directory it did not.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#fbf8f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141311" media="(prefers-color-scheme: dark)">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>Chapterize</title>
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./icon.png">
<link rel="icon" href="./icon.png">
<link rel="stylesheet" href="./reader.css">
<script src="./boot.js"></script>
</head>
<body>
<div id="app">Loading the book…</div>
<script type="module" src="./reader.js"></script>
</body>
</html>
`;

export function publicBook(model: ReaderModel): Omit<ReaderModel, 'images'> {
  return {
    id: model.id,
    title: model.title,
    author: model.author,
    language: model.language,
    startChapter: model.startChapter,
    chapters: model.chapters,
  };
}

export function shortName(title: string): string {
  const clean = title.trim() || 'Chapterize';
  if (clean.length <= 18) return clean;
  const cut = clean.slice(0, 18);
  const space = cut.lastIndexOf(' ');
  return (space > 8 ? cut.slice(0, space) : cut).trim();
}

export function manifestFor(model: ReaderModel): string {
  return JSON.stringify({
    name: model.title,
    short_name: shortName(model.title),
    display: 'standalone',
    background_color: '#141311',
    theme_color: '#141311',
    start_url: './',
    scope: './',
    lang: model.language || 'en',
    icons: [{ src: 'icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' }],
  });
}

/**
 * The shell is cached as a set, so one missing file does not abort install.
 * Figures are cached one by one: a huge plate must not take the text down
 * with it.
 *
 * Fetch tries the computer first, then the saved copy. Cache-first would
 * keep yesterday's chapter after he rebuilds the book and opens the same
 * icon. The short timeout is the train: an unreachable address must not
 * hang the page that already has a copy.
 */
export function serviceWorker(id: string, images: string[]): string {
  const shell = [
    './',
    './index.html',
    './reader.css',
    './reader.js',
    './boot.js',
    './book.json',
    './manifest.webmanifest',
    './icon.png',
  ];
  return `const CACHE = ${JSON.stringify(`chapterize-${id}`)};
const SHELL = ${JSON.stringify(shell)};
const IMAGES = ${JSON.stringify(images.map((name) => `./images/${name}`))};
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await Promise.all(IMAGES.map((url) => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const ext = url.pathname.slice(url.pathname.lastIndexOf('.') + 1).toLowerCase();
    const heavy = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), heavy ? 20000 : 2500);
    try {
      const response = await fetch(event.request, { signal: controller.signal });
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      return new Response('This book is not on the phone yet, and the computer is not serving it.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } finally {
      clearTimeout(timer);
    }
  })());
});
`;
}

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * The Home Screen icon is a URL. A new token on every run would make that
 * icon 404 the next morning, so a site this command already created keeps
 * the token it was given.
 */
export function existingSiteToken(dir: string): string | null {
  const markerPath = join(dir, 'chapterize.json');
  if (!existsSync(markerPath)) return null;
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { kind?: unknown; token?: unknown };
    if (marker.kind !== 'chapterize-site') return null;
    if (typeof marker.token !== 'string' || !TOKEN.test(marker.token)) return null;
    return marker.token;
  } catch {
    return null;
  }
}

export function prepareOutDir(dir: string): void {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlink (${dir}). Pass a real directory.`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${dir} is a file. Pass a directory to --out.`);
    }
    const marker = join(dir, 'chapterize.json');
    const entries = readdirSync(dir);
    if (entries.length > 0 && !existsSync(marker)) {
      throw new Error(
        `Refusing to overwrite ${dir}: it is not a Chapterize site. Pass an empty directory or one this command created.`,
      );
    }
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}

export function writeReaderSite(
  dir: string,
  model: ReaderModel,
  imageBytes: Map<string, Uint8Array>,
  token: string,
): void {
  if (!TOKEN.test(token)) throw new Error('The site token must be 32 hex characters.');
  prepareOutDir(dir);
  const marker = {
    kind: 'chapterize-site',
    id: model.id,
    title: model.title,
    chapters: model.chapters.length,
    // Read back on the next run. See existingSiteToken.
    token,
  };
  // Written first so a failed run still counts as ours and the next run can replace it.
  writeFileSync(join(dir, 'chapterize.json'), JSON.stringify(marker, null, 2) + '\n');
  writeFileSync(join(dir, 'index.html'), SHELL);
  writeFileSync(join(dir, 'reader.css'), readFileSync(join(HERE, 'reader.css')));
  writeFileSync(join(dir, 'reader.js'), readFileSync(join(HERE, 'reader.js')));
  writeFileSync(join(dir, 'boot.js'), readFileSync(join(HERE, 'boot.js')));
  writeFileSync(join(dir, 'book.json'), JSON.stringify(publicBook(model)));
  writeFileSync(join(dir, 'manifest.webmanifest'), manifestFor(model));
  writeFileSync(join(dir, 'sw.js'), serviceWorker(model.id, model.images.map((image) => image.fileName)));
  writeFileSync(join(dir, 'icon.png'), bookIcon());

  if (model.images.length) mkdirSync(join(dir, 'images'), { recursive: true });
  for (const image of model.images) {
    const bytes = imageBytes.get(image.sourcePath);
    if (!bytes) {
      throw new Error(
        `The book names an image that is not in the EPUB: ${image.sourcePath}. The chapter that uses it cannot be shown whole.`,
      );
    }
    writeFileSync(join(dir, 'images', image.fileName), bytes);
  }
}
