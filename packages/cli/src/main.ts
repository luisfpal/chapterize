import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EpubError, must, openEpub } from '@chapterize/core';
import { buildBundle } from './bundle.js';
import { CliError } from './errors.js';
import { formatLength } from './html.js';
import {
  assertInside,
  assertSafeOut,
  bookFolderName,
  icloudBookDir,
  icloudRoot,
  lanAddress,
} from './paths.js';
import { qrArt, startServer } from './serve.js';
import { writeBundle } from './write.js';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  home: string;
  cwd: string;
}

export interface Args {
  epubPath: string;
  out?: string;
  icloud: boolean;
  epubs: boolean;
  serve: boolean;
  port: number;
}

export interface Running {
  /** Address printed for the phone, or null when this machine has no LAN IP. */
  url: string | null;
  localUrl: string;
  port: number;
  dir: string;
  close: () => Promise<void>;
}

const USAGE = `chapterize <book.epub> (--out <dir> | --icloud | --serve) [--epub] [--port n]

  --out <dir>   write the bundle into this folder
  --icloud      write into iCloud Drive/Chapterize/<book>, which the iPhone Files app shows
  --serve       serve it on this Wi-Fi and print a QR code
  --epub        also write one EPUB per chapter, to open in Books
  --port <n>    port for --serve (default 8732, 0 picks a free port)

With only --serve, the files live in a temporary folder until you stop the server.`;

export const HELP = `chapterize — one chapter per page, for a phone

${USAGE}

Open index.html. Each chapter is its own page, and the bar at the bottom moves
between them. The pages follow the phone's light and dark appearance.
`;

export function parseArgs(argv: string[]): { kind: 'help' } | { kind: 'run'; args: Args } {
  let out: string | undefined;
  let icloud = false;
  let epubs = false;
  let serve = false;
  let port = 8732;
  let sawPort = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = must(argv[i], 'argv[i]');
    if (token === '--help' || token === '-h') return { kind: 'help' };
    if (token === '--icloud') {
      icloud = true;
      continue;
    }
    if (token === '--epub') {
      epubs = true;
      continue;
    }
    if (token === '--serve') {
      serve = true;
      continue;
    }
    if (token === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new CliError(
          '--out needs a directory. Example: chapterize book.epub --out ~/Books/this-one',
        );
      }
      out = value;
      continue;
    }
    if (token === '--port') {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) > 65535) {
        throw new CliError('--port needs a number from 0 to 65535. Use 0 to pick a free port.');
      }
      port = Number(value);
      sawPort = true;
      continue;
    }
    if (token.startsWith('--'))
      throw new CliError(`Unknown option "${token}". Run chapterize --help.`);
    positionals.push(token);
  }

  if (positionals.length === 0) throw new CliError(`No EPUB was given.\n${USAGE}`);
  if (positionals.length > 1)
    throw new CliError(`Only one EPUB can be opened at a time.\n${USAGE}`);
  if (out !== undefined && icloud) {
    throw new CliError(
      'Pass --out or --icloud, not both. --icloud already chooses the folder inside iCloud Drive.',
    );
  }
  if (out === undefined && !icloud && !serve)
    throw new CliError(`Nowhere to put the book.\n${USAGE}`);
  if (sawPort && !serve) throw new CliError('--port applies only with --serve.');

  const args: Args = {
    epubPath: must(positionals[0], 'positionals[0]'),
    icloud,
    epubs,
    serve,
    port,
  };
  if (out !== undefined) args.out = out;
  return { kind: 'run', args };
}

export function realIo(): Io {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    home: homedir(),
    cwd: process.cwd(),
  };
}

/**
 * Build the bundle and, when asked, serve it. Returns a handle only while the
 * server is running; the caller keeps the process alive and closes it.
 */
