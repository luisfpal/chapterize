import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BundleFile } from './bundle.js';
import { CliError } from './errors.js';

function assertBundlePath(filePath: string): void {
  if (filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').includes('..')) {
    throw new CliError(
      `Refusing to write "${filePath}": a bundle path stays inside the output folder.`,
    );
  }
}

/**
 * Replace chapters/, images/ and epub/ — those are the tool's — and leave any
 * other file in the folder alone. A symlink in one of those three is refused:
 * removing it and writing through it could land outside the folder.
 */
export function writeBundle(dir: string, files: BundleFile[]): void {
  if (existsSync(dir)) {
    const current = lstatSync(dir);
    if (!current.isDirectory() && !current.isSymbolicLink()) {
      throw new CliError(`${dir} is a file. Pass a directory to --out.`);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const sub of ['chapters', 'images', 'epub']) {
    const folder = path.join(dir, sub);
    let info;
    try {
      info = lstatSync(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new CliError(
        `${folder} is a symlink. Move it aside. That folder is replaced on each run, and following the link could write outside the bundle.`,
      );
    }
    if (!info.isDirectory()) {
      throw new CliError(`${folder} is a file. Move it aside so the bundle can write that folder.`);
    }
    rmSync(folder, { recursive: true, force: true });
  }
  for (const file of files) {
    assertBundlePath(file.path);
    const dest = path.join(dir, file.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
}
