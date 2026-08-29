// Go adapter.  Replaces: `go list -deps` (a subprocess we are not allowed to shell out to).
//
// Go is the easiest language to x-ray: the import path in the source is the
// exact string that appears in go.mod, so there is no name mapping at all.
// The standard library is identified by a structural rule rather than a list:
// a module path whose first segment contains a dot is a domain name, and
// therefore external.  "net/http" is stdlib, "github.com/x/y" is not.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mask, lineIndex, positionOf } from '../mask.mjs';

const SPEC = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  strings: ['"'],
  rawStrings: [['`', '`']],
  escape: '\\',
};

export function scanImports(src) {
  const { masked, strings } = mask(src, SPEC);
  const starts = lineIndex(src);
  const found = [];

  // Grouped form: import ( ... ) - every string literal inside the parens.
  const groups = [];
  for (const m of masked.matchAll(/\bimport\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = masked.indexOf(')', open);
    if (close !== -1) groups.push([open, close]);
  }

  for (const str of strings) {
    const inGroup = groups.some(([open, close]) => str.start > open && str.end <= close);
    // Single form: import "x" or import alias "x" or import _ "x"
    const before = masked.slice(Math.max(0, str.start - 60), str.start);
    const isSingle = /\bimport\s+(?:[\w.]+\s+)?$/.test(before);

    if (!inGroup && !isSingle) continue;
    if (!str.value) continue;
    const { line, column } = positionOf(starts, str.start);
    found.push({ specifier: str.value, line, column, kind: inGroup ? 'group' : 'import' });
  }

  return found;
}

export function normalize(specifier) {
  const first = specifier.split('/')[0];
  // No dot in the first segment means it is a standard library package.
  if (!first.includes('.')) return null;
  // Dependencies are declared at module granularity, e.g. github.com/user/repo,
  // so trim deeper package paths back to the first three segments.
  const parts = specifier.split('/');
  return parts.length <= 3 ? specifier : parts.slice(0, 3).join('/');
}

export async function readManifest(dir) {
  let text;
  try {
    text = await readFile(join(dir, 'go.mod'), 'utf8');
  } catch {
    return null;
  }

  const declared = new Set();
  const dev = new Set();
  const { masked } = mask(text, { lineComment: ['//'], strings: ['"'], escape: '' });

  // Block form: require ( ... )
  for (const block of masked.matchAll(/\brequire\s*\(([\s\S]*?)\)/g)) {
    for (const line of block[1].split('\n')) {
      const entry = parseRequireLine(line);
      if (entry) (entry.indirect ? dev : declared).add(entry.path);
    }
  }
  // Single form: require example.com/mod v1.2.3
  for (const single of masked.matchAll(/^\s*require\s+(?!\()(.+)$/gm)) {
    const entry = parseRequireLine(single[1]);
    if (entry) (entry.indirect ? dev : declared).add(entry.path);
  }

  return { declared, dev, optional: new Set(), peer: new Set() };
}

function parseRequireLine(line) {
  const clean = line.trim();
  if (!clean) return null;
  const m = /^([^\s]+)\s+(v[^\s]+)/.exec(clean);
  if (!m) return null;
  return { path: m[1], indirect: /\/\/\s*indirect/.test(line) };
}

export default {
  id: 'go',
  name: 'Go',
  tier: 1,
  extensions: ['.go'],
  manifestFiles: ['go.mod'],
  manifestIsComplete: true,
  installDirs: [],
  scanImports,
  normalize,
  readManifest,
};
