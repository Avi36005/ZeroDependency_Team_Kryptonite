// A deterministic single-file bundler.
//
// Replaces: `esbuild`, `rollup`, `webpack`, `ncc`.
//
// The reflex when you want to ship one file is to install a bundler. We need
// exactly one feature of one - inline a module graph we control - and the
// graph is nine modules deep with no dynamic imports, no CSS, no minifying
// and no tree shaking to do. That is a topological sort and a handful of
// textual rewrites.
//
// Every module becomes an IIFE returning its exports, which keeps module
// scope intact. That matters here: `scanImports`, `normalize` and
// `readManifest` are each defined in five different language adapters, and
// naive concatenation would have them overwrite one another silently.
//
// Output is byte-identical across runs: modules are emitted in a
// deterministic order, builtin imports are sorted, and nothing records a
// timestamp, a path from the build machine, or a hash of anything.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Only the forms this codebase actually uses. Anything else must fail loudly. */
const IMPORT_LOCAL_NAMED = /^import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?$/;
const IMPORT_LOCAL_DEFAULT = /^import\s+(\w+)\s+from\s*['"](\.[^'"]+)['"];?$/;
const IMPORT_BUILTIN = /^import\s*(?:\{([^}]*)\}|(\w+))\s*from\s*['"](node:[^'"]+)['"];?$/;

/** A stable identifier for a module, derived from its path, not a counter. */
const moduleId = (absPath) =>
  '__m_' + relative(ROOT, absPath).replace(/[^a-zA-Z0-9]/g, '_');

/**
 * Read a module, resolve its local imports, and return its source split into
 * the parts the emitter needs.
 */
async function load(absPath) {
  const source = await readFile(absPath, 'utf8');
  const deps = [];
  const builtins = [];
  const body = [];

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();

    // A shebang is only legal on the first line of the output, and the
    // emitter writes its own.
    if (line.startsWith('#!')) {
      body.push('');
      continue;
    }

    const builtin = IMPORT_BUILTIN.exec(line.trim());
    if (builtin) {
      const [, named, def, specifier] = builtin;
      builtins.push({ named: named?.trim(), default: def, specifier });
      body.push(''); // keep line numbering stable for stack traces
      continue;
    }

    const named = IMPORT_LOCAL_NAMED.exec(line.trim());
    if (named) {
      const target = resolve(dirname(absPath), named[2]);
      deps.push(target);
      body.push(`const {${named[1]}} = ${moduleId(target)};`);
      continue;
    }

    const def = IMPORT_LOCAL_DEFAULT.exec(line.trim());
    if (def) {
      const target = resolve(dirname(absPath), def[2]);
      deps.push(target);
      body.push(`const ${def[1]} = ${moduleId(target)}.default;`);
      continue;
    }

    if (/^\s*import\s/.test(line) && /from\s*['"]/.test(line)) {
      throw new Error(`bundle: unsupported import form in ${relative(ROOT, absPath)}: ${line.trim()}`);
    }

    body.push(line);
  }

  return { path: absPath, deps, builtins, body: body.join('\n') };
}

/**
 * Depth-first post-order walk, so a module is emitted after its imports.
 *
 * Order is collected in an explicit array rather than by Map insertion:
 * re-setting an existing Map key keeps its original position, which would
 * emit the entry module first and reference every other module before it
 * was initialised.
 */
async function collect(entry) {
  const seen = new Set();
  const ordered = [];

  async function visit(absPath) {
    if (seen.has(absPath)) return;
    seen.add(absPath); // marked before recursing: breaks import cycles
    const mod = await load(absPath);
    for (const dep of mod.deps) await visit(dep);
    ordered.push(mod);
  }

  await visit(entry);
  return ordered;
}

/**
 * Turn `export` declarations into plain ones and collect the exported names,
 * so the IIFE can return them as its module object.
 */
function rewriteExports(body) {
  const names = new Set();
  let out = body;

  out = out.replace(/^export\s+(async\s+)?function(\s*\*)?\s+(\w+)/gm, (_, async_, star, name) => {
    names.add(name);
    return `${async_ ?? ''}function${star ?? ''} ${name}`;
  });
  out = out.replace(/^export\s+(const|let|class)\s+(\w+)/gm, (_, kind, name) => {
    names.add(name);
    return `${kind} ${name}`;
  });

  let hasDefault = false;
  out = out.replace(/^export\s+default\s+/m, () => {
    hasDefault = true;
    return 'const __default = ';
  });

  if (/^export\s/m.test(out)) {
    const stray = /^export\s.*$/m.exec(out)[0];
    throw new Error(`bundle: unsupported export form: ${stray.trim()}`);
  }

  const fields = [...names].sort().map((n) => `${n}: ${n}`);
  if (hasDefault) fields.push('default: __default');
  return { body: out, returns: `{ ${fields.join(', ')} }` };
}

export async function bundle(entryRelative) {
  const entry = resolve(ROOT, entryRelative);
  const modules = await collect(entry);

  // One import per builtin, sorted, so the header is identical every run.
  const builtinNamed = new Map();
  const builtinDefault = new Map();
  for (const mod of modules) {
    for (const b of mod.builtins) {
      if (b.named) {
        const set = builtinNamed.get(b.specifier) ?? new Set();
        for (const n of b.named.split(',')) if (n.trim()) set.add(n.trim());
        builtinNamed.set(b.specifier, set);
      }
      if (b.default) builtinDefault.set(b.specifier, b.default);
    }
  }

  const header = [];
  for (const specifier of [...builtinNamed.keys()].sort()) {
    const names = [...builtinNamed.get(specifier)].sort().join(', ');
    header.push(`import { ${names} } from '${specifier}';`);
  }
  for (const specifier of [...builtinDefault.keys()].sort()) {
    header.push(`import ${builtinDefault.get(specifier)} from '${specifier}';`);
  }

  const chunks = [
    '#!/usr/bin/env node',
    '// depx - generated single-file build. Do not edit; edit src/ and run `make dist`.',
    '// Built by tools/bundle.mjs, which is itself dependency-free.',
    '',
    ...header,
    '',
  ];

  for (const mod of modules) {
    const isEntry = mod.path === entry;
    const { body, returns } = rewriteExports(mod.body);
    if (isEntry) {
      chunks.push('// ---- entry ----', body.trim(), '');
    } else {
      chunks.push(
        `// ---- ${relative(ROOT, mod.path)} ----`,
        `const ${moduleId(mod.path)} = (() => {`,
        body.trim(),
        `return ${returns};`,
        '})();',
        '',
      );
    }
  }

  return chunks.join('\n');
}

// Writing the artifact is what `make dist` wants; importing this module to
// test `bundle()` should not touch the filesystem.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(ROOT, 'dist/depx.mjs');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await bundle('bin/depx.mjs'));
  process.stdout.write(`bundled: ${relative(ROOT, out)}\n`);
}
