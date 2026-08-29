// The analysis engine: walk, scan, resolve, classify.
//
// Everything language-specific lives behind the adapter interface in
// src/lang/. This file only knows about the five findings it can produce.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { walk, isBinary } from './walk.mjs';
import { languageForFile, ghostCapable, LANGUAGES } from './lang/index.mjs';
import { substitutionFor } from './substitutions.mjs';

/**
 * @typedef {'ghost'|'phantom'|'dead'|'replaceable'|'broken'} FindingType
 *
 * ghost       imported, but resolves to nothing at all - the slopsquat surface
 * phantom     imported and installed, but never declared - breaks on a clean clone
 * dead        declared, but never imported - carried weight and attack surface
 * replaceable declared, but the standard library already ships an equivalent
 * broken      a relative import pointing at a file that does not exist
 */

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export async function analyze(root, options = {}) {
  const { include = null, maxBytes = MAX_SOURCE_BYTES } = options;
  const absRoot = resolvePath(root);

  /** @type {Map<string, {lang: any, files: string[], imports: Map<string, Array>, relatives: Array}>} */
  const byLanguage = new Map();
  let filesScanned = 0;
  let filesSkipped = 0;

  const boundaries = LANGUAGES.flatMap((l) => l.manifestFiles ?? []);

  for await (const file of walk(absRoot, { boundaries })) {
    const lang = languageForFile(file.path);
    if (!lang) continue;
    if (include && !include.includes(lang.id)) continue;

    let size;
    try {
      ({ size } = await stat(file.path));
    } catch {
      continue;
    }
    if (size > maxBytes || (size > 0 && await isBinary(file.path))) {
      filesSkipped++;
      continue;
    }

    let source;
    try {
      source = await readFile(file.path, 'utf8');
    } catch {
      filesSkipped++;
      continue;
    }

    const bucket = getBucket(byLanguage, lang);
    bucket.files.push(file.rel);
    filesScanned++;

    for (const imp of lang.scanImports(source)) {
      const site = { file: file.rel, path: file.path, line: imp.line, column: imp.column, kind: imp.kind };
      const pkg = lang.normalize(imp.specifier);

      if (pkg === null) {
        // Relative or standard library. Only relative paths can be broken.
        if (isRelative(imp.specifier)) {
          bucket.relatives.push({ ...site, specifier: imp.specifier });
        }
        continue;
      }

      const key = canonical(lang, pkg);
      if (!bucket.imports.has(key)) bucket.imports.set(key, { name: pkg, sites: [] });
      bucket.imports.get(key).sites.push(site);
    }
  }

  const results = [];
  for (const bucket of byLanguage.values()) {
    results.push(await classify(absRoot, bucket));
  }

  results.sort((a, b) => b.files.length - a.files.length);

  return {
    root: absRoot,
    filesScanned,
    filesSkipped,
    languages: results,
    findings: results.flatMap((r) => r.findings),
  };
}

