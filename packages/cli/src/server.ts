import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

/**
 * Serves one generated site under an unguessable path.
 *
 * The book is on the LAN with no account. The token is the whole access
 * control: anyone who can see the terminal can read the book, and nobody
 * who merely shares the Wi-Fi can browse onto it. That limit is printed
 * next to the QR code; it is not a login system.
 */

const CSP = "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface Serving {
  port: number;
  close(): Promise<void>;
}

export function serveSite(options: {
  dir: string;
  token: string;
  port: number;
  host: string;
}): Promise<Serving> {
  const root = resolve(options.dir);
  const server = createServer((req, res) => {
    void handle(req.method ?? 'GET', req.url ?? '/', root, options.token, res).catch(() => {
      if (res.headersSent) return;
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The reader failed while reading a file.');
    });
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolveListen({ port, close: () => close(server) });
    });
  });
}

async function handle(
  method: string,
  rawUrl: string,
  root: string,
  token: string,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Only GET.');
    return;
  }

  let url: URL;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    notFound(res);
    return;
  }

  const prefix = `/${token}`;
  if (url.pathname === prefix) {
    res.writeHead(302, { Location: `${prefix}/` });
    res.end();
    return;
  }
  if (!url.pathname.startsWith(`${prefix}/`) || !sameToken(url.pathname.split('/')[1] ?? '', token)) {
    notFound(res);
    return;
  }

  let rel = url.pathname.slice(prefix.length + 1);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    notFound(res);
    return;
  }
  if (rel === '') rel = 'index.html';
  const file = inside(root, rel);
  if (!file) {
    notFound(res);
    return;
  }

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    notFound(res);
    return;
  }

  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // An EPUB can carry an SVG. Served as an image it cannot run script; opened
  // directly, the sandbox stops it from doing so anyway.
  const csp = extname(file).toLowerCase() === '.svg' ? "sandbox; default-src 'none'" : CSP;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Content-Length': body.length,
  });
  res.end(method === 'HEAD' ? undefined : body);
}

function notFound(res: import('node:http').ServerResponse): void {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end('Not found.');
}

function sameToken(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function inside(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (full === root) return null;
  return full;
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}
