import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { openEpub, planStudyPacks, STUDY_WORD_FLOOR, type Book, type StudyPlan } from '@chapterize/core';

/**
 * The command Luis runs. It reads an EPUB and writes files. It does not
 * open a network connection: the prompt file is for him to paste, on his
 * phone, into whatever model he is using.
 */

export interface Io {
  readFile(path: string): Uint8Array;
  writeFile(path: string, body: string): void;
  mkdir(path: string): void;
  log(line: string): void;
  error(line: string): void;
}

export function defaultIo(): Io {
  return {
    readFile: (path) => new Uint8Array(readFileSync(path)),
    writeFile: (path, body) => writeFileSync(path, body),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

interface ParsedStudy {
  help: boolean;
  epubPath?: string;
  outDir: string;
  mode: 'offline' | 'prompt' | 'both';
  chapters: number[];
  all: boolean;
}

function take(argv: string[], index: number, flag: string): string {
  const inline = argv[index];
  if (inline === undefined) throw new Error(`${flag} needs a value.`);
  const eq = inline.indexOf('=');
  if (eq >= 0) return inline.slice(eq + 1);
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`${flag} needs a value.`);
  }
  return next;
}

function consumedInline(arg: string): boolean {
  return arg.includes('=');
}

export function parseStudyArgs(argv: string[]): ParsedStudy {
  let help = false;
  let outDir = 'study';
  let mode: ParsedStudy['mode'] = 'both';
  let all = false;
  const chapters: number[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      outDir = take(argv, i, '--out');
      if (!consumedInline(arg)) i += 1;
      continue;
    }
    if (arg === '--mode' || arg.startsWith('--mode=')) {
      const value = take(argv, i, '--mode');
      if (!consumedInline(arg)) i += 1;
      if (value !== 'offline' && value !== 'prompt' && value !== 'both') {
        throw new Error(`Unknown mode "${value}". Use offline, prompt, or both.`);
      }
      mode = value;
      continue;
    }
    if (arg === '--chapter' || arg.startsWith('--chapter=')) {
      const value = take(argv, i, '--chapter');
      if (!consumedInline(arg)) i += 1;
      if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`--chapter needs a chapter number, not "${value}".`);
      }
      chapters.push(Number(value));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}".`);
    positionals.push(arg);
  }

  if (positionals.length > 1) throw new Error('Give one EPUB.');
  const epubPath = positionals[0];
  return {
    help,
    outDir,
    mode,
    chapters,
    all,
    ...(epubPath !== undefined ? { epubPath } : {}),
  };
}

export function studyHelp(): string {
  return `chapterize study — a study pack for each chapter

Usage:
  chapterize study <book.epub> [--out dir] [--mode offline|prompt|both]
                                [--chapter n]... [--all]

offline   Markdown and HTML you can open on a phone. The outline keeps
          every heading and every sentence. A separate “Why it matters”
          section quotes the author when the chapter gives a reason;
          otherwise it names the neighboring step. Questions are recall,
          then deeper. Nothing is sent anywhere.

prompt    One Markdown file per chapter, ready to paste into a model.
          Optional. Chapterize does not call one.

both      Write all three files. This is the default.

--out     Directory to write. Created if missing. Default: ./study
--chapter 1-based chapter number, after the same split the app uses.
          Repeat the flag for several chapters. Default: every chapter.
--all     Also write chapters under ${STUDY_WORD_FLOOR} words (covers, blank pages).

The book is read locally.
`;
}

const ROOT_HELP = `chapterize — one chapter at a time

Usage:
  chapterize study <book.epub> [options]

study    Write a study pack for each chapter. The HTML opens on a phone.
         The prompt file is what you paste into Grok. Nothing is sent.

Run chapterize study --help for the options.
`;

/**
 * A chapter title is data from a book. It must not be able to choose a
 * directory, or a hostile title writes outside the folder the user named.
 */
export function outputPath(dir: string, filename: string): string | undefined {
  if (filename.length === 0 || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    return undefined;
  }
  const root = resolve(dir);
  const dest = resolve(root, filename);
  const rel = relative(root, dest);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return dest;
}

function summarize(plan: StudyPlan, outDir: string): string {
  const lines: string[] = [];
  if (plan.files.length === 0) {
    lines.push('No chapter was long enough to study.');
    lines.push('Pass --all to write the short ones too.');
  } else {
    const bases = new Set(plan.files.map((file) => file.filename.replace(/-(study|prompt)\.(md|html)$/, '')));
    const chapters = bases.size;
    const files = plan.files.length;
    lines.push(
      `Wrote ${chapters} ${chapters === 1 ? 'chapter' : 'chapters'} (${files} ${files === 1 ? 'file' : 'files'}) to ${outDir}/`,
    );
    const hasHtml = plan.files.some((file) => file.filename.endsWith('.html'));
    const hasPrompt = plan.files.some((file) => file.filename.endsWith('-prompt.md'));
    if (hasHtml) lines.push('Open a .html file on your phone.');
    if (hasPrompt) {
      lines.push('Paste a .prompt.md file into Grok when you want the model to write the pack. Chapterize does not call one.');
    }
  }
  if (plan.skipped.length > 0) {
    const shown = plan.skipped
      .map((chapter) => `${chapter.position}. ${chapter.title} (${chapter.words} ${chapter.words === 1 ? 'word' : 'words'})`)
      .join('; ');
    lines.push(`Skipped ${plan.skipped.length} under ${STUDY_WORD_FLOOR} words: ${shown}.`);
    lines.push('Pass --all to include them, or name one with --chapter.');
  }
  return lines.join('\n');
}

function runStudy(argv: string[], io: Io): number {
  let parsed: ParsedStudy;
  try {
    parsed = parseStudyArgs(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(studyHelp());
    return 1;
  }
  if (parsed.help) {
    io.log(studyHelp());
    return 0;
  }
  if (parsed.epubPath === undefined) {
    io.error('Give the path to an EPUB.');
    io.error(studyHelp());
    return 1;
  }

  let bytes: Uint8Array;
  try {
    bytes = io.readFile(parsed.epubPath);
  } catch {
    io.error(`Cannot read “${parsed.epubPath}”. Check the path and try again.`);
    return 1;
  }

  let book: Book;
  try {
    book = openEpub(bytes);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let plan: StudyPlan;
  try {
    plan = planStudyPacks(book, {
      mode: parsed.mode,
      all: parsed.all,
      ...(parsed.chapters.length > 0 ? { chapters: parsed.chapters } : {}),
    });
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (plan.files.length > 0) {
    try {
      io.mkdir(parsed.outDir);
    } catch {
      io.error(`Cannot create “${parsed.outDir}”.`);
      return 1;
    }
    for (const file of plan.files) {
      const path = outputPath(parsed.outDir, file.filename);
      if (path === undefined) {
        io.error(`Refusing to write “${file.filename}”. A chapter title must not choose a path.`);
        return 1;
      }
      try {
        io.writeFile(path, file.body);
      } catch {
        io.error(`Cannot write “${path}”.`);
        return 1;
      }
    }
  }

  io.log(summarize(plan, parsed.outDir));
  return 0;
}

export function run(argv: string[], io: Io = defaultIo()): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.log(ROOT_HELP);
    return 0;
  }
  if (command !== 'study') {
    io.error(`Unknown command “${command}”.`);
    io.error(ROOT_HELP);
    return 1;
  }
  return runStudy(rest, io);
}
