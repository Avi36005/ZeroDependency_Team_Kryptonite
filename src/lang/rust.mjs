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
  normalize,
  readManifest,
};
