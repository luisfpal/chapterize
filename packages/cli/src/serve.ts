import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { contentType } from './media.js';
import { safeFile } from './paths.js';

export interface Listening {
  port: number;
  server: Server;
}

/**
 * Bind every interface. The phone is a different machine; localhost would make
 * the QR code a link the phone cannot open.
 */
export function startServer(dir: string, port: number): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => serveRequest(dir, req, res));
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      const addr = server.address();
      const actual = addr && typeof addr === 'object' ? addr.port : port;
      resolve({ port: actual, server });
    });
  });
}

/**
 * Low error correction keeps the code small, which is what a phone can frame
 * on a laptop screen. The URL is also printed, because a terminal can clip a
 * module and the scan then fails.
 */
export async function qrArt(url: string): Promise<string> {
  const art = await QRCode.toString(url, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'L',
  });
  return art.endsWith('\n') ? art : `${art}\n`;
}

function serveRequest(dir: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Only GET and HEAD are served.');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad path.');
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const file = safeFile(dir, pathname);
  if (!file) {
    notFound(res);
    return;
  }
  // realpath, not the requested path: a symlink inside the bundle must not
  // be a way out of it. A missing file is a 404, not a server error.
  let data: Buffer;
  try {
    const realRoot = realpathSync(dir);
    const real = realpathSync(file);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !statSync(real).isFile()) {
      notFound(res);
      return;
    }
    data = readFileSync(real);
  } catch {
    notFound(res);
    return;
  }
  const headers: Record<string, string | number> = {
    'Content-Type': contentType(file),
    'Content-Length': data.length,
    // Re-running the command should show up on refresh, not a cached chapter.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (file.endsWith('.epub')) {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  }
  if (file.toLowerCase().endsWith('.svg')) {
    // <img> does not run a script. Opening the SVG itself would, and it would
    // share this origin with the book. script-src 'none' blocks that, and
    // still lets the file render as an image.
    headers['Content-Security-Policy'] = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'";
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found.');
}
