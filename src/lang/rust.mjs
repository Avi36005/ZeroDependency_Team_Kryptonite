// Rust adapter.  Replaces: `cargo-udeps`, `cargo tree` parsing.
//
// Crate names use hyphens in Cargo.toml but underscores in `use` statements,
// so normalisation is a single character substitution.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mask, lineIndex, positionOf } from '../mask.mjs';
import { parseToml } from '../toml.mjs';

// Paths that resolve inside the current crate or the standard distribution.
const INTERNAL = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc', 'proc_macro', 'test']);

const SPEC = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  strings: ['"'],
  rawStrings: [['r#"', '"#'], ['r"', '"']],
  escape: '\\',
};

export function scanImports(src) {
  const { masked } = mask(src, SPEC);
  const starts = lineIndex(src);
  const found = [];

  for (const m of masked.matchAll(/\buse\s+(?:::)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const { line, column } = positionOf(starts, m.index + m[0].indexOf(m[1]));
    found.push({ specifier: m[1], line, column, kind: 'use' });
  }
  for (const m of masked.matchAll(/\bextern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const { line, column } = positionOf(starts, m.index + m[0].indexOf(m[1]));
    found.push({ specifier: m[1], line, column, kind: 'extern' });
  }

  return found;
}

export function normalize(specifier) {
  if (INTERNAL.has(specifier)) return null;
  return specifier.replaceAll('_', '-');
}

/**
 * Module names this crate defines for itself. `mod utils;` plus
 * `use utils::helper;` is the normal way to split a crate across files, and
 * `utils` must never be judged against Cargo.toml.
 */
export function scanLocals(src) {
  const { masked } = mask(src, SPEC);
  const names = [];
  for (const m of masked.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/g)) {
    names.push(m[1]);
  }
  return names;
}

/** src/utils.rs defines module `utils`; src/net/mod.rs defines `net`. */
function localModulesFromPath(rel) {
  const parts = rel.split('/');
  const file = parts.pop();
  if (!file.endsWith('.rs')) return [];
  const stem = file.slice(0, -3);
  if (stem === 'mod' || stem === 'lib' || stem === 'main') {
    const dir = parts.pop();
    return dir && dir !== 'src' ? [dir] : [];
  }
  return [stem];
}

export async function readManifest(dir) {
  let text;
  try {
    text = await readFile(join(dir, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
  const toml = parseToml(text);
  return {
    declared: new Set(Object.keys(toml.dependencies ?? {})),
    dev: new Set(Object.keys(toml['dev-dependencies'] ?? {})),
    optional: new Set(Object.keys(toml['build-dependencies'] ?? {})),
    peer: new Set(),
    // A crate's own name. A binary target under src/bin/ imports the library
    // by that name - `use croniter_core::api` inside the croniter-core crate
    // - which is the standard bin+lib layout, not a missing dependency.
    self: toml.package?.name ? String(toml.package.name) : null,
  };
}

export default {
  id: 'rust',
  name: 'Rust',
  tier: 2,
  extensions: ['.rs'],
  manifestFiles: ['Cargo.toml'],
  manifestIsComplete: true,
  installDirs: [],
  hyphenInsensitive: true,
  scanImports,
  scanLocals,
  localModulesFromPath,
  normalize,
  readManifest,
};
