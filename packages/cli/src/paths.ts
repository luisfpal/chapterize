import path from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';
import { CliError } from './errors.js';

/**
 * Same shape as the desktop library folder, so a book written by either one
 * is the same name to a person looking at both.
 */
export function bookFolderName(title: string, author?: string): string {
  const clean = (s: string) =>
    s
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const t = clean(title).slice(0, 70) || 'Untitled';
  const a = author ? clean(author).slice(0, 40) : '';
  const name = a ? `${t} — ${a}` : t;
  // path.join treats a folder named "." or ".." as navigation, so a book
  // titled ".." would be written into the parent of Chapterize/ — iCloud
  // Drive itself. Any other name is one segment; the slashes are already gone.
  if (name === '.' || name === '..') return 'Untitled';
  return name;
}

/** Where macOS puts iCloud Drive. Absent when Drive is off or this is not a Mac. */
export function icloudRoot(home: string): string {
  return path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

export function icloudBookDir(home: string, folderName: string): string {
  return path.join(icloudRoot(home), 'Chapterize', folderName);
}

/**
 * Refuse destinations that would scatter a bundle across a folder the user
 * already keeps other things in. A subdirectory of any of these is fine.
 */
export function assertSafeOut(dir: string, home: string): void {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  if (resolved === path.resolve(home)) {
    throw new CliError(
      `Refusing to write the bundle directly into ${resolved}. Pass a folder inside it.`,
    );
  }
  if (resolved === root) {
    throw new CliError(`Refusing to write the bundle into ${resolved}. Pass a folder.`);
  }
  if (resolved === icloudRoot(home)) {
    throw new CliError(
      `${resolved} is the whole iCloud Drive. Pass --icloud, which writes Chapterize/<book> inside it.`,
    );
  }
}

/** `child` must be a directory strictly inside `parent`, after ".." is resolved. */
export function assertInside(parent: string, child: string): void {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CliError(
      `Refusing to write the bundle to ${path.resolve(child)}. It has to stay inside ${path.resolve(parent)}.`,
    );
  }
}

/**
 * An address the phone can open. Prefer Wi-Fi (en0 on a Mac) over tunnels and
 * virtual adapters, which are reachable from this machine and from nowhere else.
 */
export function lanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  const found: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family !== 'IPv4') continue;
      if (info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      found.push({ name, address: info.address });
    }
  }
  for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
    const hit = found.find((item) => item.name === name);
    if (hit) return hit.address;
  }
  const ordinary = found.find(
    (item) => !/^(utun|awdl|bridge|docker|veth|vmnet|tun|llw)/.test(item.name),
  );
  return ordinary?.address ?? found[0]?.address ?? null;
}

/**
 * Map a URL path onto a file inside `root`, or null when it tries to leave.
 * Existence is the caller's problem; this only decides the path is allowed.
 */
export function safeFile(root: string, urlPath: string): string | null {
  // "\" is a separator on Windows. A phone bundle is not a reason to follow it.
  if (urlPath.includes('\0') || urlPath.includes('\\')) return null;
  const rel = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.split('/').includes('..')) return null;
  const full = path.resolve(root, rel);
  const diff = path.relative(path.resolve(root), full);
  if (diff.startsWith('..') || path.isAbsolute(diff)) return null;
  return full;
}