function getBucket(map, lang) {
  if (!map.has(lang.id)) {
    map.set(lang.id, { lang, files: [], imports: new Map(), relatives: [] });
  }
  return map.get(lang.id);
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Fold the naming rules a registry applies, so `Foo_Bar` and `foo-bar` match. */
function canonical(lang, name) {
  let key = name;
  if (lang.caseInsensitiveNames) key = key.toLowerCase();
  if (lang.hyphenInsensitive || lang.caseInsensitiveNames) key = key.replaceAll('_', '-');
  return key;
}

async function classify(root, bucket) {
  const { lang, imports, relatives } = bucket;
  const manifest = await lang.readManifest(root);
  const findings = [];

  const declared = new Set();
  const declaredOriginal = new Map();
  for (const set of [manifest?.declared, manifest?.dev, manifest?.optional, manifest?.peer]) {
    for (const name of set ?? []) {
      const key = canonical(lang, name);
      declared.add(key);
      declaredOriginal.set(key, name);
    }
  }
  const runtimeDeclared = new Set([...(manifest?.declared ?? [])].map((n) => canonical(lang, n)));

  // ---- imports that do not resolve ----
  //
  // How strong a claim we can make depends on what evidence is available.
  // A missing import is only provably a ghost when we can see the whole
  // resolution universe: either the manifest is authoritative (Go will not
  // compile an import absent from go.mod) or an install tree is on disk to
  // check against. With neither, an undeclared import might simply be a real
  // package nobody has installed here, so we say 'undeclared' and mean it.
  if (ghostCapable(lang)) {
    const hasTree = await hasInstallTree(root, lang);
    for (const [key, entry] of imports) {
      if (declared.has(key)) continue;
      const installed = hasTree && (await isInstalled(root, lang, entry.name));
      const provable = lang.manifestIsComplete === true || hasTree;

      findings.push({
        type: installed ? 'phantom' : provable ? 'ghost' : 'undeclared',
        language: lang.id,
        name: entry.name,
        sites: entry.sites,
        detail: installed
          ? 'present in the install tree but absent from the manifest'
          : provable
            ? lang.manifestIsComplete
              ? 'absent from the manifest, which is authoritative for this language'
              : 'absent from both the manifest and the install tree'
            : 'not declared; no install tree present, so existence is unverified',
      });
    }
  }

  // ---- declared but never imported ----
  if (manifest) {
    for (const key of runtimeDeclared) {
      if (imports.has(key)) continue;
      const name = declaredOriginal.get(key) ?? key;
      const sub = substitutionFor(lang.id, name);
      findings.push({
        type: 'dead',
        language: lang.id,
        name,
        sites: [],
        detail: sub ? `unused, and ${sub.use} replaces it anyway` : 'declared but no import of it was found',
      });
    }
  }

  // ---- declared, used, and replaceable by the standard library ----
  for (const key of runtimeDeclared) {
    if (!imports.has(key)) continue;
    const name = declaredOriginal.get(key) ?? key;
    const sub = substitutionFor(lang.id, name);
    if (!sub) continue;
    findings.push({
      type: 'replaceable',
      language: lang.id,
      name,
      sites: imports.get(key).sites,
      detail: sub.use,
      since: sub.since,
      note: sub.note,
    });
  }

  // ---- relative imports pointing nowhere ----
  for (const rel of relatives) {
    if (await resolvesLocally(rel.path, rel.specifier, lang)) continue;
    findings.push({
      type: 'broken',
      language: lang.id,
      name: rel.specifier,
      sites: [rel],
      detail: 'relative import does not resolve to a file on disk',
    });
  }

  return { lang, files: bucket.files, manifest, findings, importCount: imports.size };
}

async function hasInstallTree(root, lang) {
  for (const dir of lang.installDirs ?? []) {
    if (await exists(join(root, dir))) return true;
  }
  return false;
}

async function isInstalled(root, lang, name) {
  for (const dir of lang.installDirs ?? []) {
    if (await exists(join(root, dir, name))) return true;
    // Python virtualenvs bury site-packages a couple of levels down.
    if (await exists(join(root, dir, 'lib', 'site-packages', name))) return true;
  }
  return false;
}

async function resolvesLocally(fromFile, specifier, lang) {
  const base = resolvePath(dirname(fromFile), specifier);
  if (await exists(base)) return true;
  for (const ext of lang.extensions) {
    if (await exists(base + ext)) return true;
    if (await exists(join(base, `index${ext}`))) return true;
  }
  // TypeScript sources are routinely imported with a .js specifier.
  if (specifier.endsWith('.js')) {
    const stem = base.slice(0, -3);
    for (const ext of ['.ts', '.tsx', '.mts']) if (await exists(stem + ext)) return true;
  }
  return false;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * Verify a repository against the Zero Dependency rule: an empty runtime
 * dependency manifest, in whichever languages the repo actually uses.
 */
export async function verifyZeroDep(root) {
  const absRoot = resolvePath(root);
  const rows = [];

  for (const lang of LANGUAGES) {
    const manifest = await lang.readManifest(absRoot);
    if (!manifest) continue;
    const count = manifest.declared.size;
    rows.push({
      language: lang.name,
      manifest: lang.manifestFiles[0] ?? '(none)',
      runtimeDeps: count,
      devDeps: manifest.dev.size,
      pass: count === 0,
      names: [...manifest.declared],
    });
  }

  return { root: absRoot, rows, pass: rows.length > 0 && rows.every((r) => r.pass) };
}
