// Tier 3 adapters: Java/Kotlin, C#, PHP and C/C++.
//
// These languages are deliberately NOT given ghost detection, and that is a
// correctness decision rather than a missing feature.
//
// In Java, `import org.apache.commons.lang3.StringUtils` is satisfied by the
// Maven artifact `org.apache.commons:commons-lang3` - the namespace and the
// artifact coordinate are different strings, related only by a mapping that
// lives on Maven Central. Resolving that offline would need a shipped copy of
// the registry index. The same is true of NuGet and of Composer's PSR-4 map
// when `vendor/` is absent. C and C++ have no dependency manifest at all.
//
// Rather than emit confident nonsense, these adapters report file inventory
// and declared dependencies, and `ghostCapable: false` suppresses every ghost
// and phantom claim for them. The README says so plainly.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mask, lineIndex, positionOf } from '../mask.mjs';

const C_STYLE = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  strings: ['"'],
  escape: '\\',
};

function scanWith(regex, kind) {
  return (src) => {
    const { masked } = mask(src, C_STYLE);
    const starts = lineIndex(src);
    const found = [];
    for (const m of masked.matchAll(regex)) {
      const { line, column } = positionOf(starts, m.index + m[0].indexOf(m[1]));
      found.push({ specifier: m[1], line, column, kind });
    }
    return found;
  };
}

async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/** Pull <groupId>/<artifactId> pairs out of a pom.xml without an XML parser. */
async function readMavenGradle(dir) {
  const declared = new Set();

  const pom = await readIfPresent(join(dir, 'pom.xml'));
  if (pom !== null) {
    for (const block of pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(block[1])?.[1];
      const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(block[1])?.[1];
      if (group && artifact) declared.add(`${group}:${artifact}`);
    }
  }

  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const gradle = await readIfPresent(join(dir, name));
    if (gradle === null) continue;
    for (const m of gradle.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      declared.add(m[1].split(':').slice(0, 2).join(':'));
    }
  }

  return pom === null && declared.size === 0 ? null : { declared, dev: new Set(), optional: new Set(), peer: new Set() };
}

async function readCsproj(dir) {
  const declared = new Set();
  let seen = false;
  for (const file of ['packages.config']) {
    const text = await readIfPresent(join(dir, file));
    if (text === null) continue;
    seen = true;
    for (const m of text.matchAll(/<package\s+id="([^"]+)"/g)) declared.add(m[1]);
  }
  return seen || declared.size ? { declared, dev: new Set(), optional: new Set(), peer: new Set() } : null;
}

async function readComposer(dir) {
  const text = await readIfPresent(join(dir, 'composer.json'));
  if (text === null) return null;
  try {
    const json = JSON.parse(text);
    const strip = (obj) => new Set(Object.keys(obj ?? {}).filter((k) => k !== 'php' && !k.startsWith('ext-')));
    return {
      declared: strip(json.require),
      dev: strip(json['require-dev']),
      optional: new Set(),
      peer: new Set(),
    };
  } catch {
    return null;
  }
}

export const java = {
  id: 'java',
  name: 'Java / Kotlin',
  tier: 3,
  ghostCapable: false,
  reason: 'import namespaces do not map to Maven coordinates without a registry index',
  extensions: ['.java', '.kt', '.kts'],
  manifestFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  installDirs: [],
  scanImports: scanWith(/^\s*import\s+(?:static\s+)?([\w.]+)/gm, 'import'),
  // Platform namespaces are not dependencies; everything else folds to its
  // top two segments so a package is counted once, not once per class.
  normalize: (s) => {
    const parts = s.split('.');
    if (['java', 'javax', 'jdk', 'kotlin'].includes(parts[0])) return null;
    return parts.slice(0, 2).join('.');
  },
  readManifest: readMavenGradle,
};

export const csharp = {
  id: 'csharp',
  name: 'C#',
  tier: 3,
  ghostCapable: false,
  reason: 'using directives do not map to NuGet package ids without a registry index',
  extensions: ['.cs'],
  manifestFiles: ['packages.config', '.csproj'],
  installDirs: [],
  scanImports: scanWith(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm, 'using'),
  normalize: (s) => {
    const parts = s.split('.');
    if (parts[0] === 'System') return null; // the BCL is not a dependency
    return parts.slice(0, 2).join('.');
  },
  readManifest: readCsproj,
};

export const php = {
  id: 'php',
  name: 'PHP',
  tier: 3,
  ghostCapable: false,
  reason: 'PSR-4 namespaces map to Composer packages only via an installed vendor/ tree',
  extensions: ['.php'],
  manifestFiles: ['composer.json'],
  installDirs: ['vendor'],
  scanImports: scanWith(/^\s*use\s+([\w\\]+)/gm, 'use'),
  normalize: (s) => s,
  readManifest: readComposer,
};

export const c = {
  id: 'c',
  name: 'C / C++',
  tier: 3,
  ghostCapable: false,
  reason: 'no dependency manifest exists; #include resolves against compiler search paths',
  extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
  manifestFiles: [],
  installDirs: [],
  scanImports: (src) => {
    const { masked } = mask(src, C_STYLE);
    const starts = lineIndex(src);
    const found = [];
    for (const m of masked.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
      const { line, column } = positionOf(starts, m.index + m[0].indexOf(m[1]));
      found.push({ specifier: m[1], line, column, kind: 'include' });
    }
    return found;
  },
  normalize: (s) => s,
  readManifest: async () => null,
};
