// The analysis engine: walk, scan, resolve, classify.
//
// Everything language-specific lives behind the adapter interface in
// src/lang/. This file only knows about the five findings it can produce.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve as resolvePath, join, relative, sep } from 'node:path';
import { walk, isBinary } from './walk.mjs';
import { languageForFile, ghostCapable, LANGUAGES } from './lang/index.mjs';
import { substitutionFor, toolingReason } from './substitutions.mjs';
import { inspectFile, rank } from './vendor.mjs';
import { loadIgnoreRules, applyIgnoreRules } from './ignore.mjs';

/**
 * @typedef {'ghost'|'phantom'|'dead'|'replaceable'|'broken'} FindingType
 *
 * ghost       imported, and nothing in this project resolves it - the build
 *             breaks on a clean checkout, and a name that is not on the
 *             registry either is a hallucinated import
 * phantom     imported and installed, but never declared - breaks on a clean clone
 * dead        declared, but never imported - carried weight and attack surface
 * replaceable declared, but the standard library already ships an equivalent
 * broken      a relative import pointing at a file that does not exist
 */

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export async function analyze(root, options = {}) {
  const { include = null, maxBytes = MAX_SOURCE_BYTES } = options;
  let absRoot = resolvePath(root);

  // Pointing depx at a single file is a legitimate ask; analyse that file
  // against the manifest of the directory it lives in.
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch {
    throw new Error(`path does not exist: ${root}`);
  }
  let singleFile = null;
  if (rootStat.isFile()) {
    const dir = dirname(absRoot);
    // Judge the file against its project's manifest, not whatever directory
    // it happens to sit in - `depx src/deep/a.js` should still see the
    // package.json at the repo root.
    const projectRoot = (await findManifestRoot(dir)) ?? dir;
    singleFile = { path: absRoot, rel: relativePath(projectRoot, absRoot) };
    absRoot = projectRoot;
  }

  /** @type {Map<string, {lang: any, files: string[], imports: Map<string, Array>, relatives: Array, locals: Set<string>}>} */
  const byLanguage = new Map();
  let filesScanned = 0;
  let filesSkipped = 0;

  const boundaries = LANGUAGES.flatMap((l) => l.manifestFiles ?? []);
  const skippedProjects = [];
  const files = singleFile
    ? [singleFile][Symbol.iterator]()
    : walk(absRoot, { boundaries, skipped: skippedProjects });

  for await (const file of files) {
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

    // Names this repository defines for itself - `mod utils;` in Rust, a
    // sibling utils.py in Python - are never dependencies, however much an
    // import of them looks like one.
    if (lang.localModulesFromPath) {
      for (const name of lang.localModulesFromPath(file.rel)) {
        bucket.locals.add(canonical(lang, lang.normalize(name) ?? name));
      }
    }
    if (lang.scanLocals) {
      for (const name of lang.scanLocals(source)) {
        bucket.locals.add(canonical(lang, lang.normalize(name) ?? name));
      }
    }

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

  const warnings = [];
  const results = [];
  for (const bucket of byLanguage.values()) {
    // "declared but never imported" is only sound over a whole project. When
    // one file was analysed, the other files that might import it were never
    // read, so the claim is withheld rather than guessed.
    const result = await classify(absRoot, bucket, { wholeProject: singleFile === null });
    // A manifest that exists but did not parse must not be reported as
    // "no manifest found" - that reads as "you have no dependencies", which
    // is the opposite of what an unreadable manifest means.
    if (!result.manifest) {
      for (const name of bucket.lang.manifestFiles ?? []) {
        if (await exists(join(absRoot, name))) {
          warnings.push(`${name} exists but could not be parsed; ${bucket.lang.name} findings are incomplete`);
          break;
        }
      }
    }
    results.push(result);
  }

  results.sort((a, b) => b.files.length - a.files.length);

  // .depxignore is applied last, over the assembled findings, so a rule can
  // name a finding type without every adapter having to know about it. What
  // it removes is counted and reported: suppression that cannot be seen is
  // worse than the finding it hides.
  const { kept, suppressed } = applyIgnoreRules(
    await loadIgnoreRules(absRoot),
    results.flatMap((r) => r.findings),
  );

  return {
    root: absRoot,
    filesScanned,
    filesSkipped,
    skippedProjects: skippedProjects.sort(),
    languages: results,
    warnings,
    findings: kept,
    suppressed,
  };
}

function getBucket(map, lang) {
  if (!map.has(lang.id)) {
    map.set(lang.id, { lang, files: [], imports: new Map(), relatives: [], locals: new Set() });
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

async function classify(root, bucket, { wholeProject = true } = {}) {
  const { lang, imports, relatives, locals } = bucket;
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
    // An adapter can enumerate its install tree in one pass (Python's
    // site-packages); otherwise existence is probed per name (node_modules).
    //
    // Where an adapter enumerates, its answer is the whole answer. Falling
    // back to "does a .venv directory exist" would treat an empty or
    // half-built virtualenv as proof of what is installed, and every
    // undeclared import would be promoted to a ghost on the strength of a
    // directory that contains nothing.
    const installedSet = lang.findInstalled ? await lang.findInstalled(root) : null;
    const hasTree = lang.findInstalled
      ? installedSet !== null
      : await hasInstallTree(root, lang);
    for (const [key, entry] of imports) {
      if (declared.has(key)) continue;
      if (locals.has(key)) continue;
      if (isSelfImport(manifest, entry.name)) continue;
      const installed =
        hasTree &&
        (installedSet
          ? installedSet.has(key)
          : await isInstalled(root, lang, entry.name));
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
            : 'not declared, and no install tree here to check against',
      });
    }
  }

  // ---- declared but never imported ----
  //
  // Only claimed where import names map soundly to package names. For tier 3
  // a Maven coordinate never literally matches an import namespace, so "dead"
  // would fire on every declared dependency - confident nonsense, suppressed
  // for the same reason ghosts are.
  if (manifest && ghostCapable(lang) && wholeProject) {
    for (const key of runtimeDeclared) {
      if (imports.has(key)) continue;
      const name = declaredOriginal.get(key) ?? key;
      const sub = substitutionFor(lang.id, name);
      const tooling = toolingReason(lang.id, name);
      findings.push({
        type: 'dead',
        language: lang.id,
        name,
        sites: [],
        expected: tooling !== null,
        detail: tooling
          ? tooling
          : sub
            ? `unused, and ${sub.use} replaces it anyway`
            : 'declared but no import of it was found',
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

/**
 * True when an import path lives inside the module being analysed - Go's
 * `module example.com/app` makes `example.com/app/util` internal, not a
 * dependency. Compared in both directions because normalisation may have
 * trimmed the import to fewer segments than the module path has.
 */
/** Nearest ancestor directory holding a dependency manifest, if any. */
async function findManifestRoot(from) {
  const names = LANGUAGES.flatMap((l) => l.manifestFiles ?? []);
  let dir = from;
  for (;;) {
    for (const name of names) {
      if (await exists(join(dir, name))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function relativePath(root, file) {
  return relative(root, file).split(sep).join('/');
}

function isSelfImport(manifest, name) {
  const self = manifest?.self;
  if (!self) return false;
  return name === self || name.startsWith(`${self}/`) || `${self}/`.startsWith(`${name}/`);
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

  // An empty manifest is only half the rule. The other half is that the code
  // under src/ was actually written by the person shipping it, and that half
  // is invisible to the manifest - so we look at the files themselves.
  const boundaries = LANGUAGES.flatMap((l) => l.manifestFiles ?? []);
  const suspects = [];
  const present = new Map();
  for await (const file of walk(absRoot, { boundaries })) {
    const lang = languageForFile(file.path);
    if (!lang) continue;
    present.set(lang.id, (present.get(lang.id) ?? 0) + 1);
    let size;
    try {
      ({ size } = await stat(file.path));
    } catch {
      continue;
    }
    if (size > MAX_SOURCE_BYTES || (size > 0 && (await isBinary(file.path)))) continue;
    const report = await inspectFile(file.path, file.rel);
    if (report) suspects.push(report);
  }

  // "No manifest" is not the same as "no dependencies". The rule asks for an
  // empty manifest that a judge can see, so a repo with source but no
  // manifest fails it - and the useful thing to say is which file to add.
  const missing = [];
  for (const lang of LANGUAGES) {
    if (!present.has(lang.id)) continue;
    if (rows.some((r) => r.language === lang.name)) continue;
    if (!lang.manifestFiles?.length) continue;
    missing.push({
      language: lang.name,
      files: present.get(lang.id),
      expected: lang.manifestFiles[0],
    });
  }

  return {
    root: absRoot,
    rows,
    missing,
    vendored: rank(suspects),
    pass: rows.length > 0 && rows.every((r) => r.pass) && missing.length === 0,
  };
}
