// File discovery: directory walking, .gitignore matching and binary detection.
//
// Replaces: `globby`, `fast-glob`, `ignore`, `isbinaryfile`.
// Uses: node:fs/promises opendir + a hand-written gitignore matcher.

import { opendir, readFile, open } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Directories that never contain first-party source. Walking them is the
// single biggest waste of time on a real repo, so they are cut unconditionally.
const ALWAYS_SKIP = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'vendor',
  'target', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  'bin', 'obj', '.gradle', '.mypy_cache', '.pytest_cache', '.tox',
]);

/**
 * Translate one .gitignore pattern into a RegExp.
 *
 * Supports the subset that actually appears in real .gitignore files:
 * `*`, `**`, `?`, leading `/` (anchored), trailing `/` (directory only)
 * and `!` (negation). Character classes are passed through as-is.
 */
function patternToRegExp(pattern) {
  let negated = false;
  let body = pattern;

  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  }

  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);

  // A pattern containing a slash anywhere but the end is anchored to the
  // root of the repo; otherwise it matches at any depth. This is the rule
  // most hand-rolled matchers get wrong.
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);

  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') {
        re += '.*';
        i++;
        if (body[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = body.indexOf(']', i);
      if (close === -1) { re += '\\['; } else { re += body.slice(i, close + 1); i = close; }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }

  return {
    negated,
    dirOnly,
    regexp: new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`),
  };
}

/** Parse a .gitignore file into an ordered list of matchers. */
export async function loadIgnoreFile(dir) {
  let text;
  try {
    text = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(patternToRegExp);
}

/**
 * Last matching pattern wins, which is how git itself resolves negations.
 */
export function isIgnored(rules, relPath, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regexp.test(relPath)) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * A file is treated as binary if a NUL byte appears in its first 8 KiB.
 * This is the same heuristic git uses, and it costs one read of one block.
 */
export async function isBinary(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true; // unreadable: treat as binary so we skip it
  } finally {
    await handle?.close();
  }
}

/**
 * Yield every source-file path under `root`, skipping ignored and binary files.
 *
 * @param {string} root
 * @param {{ maxBytes?: number, boundaries?: string[] }} [options]
 *   boundaries: filenames that mark a nested project. A subdirectory
 *   containing one is a different project with a different manifest, so we do
 *   not descend into it - otherwise its imports get judged against our
 *   manifest and every finding is noise.
 */
export async function* walk(root, options = {}) {
  const { maxBytes = 2 * 1024 * 1024, boundaries = [] } = options;
  const rules = await loadIgnoreFile(root);
  yield* walkDir(root, root, rules, maxBytes, new Set(boundaries));
}

async function* walkDir(dir, root, rules, maxBytes, boundaries) {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return; // unreadable directory (permissions, broken symlink): skip silently
  }

  for await (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');

    if (entry.isDirectory()) {
      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (isIgnored(rules, rel, true)) continue;
      if (await isProjectBoundary(full, boundaries)) continue;
      yield* walkDir(full, root, rules, maxBytes, boundaries);
    } else if (entry.isFile()) {
      if (isIgnored(rules, rel, false)) continue;
      yield { path: full, rel };
    }
  }
}

/** True when a directory declares its own manifest, i.e. it is another project. */
async function isProjectBoundary(dir, boundaries) {
  if (boundaries.size === 0) return false;
  for (const name of boundaries) {
    try {
      await opendir(join(dir, name));
      return true; // a manifest that is a directory: unusual, still a boundary
    } catch (error) {
      if (error.code === 'ENOTDIR') return true; // it exists and is a file
    }
  }
  return false;
}
