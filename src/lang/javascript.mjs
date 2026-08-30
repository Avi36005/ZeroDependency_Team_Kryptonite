// JavaScript / TypeScript adapter.
//
// Replaces: `acorn`, `@babel/parser`, `es-module-lexer`, `detective`.
//
// We do not need a syntax tree - only the string literals that sit in import
// position - so instead of a parser we mask the source (blanking comments,
// string bodies, template literals and regex literals while preserving byte
// offsets) and then ask, for each surviving string literal, whether the code
// immediately before it is an import construct.
//
// This is ~150 lines instead of a 100 KB dependency, and it cannot be fooled
// by `// import 'fake'` or by `const s = "require('fake')"`.

import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';

/** Characters after which a `/` begins a regex literal rather than division. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n', '']);
const REGEX_KEYWORDS = /\b(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)\s*$/;

/**
 * Blank out everything that is not code, preserving length so that offsets
 * into the masked text are valid offsets into the original.
 *
 * @returns {{ masked: string, strings: Array<{start:number,end:number,value:string}> }}
 */
export function maskSource(src) {
  const out = new Array(src.length);
  const strings = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };

  let i = 0;
  let lastSignificant = '';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // ---- line comment ----
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ---- block comment ----
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ---- quoted string ----
    if (c === '"' || c === "'") {
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === c) break;
        if (src[j] === '\n') break; // unterminated: bail rather than swallow the file
        value += src[j];
        j++;
      }
      const end = Math.min(j + 1, src.length);
      out[start] = c;
      blank(start + 1, end);
      if (src[j] === c) out[j] = c;
      strings.push({ start, end, value });
      lastSignificant = c;
      i = end;
      continue;
    }

    // ---- template literal (with ${} nesting) ----
    if (c === '`') {
      const start = i;
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') depth--;
        j++;
      }
      const end = Math.min(j + 1, src.length);
      blank(start, end);
      lastSignificant = '`';
      i = end;
      continue;
    }

    // ---- regex literal ----
    if (c === '/' && isRegexPosition(out, i, lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j++;
      }
      const end = Math.min(j + 1, src.length);
      blank(i, end);
      lastSignificant = '/';
      i = end;
      continue;
    }

    out[i] = c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }

  return { masked: out.join(''), strings };
}

function isRegexPosition(out, index, lastSignificant) {
  if (REGEX_PRECEDERS.has(lastSignificant)) return true;
  const before = out.slice(Math.max(0, index - 24), index).join('');
  return REGEX_KEYWORDS.test(before);
}

// Import constructs, tested against the masked code immediately preceding a
// string literal. Ordered longest-first so the more specific ones win.
const IMPORT_POSITIONS = [
  { re: /\bfrom\s*$/, kind: 'import' },              // import x from 'y' / export * from 'y'
  { re: /\bimport\s*\(\s*$/, kind: 'dynamic' },      // import('y')
  { re: /\bimport\s*$/, kind: 'bare' },              // import 'y'
  { re: /\brequire\s*\(\s*$/, kind: 'require' },     // require('y')
  { re: /\brequire\.resolve\s*\(\s*$/, kind: 'require' },
  { re: /\bimport\.meta\.resolve\s*\(\s*$/, kind: 'require' },
  { re: /\bcreateRequire\s*\([^)]*\)\s*\(\s*$/, kind: 'require' },
];

/**
 * Extract every import specifier in a source file.
 *
 * @param {string} src
 * @returns {Array<{ specifier: string, line: number, column: number, kind: string }>}
 */
export function scanImports(src) {
  const { masked, strings } = maskSource(src);
  const lineStarts = buildLineStarts(src);
  const found = [];

  for (const str of strings) {
    const before = masked.slice(Math.max(0, str.start - 120), str.start);
    const match = IMPORT_POSITIONS.find((p) => p.re.test(before));
    if (!match) continue;
    if (!str.value) continue;

    const { line, column } = positionOf(lineStarts, str.start);
    found.push({ specifier: str.value, line, column, kind: match.kind });
  }

  return found;
}

function buildLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function positionOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

/** `@scope/pkg/deep/path` -> `@scope/pkg`; `lodash/fp` -> `lodash`. */
export function normalize(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null; // relative
  if (specifier.startsWith('node:')) return null;                          // builtin
  if (isBuiltin(specifier)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;                 // http:, data:, file:
  // Not packages: Node subpath imports (package.json "imports") and the
  // path-alias conventions bundlers reserve. npm names cannot start with
  // these characters, so nothing real is suppressed.
  if (specifier.startsWith('#')) return null;                              // #internal/x
  if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier === '~') return null;
  if (specifier.startsWith('$')) return null;                              // $lib (SvelteKit)
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export async function readManifest(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    return {
      declared: new Set(Object.keys(raw.dependencies ?? {})),
      dev: new Set(Object.keys(raw.devDependencies ?? {})),
      optional: new Set(Object.keys(raw.optionalDependencies ?? {})),
      peer: new Set(Object.keys(raw.peerDependencies ?? {})),
      // A package may import itself by name through its own "exports" map,
      // which Node supports and which is not a dependency.
      self: typeof raw.name === 'string' ? raw.name : null,
    };
  } catch {
    return null;
  }
}

export default {
  id: 'javascript',
  name: 'JavaScript / TypeScript',
  tier: 1,
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'],
  manifestFiles: ['package.json'],
  installDirs: ['node_modules'],
  scanImports,
  normalize,
  readManifest,
};
