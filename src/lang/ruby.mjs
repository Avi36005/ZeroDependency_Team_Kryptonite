// Ruby adapter.  Replaces: `bundler-leak`, `require_all` inspection.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mask, lineIndex, positionOf } from '../mask.mjs';

// Shipped with the interpreter, so never a ghost.
const STDLIB = new Set(`English abbrev base64 benchmark bigdecimal cgi coverage csv date delegate did_you_mean digest
drb english erb etc expect fcntl fiddle fileutils find forwardable getoptlong io ipaddr json logger matrix
mkmf monitor mutex_m net objspace observer open-uri open3 openssl optparse ostruct pathname pp prettyprint
prime pstore psych racc rbconfig rdoc readline reline resolv rinda ripper rss rubygems securerandom set shellwords
singleton socket stringio strscan syslog tempfile time timeout tmpdir tracer tsort un uri weakref yaml zlib`
  .split(/\s+/).filter(Boolean));

const SPEC = { lineComment: ['#'], strings: ['"', "'"], escape: '\\' };

export function scanImports(src) {
  const { masked, strings } = mask(src, SPEC);
  const starts = lineIndex(src);
  const found = [];

  for (const str of strings) {
    const before = masked.slice(Math.max(0, str.start - 40), str.start);
    const m = /\brequire(_relative)?\s*\(?\s*$/.exec(before);
    if (!m) continue;
    if (!str.value) continue;
    const { line, column } = positionOf(starts, str.start);
    // require_relative is always a path relative to the current file, never a
    // gem - surface it as `./x` so it goes through broken-import checking
    // instead of being judged against the Gemfile.
    const relative = Boolean(m[1]);
    const specifier = relative && !str.value.startsWith('.') ? `./${str.value}` : str.value;
    found.push({ specifier, line, column, kind: relative ? 'require_relative' : 'require' });
  }

  return found;
}

export function normalize(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const top = specifier.split('/')[0];
  if (STDLIB.has(top)) return null;
  return top;
}

export async function readManifest(dir) {
  let text;
  try {
    text = await readFile(join(dir, 'Gemfile'), 'utf8');
  } catch {
    return null;
  }
  const { masked, strings } = mask(text, SPEC);
  const declared = new Set();
  const dev = new Set();
  const groupRanges = [...masked.matchAll(/\bgroup\s+[^\n]*\b(?::development|:test)\b/g)]
    .map((m) => [m.index, masked.indexOf('\nend', m.index)]);

  for (const str of strings) {
    const before = masked.slice(Math.max(0, str.start - 20), str.start);
    if (!/\bgem\s*\(?\s*$/.test(before)) continue;
    const inDevGroup = groupRanges.some(([open, close]) => str.start > open && (close === -1 || str.start < close));
    (inDevGroup ? dev : declared).add(str.value);
  }

  return { declared, dev, optional: new Set(), peer: new Set() };
}

export default {
  id: 'ruby',
  name: 'Ruby',
  tier: 2,
  extensions: ['.rb', '.rake', '.gemspec'],
  manifestFiles: ['Gemfile', 'Gemfile.lock'],
  manifestIsComplete: true,
  installDirs: [],
  scanImports,
  normalize,
  readManifest,
};
