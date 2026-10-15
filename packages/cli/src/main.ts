import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openEpub, prepareReader, slugify, EpubError } from '@chapterize/core';
import QRCode from 'qrcode';
import { phoneUrls } from './lan.js';
import { serveSite } from './server.js';
import { existingSiteToken, writeReaderSite } from './site.js';

const HELP = `chapterize <book.epub> [--out dir] [--port n] [--host addr] [--no-serve]

Build a phone reader for one EPUB and serve it on this network.
Scan the QR code, then on iPhone choose Share → Add to Home Screen.

  --out       directory to write (default: ./chapterize-reader/<title>)
  --port      port to serve on (default: 4737)
  --host      bind address (default: 0.0.0.0). Use 127.0.0.1 to stay off Wi-Fi.
  --no-serve  write the site and exit
`;

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

const stdio: Io = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

interface Flags {
  help: boolean;
  file?: string;
  out?: string;
  port: number;
  host: string;
  serve: boolean;
}

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  let flags: Flags;
  try {
    flags = parse(argv);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.error(HELP);
    return 1;
  }
  if (flags.help) {
    io.log(HELP);
    return 0;
  }
  if (!flags.file) {
    io.error(HELP);
    return 1;
  }

  const file = resolve(flags.file);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    io.error(`No such file: ${file}\nChapterize does not download books. Pass an .epub you already have.`);
    return 1;
  }
  if (stat.isDirectory()) {
    io.error(`${file} is a directory. Pass one .epub file.`);
    return 1;
  }

  let model;
  let images: Map<string, Uint8Array>;
  try {
    const book = openEpub(new Uint8Array(readFileSync(file)));
    model = prepareReader(book);
    images = book.images;
  } catch (err) {
    if (err instanceof EpubError) io.error(err.message);
    else io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const out = flags.out ?? resolve('chapterize-reader', slugify(model.title));
  // Read before the directory is replaced. A fresh directory gets a new token.
  const token = existingSiteToken(out) ?? randomBytes(16).toString('hex');
  try {
    writeReaderSite(out, model, images, token);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!flags.serve) {
    io.log(written(model.title, model.chapters.length, out));
    return 0;
  }
  let serving;
  try {
    serving = await listen(out, token, flags.port, flags.host);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { urls, reachable } = phoneUrls(flags.host, serving.port, token);
  const qr = await QRCode.toString(urls[0] ?? '', { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  io.log(banner({
    title: model.title,
    author: model.author,
    chapters: model.chapters.length,
    minutes: model.chapters.reduce((sum, chapter) => sum + chapter.minutes, 0),
    urls,
    reachable,
    // Port 0 is a new port every run. A taken port moves too. Either one
    // breaks an icon that was saved against the previous address.
    stable: flags.port !== 0 && serving.port === flags.port,
    qr,
    dir: out,
  }));

  // Stay up until the process is killed. The caller that wants a return
  // (tests) passes --no-serve, or closes the server itself via serveSite.
  await new Promise(() => {});
  return 0;
}

async function listen(dir: string, token: string, port: number, host: string) {
  const first = port === 0 ? 0 : port;
  const attempts = port === 0 ? [0] : Array.from({ length: 10 }, (_, i) => port + i);
  let last: unknown;
  for (const candidate of attempts) {
    try {
      return await serveSite({ dir, token, port: candidate, host });
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') break;
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  throw new Error(`Could not listen on ${host}:${first}. ${why}`);
}

function written(title: string, chapters: number, dir: string): string {
  return `${title}\n${chapters} chapters written to ${dir}\nNothing is being served. Drop --no-serve to show a QR code.`;
}

function banner(info: {
  title: string;
  author: string | null;
  chapters: number;
  minutes: number;
  urls: string[];
  reachable: boolean;
  stable: boolean;
  qr: string;
  dir: string;
}): string {
  const length = info.minutes >= 120
    ? `${info.chapters} chapters · about ${Math.round(info.minutes / 60)} hours`
    : `${info.chapters} chapters · about ${info.minutes} min`;
  const lines = [
    '',
    info.title,
    info.author ?? '',
    length,
    '',
    'Open on your phone',
    '',
    ...(info.urls),
    '',
    info.qr.replace(/\s+$/, ''),
    '',
  ];
  if (!info.reachable) {
    lines.push('No other address was found. A phone cannot open 127.0.0.1 on this computer.');
    lines.push('Join a Wi-Fi network and run the command again.');
  } else if (info.urls.length > 1) {
    lines.push('If that code does not open, type one of the other addresses.');
  }
  lines.push('Anyone on this Wi-Fi who has the link can read the book.');
  if (info.stable) {
    lines.push('The link stays the same the next time you run this for this book, so a Home Screen icon keeps opening.');
    lines.push('It changes if this computer\'s address changes, or if the port is taken.');
  } else {
    lines.push('This port is only for this run. Pass a fixed --port if the Home Screen icon should keep working.');
  }
  lines.push('Progress and the sentences you write stay on the phone. They are not copied back here.');
  lines.push('Ctrl+C stops serving. The files remain in');
  lines.push(info.dir);
  lines.push('');
  return lines.filter((line, i, all) => !(line === '' && all[i - 1] === '' && i > 4)).join('\n');
}

function parse(argv: string[]): Flags {
  const flags: Flags = { help: false, port: 4737, host: '0.0.0.0', serve: true };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--no-serve') {
      flags.serve = false;
      continue;
    }
    if (arg === '--out' || arg === '--port' || arg === '--host') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.`);
      }
      if (arg === '--out') flags.out = resolve(value);
      else if (arg === '--host') flags.host = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error(`Port must be a whole number, not "${value}".`);
        const port = Number(value);
        if (port > 65535) throw new Error(`Port must be from 0 to 65535, not ${port}.`);
        flags.port = port;
      }
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }
  if (positionals.length > 1) throw new Error('Pass one .epub file.');
  const file = positionals[0];
  if (file !== undefined) flags.file = file;
  return flags;
}