export async function run(args: Args, io: Io): Promise<Running | null> {
  const epubPath = path.resolve(io.cwd, args.epubPath);
  if (!existsSync(epubPath)) throw new CliError(`Cannot read "${epubPath}": no such file.`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(epubPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot read "${epubPath}": ${message}`);
  }

  const book = openEpub(bytes);
  const { files, prepared } = buildBundle(book, { epubs: args.epubs });
  const folder = bookFolderName(book.metadata.title, book.metadata.author);

  let dest: string;
  let temporary = false;
  if (args.icloud) {
    const root = icloudRoot(io.home);
    if (!existsSync(root)) {
      throw new CliError(
        `iCloud Drive is not at ${root}. Turn it on, or pass --out with the folder you want on the phone — the Chapterize folder inside iCloud Drive works.`,
      );
    }
    dest = icloudBookDir(io.home, folder);
    // bookFolderName refuses "." and "..". This is the check that still
    // holds if a title ever resolves out of Chapterize/ another way.
    assertInside(path.join(root, 'Chapterize'), dest);
  } else if (args.out !== undefined) {
    dest = path.resolve(io.cwd, args.out);
    if (dest === epubPath)
      throw new CliError(`--out is the EPUB itself (${dest}). Pass a directory.`);
    assertSafeOut(dest, io.home);
  } else {
    dest = mkdtempSync(path.join(tmpdir(), 'chapterize-'));
    temporary = true;
  }

  try {
    writeBundle(dest, files);
  } catch (error) {
    // A failed serve-only run must not leave the book sitting in /tmp.
    if (temporary) rmSync(dest, { recursive: true, force: true });
    throw error;
  }

  const total = prepared.minutes.reduce((sum, n) => sum + n, 0);
  const count =
    prepared.chapters.length === 1 ? '1 chapter' : `${prepared.chapters.length} chapters`;
  io.stdout(`${count} · ~${formatLength(total)} · ${book.metadata.title}\n`);
  io.stdout(`${dest}\n`);
  if (args.icloud) {
    io.stdout(`\nOn your iPhone: Files → iCloud Drive → Chapterize → ${folder} → index.html\n`);
    io.stdout(`Or in Safari: Share → Add to Home Screen.\n`);
  } else if (!temporary) {
    io.stdout(
      `\nOpen index.html. To put it on the phone, pass --icloud or copy this folder into iCloud Drive.\n`,
    );
  }
  if (args.epubs) io.stdout(`One EPUB per chapter is in epub/. On the phone, open one in Books.\n`);
  for (const warning of prepared.warnings) io.stderr(`${warning}\n`);

  if (!args.serve) return null;

  let listening;
  try {
    listening = await startServer(dest, args.port);
  } catch (error) {
    if (temporary) rmSync(dest, { recursive: true, force: true });
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EADDRINUSE') {
      throw new CliError(
        `Port ${args.port} is already in use. Pass --port 0 to pick a free one, or another number.`,
      );
    }
    throw error;
  }

  const lan = lanAddress(networkInterfaces());
  const localUrl = `http://127.0.0.1:${listening.port}/`;
  const phoneUrl = lan ? `http://${lan}:${listening.port}/` : null;
  if (phoneUrl) {
    io.stdout(`\nOn this Wi-Fi, open:\n${phoneUrl}\n\n`);
    try {
      io.stdout(await qrArt(phoneUrl));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`Could not draw a QR code (${message}). Type the address instead.\n`);
    }
    io.stdout(`\nOn this machine: ${localUrl}\n`);
    io.stdout(`Anyone on this network can read the book until you stop this (Ctrl-C).\n`);
  } else {
    io.stdout(
      `\nNo LAN address found, so a phone on Wi-Fi cannot reach this server.\nOn this machine: ${localUrl}\n`,
    );
  }
  if (temporary) {
    io.stdout(
      `This copy is temporary and is deleted when the server stops. Pass --out or --icloud to keep it.\n`,
    );
  }

  return {
    url: phoneUrl,
    localUrl,
    port: listening.port,
    dir: dest,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        listening.server.close((error) => (error ? reject(error) : resolve()));
      });
      if (temporary) rmSync(dest, { recursive: true, force: true });
    },
  };
}

export async function execute(argv: string[], io: Io): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === 'help') {
      io.stdout(HELP);
      return 0;
    }
    const running = await run(parsed.args, io);
    if (running) await running.close();
    return 0;
  } catch (error) {
    if (error instanceof CliError || error instanceof EpubError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function entry(): Promise<void> {
  const io = realIo();
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.kind === 'help') {
      io.stdout(HELP);
      process.exit(0);
    }
    const running = await run(parsed.args, io);
    if (!running) process.exit(0);
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    if (error instanceof CliError || error instanceof EpubError) {
      io.stderr(`${error.message}\n`);
      process.exit(1);
    }
    io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  }
}

// Imported by tests as a library. Only the bin's process should serve.
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) void entry();
