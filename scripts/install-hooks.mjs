import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Point a normal clone at `.githooks`. Linked worktrees share one hooks
 * directory with every other checkout of this repo, so installing there would
 * run this branch's `npm run check` on branches that do not have it.
 */
try {
  const gitDir = resolve(execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim());
  const common = resolve(execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim());
  if (gitDir === common) {
    execSync('git config core.hooksPath .githooks');
  }
} catch {
  // npm install also runs outside a git checkout. The hook file is still there.
}
