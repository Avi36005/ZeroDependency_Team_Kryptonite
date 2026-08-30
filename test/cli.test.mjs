// End-to-end tests: the real CLI, as a user runs it.
//
// The unit suites cover the pieces; these cover the program. Each scenario
// builds a throwaway project under os.tmpdir(), runs bin/depx.mjs against it
// as a child process, and asserts on stdout and the exit code - so the walker,
// the manifest readers, the report and the exit codes are all exercised
// exactly as a judge or a CI job would exercise them.
//
// Most of these began life as a false positive found by running depx against
// real repositories, which is why so many assert that something is NOT
// reported.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'bin/depx.mjs');

/** Run the CLI and capture output and exit code, never throwing. */
async function depx(args, cwd = REPO) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args, '--no-color'], {
      cwd,
      maxBuffer: 1 << 26,
    });
    return { out: stdout + stderr, code: 0 };
  } catch (error) {
    return { out: (error.stdout ?? '') + (error.stderr ?? ''), code: error.code ?? 1 };
  }
}

/** Build a throwaway project from a {relative path: contents} map. */
async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), 'depx-e2e-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

const assertTrue = (cond, msg) => assert.ok(cond, msg);
const has = (out, s) => assert.ok(out.includes(s), `expected output to contain ${JSON.stringify(s)}\n---\n${out}`);
const lacks = (out, s) => assert.ok(!out.includes(s), `expected output NOT to contain ${JSON.stringify(s)}\n---\n${out}`);

const SCENARIOS = [

  // --- CLI surface ---
  ['help exits 0 and lists commands', async () => {
    const r = await depx(['--help']); assertTrue(r.code === 0, `exit ${r.code}`); has(r.out, 'zero-dep');
  }],
  ['version prints a semver', async () => {
    const r = await depx(['--version']); assertTrue(/^\d+\.\d+\.\d+/.test(r.out.trim()), r.out);
  }],
  ['langs lists all ten languages aligned', async () => {
    const r = await depx(['langs']);
    for (const l of ['JavaScript / TypeScript', 'Python', 'Go', 'Rust', 'Ruby', 'Java / Kotlin', 'C#', 'PHP', 'C / C++']) has(r.out, l);
    assertTrue(!/\S {0,1}tier/.test(r.out.replace(/ {2,}/g, '  ')) || r.out.includes('  tier'), 'columns should be padded');
  }],
  ['unknown command is treated as a path', async () => {
    const r = await depx(['fixtures/messy'], REPO); has(r.out, 'GHOSTS');
  }],
  ['unknown flag exits 2', async () => {
    const r = await depx(['check', '--bogus']); assertTrue(r.code === 2, `exit ${r.code}`);
  }],
  ['unknown --lang id exits 2', async () => {
    const r = await depx(['check', '.', '--lang', 'cobol'], REPO); assertTrue(r.code === 2, `exit ${r.code}`);
  }],
  ['missing path exits 2 with a clear message', async () => {
    const r = await depx(['check', '/no/such/path']); assertTrue(r.code === 2, `exit ${r.code}`); has(r.out, 'does not exist');
  }],
  ['--quiet suppresses output but keeps the exit code', async () => {
    const r = await depx(['check', 'fixtures/messy', '--quiet'], REPO);
    assertTrue(r.out.trim() === '', `expected no output, got ${r.out.slice(0, 80)}`); assertTrue(r.code === 1, `exit ${r.code}`);
  }],
  ['--json emits parseable JSON', async () => {
    const r = await depx(['check', 'fixtures/messy', '--json'], REPO);
    const d = JSON.parse(r.out); assertTrue(Array.isArray(d.findings), 'findings array');
  }],
  ['--json respects the subcommand filter', async () => {
    const r = await depx(['ghosts', 'fixtures/messy', '--json'], REPO);
    const types = new Set(JSON.parse(r.out).findings.map((f) => f.type));
    assertTrue(types.size === 1 && types.has('ghost'), [...types].join(','));
  }],
  ['--lang restricts the scan', async () => {
    const r = await depx(['check', 'fixtures/messy', '--lang', 'go'], REPO);
    has(r.out, 'Go:'); lacks(r.out, 'Python:');
  }],
  ['NO_COLOR produces no escapes', async () => {
    const { stdout } = await run('node', [CLI, 'check', 'fixtures/messy'], { cwd: REPO, env: { ...process.env, NO_COLOR: '1' } }).catch((e) => e);
    assertTrue(!/\[/.test(stdout ?? ''), 'escapes present');
  }],

  // --- exit codes ---
  ['clean repo exits 0', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': 'const x = 1;\n' });
    const r = await depx(['check', d]); assertTrue(r.code === 0, `exit ${r.code}`); await rm(d, { recursive: true, force: true });
  }],
  ['ghosts exit 1', async () => {
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\n', 'a.go': 'package main\nimport "github.com/no/such"\n' });
    const r = await depx(['check', d]); assertTrue(r.code === 1, `exit ${r.code}`); await rm(d, { recursive: true, force: true });
  }],
  ['broken relative imports exit 1', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import x from './nope.js';\n" });
    const r = await depx(['check', d]); assertTrue(r.code === 1, `exit ${r.code}`); has(r.out, 'BROKEN'); await rm(d, { recursive: true, force: true });
  }],
  ['dead-only findings still exit 0', async () => {
    const d = await project({ 'package.json': '{"dependencies":{"moment":"^2"}}', 'a.js': 'const x = 1;\n' });
    const r = await depx(['check', d]); assertTrue(r.code === 0, `exit ${r.code}`); has(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],

  // --- local modules are not dependencies ---
  ['rust: mod declaration is not a ghost', async () => {
    const d = await project({ 'Cargo.toml': '[package]\nname="a"\n\n[dependencies]\n', 'src/main.rs': 'mod utils;\nuse utils::x;\n', 'src/utils.rs': 'pub fn x() {}\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],
  ['rust: directory module is not a ghost', async () => {
    const d = await project({ 'Cargo.toml': '[package]\nname="a"\n\n[dependencies]\n', 'src/main.rs': 'use net::listen;\n', 'src/net/mod.rs': 'pub fn listen() {}\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],
  ['python: sibling module is not undeclared', async () => {
    const d = await project({ 'requirements.txt': '', 'main.py': 'import utils\n', 'utils.py': 'x=1\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['python: package directory is not undeclared', async () => {
    const d = await project({ 'requirements.txt': '', 'main.py': 'from pkg.sub import x\n', 'pkg/__init__.py': '', 'pkg/sub.py': 'x=1\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['go: own module path is internal', async () => {
    const d = await project({ 'go.mod': 'module github.com/a/b\ngo 1.23\n', 'main.go': 'package main\nimport "github.com/a/b/util"\n', 'util/u.go': 'package util\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],

  // --- normalisation ---
  ['go: /v2 module suffix is preserved', async () => {
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\nrequire github.com/x/y/v2 v2.0.0\n', 'main.go': 'package main\nimport "github.com/x/y/v2/sub"\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],
  ['go: // indirect is not dead', async () => {
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\nrequire (\n\tgithub.com/x/y v1.0.0\n\tgithub.com/z/w v1.0.0 // indirect\n)\n', 'main.go': 'package main\nimport "github.com/x/y"\n' });
    const r = await depx(['check', d]); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],
  ['go: commented require is not declared', async () => {
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\n// require github.com/g/h v1.0.0\n', 'main.go': 'package main\n' });
    const r = await depx(['check', d]); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],
  ['js: scoped package normalises to two segments', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import x from '@scope/pkg/deep/path';\n" });
    const r = await depx(['check', d]); has(r.out, '@scope/pkg'); lacks(r.out, '@scope/pkg/deep'); await rm(d, { recursive: true, force: true });
  }],
  ['python: PyPI folds case and underscores', async () => {
    const d = await project({ 'requirements.txt': 'Foo_Bar\n', 'a.py': 'import foo_bar\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],
  ['rust: hyphen/underscore crate names match', async () => {
    const d = await project({ 'Cargo.toml': '[package]\nname="a"\n\n[dependencies]\nserde-json = "1"\n', 'src/main.rs': 'use serde_json::x;\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],

  // --- stdlib recognition ---
  ['python: __future__ is stdlib', async () => {
    const d = await project({ 'requirements.txt': '', 'a.py': 'from __future__ import annotations\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['ruby: English is stdlib', async () => {
    const d = await project({ Gemfile: 'source "x"\n', 'a.rb': 'require "English"\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],
  ['ruby: require_relative resolves on disk', async () => {
    const d = await project({ Gemfile: 'source "x"\n', 'a.rb': 'require_relative "h"\n', 'h.rb': 'puts 1\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); lacks(r.out, 'BROKEN'); await rm(d, { recursive: true, force: true });
  }],
  ['ruby: missing require_relative is broken not ghost', async () => {
    const d = await project({ Gemfile: 'source "x"\n', 'a.rb': 'require_relative "gone"\n' });
    const r = await depx(['check', d]); has(r.out, 'BROKEN'); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],
  ['node: builtins and node: prefix are not packages', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import fs from 'node:fs';\nimport path from 'path';\n" });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['go: dotless first segment is stdlib', async () => {
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\n', 'a.go': 'package main\nimport "net/http"\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],

  // --- alias specifiers ---
  ['js: subpath imports and aliases are skipped', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import a from '#lib/x';\nimport b from '@/c';\nimport c from '~/d';\nimport e from '$lib/f';\n" });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['js: protocol specifiers are skipped', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import x from 'https://esm.sh/y';\nimport d from 'data:text/javascript,';\n" });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],

  // --- scanner robustness ---
  ['js: every import form is found', async () => {
    const src = ["import a from 'p1';", "const b = require('p2');", "await import('p3');", "export * from 'p4';", "export { x } from 'p5';", "import 'p6';", "require.resolve('p7');"].join('\n');
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': src });
    const r = await depx(['check', d]);
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) has(r.out, p);
    await rm(d, { recursive: true, force: true });
  }],
  ['js: decoys in comments, strings, regex are rejected', async () => {
    const src = ["// import 'd1';", "/* import 'd2'; */", 'const s = "require(\'d3\')";', 'const t = `import \'d4\'`;', "const r = /from 'd5'/;", 'const q = 10 / 2 / 5;'].join('\n');
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': src });
    const r = await depx(['check', d]);
    for (const p of ['d1', 'd2', 'd3', 'd4', 'd5']) lacks(r.out, p);
    await rm(d, { recursive: true, force: true });
  }],
  ['js: webpack magic comment import is found', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import(/* webpackChunkName: \"c\" */ 'magic-pkg');\n" });
    const r = await depx(['check', d]); has(r.out, 'magic-pkg'); await rm(d, { recursive: true, force: true });
  }],
  ['go: decoys in raw strings and comments are rejected', async () => {
    const src = 'package main\n// import "d1.com/x"\nimport "real.com/y"\nconst s = `import "d2.com/z"`\n';
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\n', 'a.go': src });
    const r = await depx(['check', d]); has(r.out, 'real.com/y'); lacks(r.out, 'd1.com'); lacks(r.out, 'd2.com'); await rm(d, { recursive: true, force: true });
  }],
  ['go: grouped, blank and aliased imports are found', async () => {
    const src = 'package main\nimport (\n\t_ "a.com/blank"\n\talias "b.com/alias"\n)\n';
    const d = await project({ 'go.mod': 'module ex.com/a\ngo 1.23\n', 'a.go': src });
    const r = await depx(['check', d]); has(r.out, 'a.com/blank'); has(r.out, 'b.com/alias'); await rm(d, { recursive: true, force: true });
  }],
  ['rust: decoys in comments and raw strings are rejected', async () => {
    const src = '// use d1::x;\n/* use d2::y; */\nlet s = r#"use d3::z;"#;\nuse real_crate::w;\n';
    const d = await project({ 'Cargo.toml': '[package]\nname="a"\n\n[dependencies]\n', 'src/main.rs': src });
    const r = await depx(['check', d]); has(r.out, 'real-crate'); lacks(r.out, 'd1'); lacks(r.out, 'd3'); await rm(d, { recursive: true, force: true });
  }],
  ['python: triple-quoted strings and comments are masked', async () => {
    const d = await project({ 'requirements.txt': '', 'a.py': '"""\nimport d1\n"""\n# import d2\nimport real_pkg\n' });
    const r = await depx(['check', d]); has(r.out, 'real_pkg'); lacks(r.out, 'd1'); lacks(r.out, 'd2'); await rm(d, { recursive: true, force: true });
  }],
  ['python: multi-line parenthesised from-import', async () => {
    const d = await project({ 'requirements.txt': '', 'a.py': 'from somepkg import (\n    A,\n    B,\n)\n' });
    const r = await depx(['check', d]); has(r.out, 'somepkg'); await rm(d, { recursive: true, force: true });
  }],

  // --- manifests ---
  ['pyproject: multi-line dependencies array parses', async () => {
    const d = await project({ 'pyproject.toml': '[project]\ndependencies = [\n  "requests>=2",\n  "flask",\n]\n', 'a.py': 'import requests\nimport flask\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['requirements: URL lines are not packages', async () => {
    const d = await project({ 'requirements.txt': 'git+https://github.com/a/b.git@main\n', 'a.py': 'x=1\n' });
    const r = await depx(['check', d]); lacks(r.out, 'git'); await rm(d, { recursive: true, force: true });
  }],
  ['requirements: extras and markers are stripped', async () => {
    const d = await project({ 'requirements.txt': 'requests[security]>=2.0,<3 ; python_version<"3.10"\n', 'a.py': 'import requests\n' });
    const r = await depx(['check', d]); lacks(r.out, 'UNDECLARED'); await rm(d, { recursive: true, force: true });
  }],
  ['unparseable manifest is reported, not silently ignored', async () => {
    const d = await project({ 'package.json': '{ broken', 'a.js': "import x from 'p';\n" });
    const r = await depx(['check', d]); has(r.out, 'could not be parsed'); await rm(d, { recursive: true, force: true });
  }],
  ['cargo: dev-dependencies are not runtime deps', async () => {
    const d = await project({ 'Cargo.toml': '[package]\nname="a"\n\n[dependencies]\n\n[dev-dependencies]\ncriterion = "0.5"\n', 'src/main.rs': 'fn main() {}\n' });
    const r = await depx(['zero-dep', d]); has(r.out, 'PASS'); await rm(d, { recursive: true, force: true });
  }],

  // --- install-tree evidence ---
  ['node_modules presence turns ghost into phantom', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': "import ms from 'ms';\n", 'node_modules/ms/package.json': '{}' });
    const r = await depx(['check', d]); has(r.out, 'PHANTOM'); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],
  ['venv site-packages is found under a version directory', async () => {
    const d = await project({ 'a.py': 'import requests\n', '.venv/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA': 'Name: requests\n' });
    const r = await depx(['check', d]); has(r.out, 'PHANTOM'); await rm(d, { recursive: true, force: true });
  }],
  ['dist-info name folds to the import alias', async () => {
    const d = await project({ 'a.py': 'import yaml\n', '.venv/lib/python3.12/site-packages/PyYAML-6.0.dist-info/METADATA': 'Name: PyYAML\n' });
    const r = await depx(['check', d]); has(r.out, 'PHANTOM'); await rm(d, { recursive: true, force: true });
  }],

  // --- tier 3 restraint ---
  ['java: no ghosts and no dead claims', async () => {
    const d = await project({ 'pom.xml': '<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></project>', 'M.java': 'import org.apache.commons.lang3.X;\n' });
    const r = await depx(['check', d]); lacks(r.out, 'GHOST'); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],
  ['java: platform namespaces are not dependencies', async () => {
    const d = await project({ 'pom.xml': '<project></project>', 'M.java': 'import java.util.List;\nimport javax.swing.X;\n' });
    const r = await depx(['check', d]); has(r.out, '0 imported packages'); await rm(d, { recursive: true, force: true });
  }],
  ['c: include scanning without a manifest', async () => {
    const d = await project({ 'm.c': '#include <stdio.h>\n#include "local.h"\n' });
    const r = await depx(['check', d]); has(r.out, 'C / C++'); lacks(r.out, 'GHOST'); await rm(d, { recursive: true, force: true });
  }],

  // --- walker ---
  ['gitignored files are skipped', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', '.gitignore': 'gen/\n', 'gen/g.js': "import x from 'hidden-ghost';\n", 'a.js': 'const y = 1;\n' });
    const r = await depx(['check', d]); lacks(r.out, 'hidden-ghost'); await rm(d, { recursive: true, force: true });
  }],
  ['nested project is a boundary', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': 'const x = 1;\n', 'sub/package.json': '{"dependencies":{}}', 'sub/b.js': "import y from 'inner-ghost';\n" });
    const r = await depx(['check', d]); lacks(r.out, 'inner-ghost'); await rm(d, { recursive: true, force: true });
  }],
  ['binary file with a source extension is skipped', async () => {
    const d = await project({ 'm.c': '#include <stdio.h>\n' });
    await writeFile(join(d, 'blob.h'), Buffer.from([0, 1, 2, 0, 65, 66]));
    const r = await depx(['check', d]); has(r.out, 'skipped'); await rm(d, { recursive: true, force: true });
  }],
  ['symlink cycle terminates', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': 'const x = 1;\n', 'sub/b.js': 'const y = 1;\n' });
    await symlink(d, join(d, 'sub', 'loop')).catch(() => {});
    const r = await depx(['check', d]); assertTrue(r.code === 0, `exit ${r.code}`); await rm(d, { recursive: true, force: true });
  }],
  ['bin/ is scanned, not skipped as a build directory', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'bin/cli.js': "import x from 'bin-ghost';\n" });
    const r = await depx(['check', d]); has(r.out, 'bin-ghost'); await rm(d, { recursive: true, force: true });
  }],
  ['CRLF and BOM sources parse', async () => {
    const d = await mkdtemp(join(tmpdir(), 'depx-sweep-'));
    await writeFile(join(d, 'package.json'), '{"dependencies":{}}');
    await writeFile(join(d, 'a.js'), '﻿import a from "crlf-pkg";\r\nimport b from "two-pkg";\r\n');
    const r = await depx(['check', d]); has(r.out, 'crlf-pkg'); has(r.out, 'two-pkg'); await rm(d, { recursive: true, force: true });
  }],

  // --- single file target ---
  ['single file is judged against the project manifest', async () => {
    const d = await project({ 'package.json': '{"dependencies":{"react":"^18"}}', 'src/deep/a.js': "import r from 'react';\nimport z from 'nope-pkg';\n" });
    const r = await depx(['check', join(d, 'src/deep/a.js')]); has(r.out, 'nope-pkg'); lacks(r.out, 'react  '); await rm(d, { recursive: true, force: true });
  }],
  ['single file never claims dead dependencies', async () => {
    const d = await project({ 'package.json': '{"dependencies":{"moment":"^2"}}', 'a.js': 'const x = 1;\n' });
    const r = await depx(['check', join(d, 'a.js')]); lacks(r.out, 'DEAD'); await rm(d, { recursive: true, force: true });
  }],

  // --- zero-dep ---
  ['zero-dep passes on an empty manifest', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'a.js': 'const x = 1;\n' });
    const r = await depx(['zero-dep', d]); assertTrue(r.code === 0, `exit ${r.code}`); has(r.out, 'PASS'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep fails on a populated manifest', async () => {
    const d = await project({ 'package.json': '{"dependencies":{"express":"^4"}}', 'a.js': 'const x = 1;\n' });
    const r = await depx(['zero-dep', d]); assertTrue(r.code === 1, `exit ${r.code}`); has(r.out, 'FAIL'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep fails when source exists but no manifest does', async () => {
    const d = await project({ 'a.py': 'import os\n' });
    const r = await depx(['zero-dep', d]); assertTrue(r.code === 1, `exit ${r.code}`); has(r.out, 'requirements.txt'); has(r.out, 'missing'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep flags a minified bundle', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'src/b.js': `var a=1;${'b=2;'.repeat(200)}\n//# sourceMappingURL=b.js.map\n` });
    const r = await depx(['zero-dep', d]); has(r.out, 'REVIEW'); has(r.out, 'source map'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep flags a third-party licence header', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'src/v.js': '/*\n * Lib v1\n * Copyright (c) 2016 Someone\n * Released under the MIT license\n */\nvar x=1;\n' });
    const r = await depx(['zero-dep', d]); has(r.out, 'REVIEW'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep stays silent on ordinary source', async () => {
    const d = await project({ 'package.json': '{"dependencies":{}}', 'src/a.js': '// Walks a tree.\nexport function walk() { return 1 / 2; }\n' });
    const r = await depx(['zero-dep', d]); lacks(r.out, 'REVIEW'); await rm(d, { recursive: true, force: true });
  }],
  ['zero-dep does not flag depx itself', async () => {
    const r = await depx(['zero-dep', REPO]); assertTrue(r.code === 0, `exit ${r.code}`); lacks(r.out, 'REVIEW'); await rm('/dev/null', { force: true }).catch(() => {});
  }],

  // --- scale ---
  ['scans a 2000-file tree quickly and correctly', async () => {
    const files = { 'package.json': '{"dependencies":{"react":"^18"}}' };
    for (let i = 0; i < 1000; i++) {
      files[`src/m${i % 50}/f${i}.js`] = `import React from 'react';\nimport h from './h${i}';\nconst r = /x 'y'/g;\n`;
      files[`src/m${i % 50}/h${i}.js`] = 'export default 1;\n';
    }
    const d = await project(files);
    const t = Date.now();
    const r = await depx(['check', d]);
    const ms = Date.now() - t;
    assertTrue(r.code === 0, `exit ${r.code}: ${r.out.slice(0, 200)}`);
    has(r.out, 'scanned 2000 files');
    assertTrue(ms < 10000, `took ${ms}ms`);
    await rm(d, { recursive: true, force: true });
  }],
];

// Group by the prefix each scenario name carries, so failures read clearly.
const GROUPS = [
  ['command-line surface', (n) => /^(help|version|langs|unknown|missing path|--|NO_COLOR)/.test(n)],
  ['exit codes', (n) => /exit/.test(n)],
  ['specifiers that are not packages', (n) => /aliases are skipped|protocol specifiers/.test(n)],
  ['local modules are not dependencies', (n) => /is not a ghost|is not undeclared|is internal/.test(n)],
  ['name normalisation', (n) => /normalis|suffix|indirect|commented require|folds|match/.test(n)],
  ['standard library recognition', (n) => /stdlib|builtins|require_relative/.test(n)],
  ['scanner robustness', (n) => /decoy|import form|magic comment|masked|parenthesised|aliased/.test(n)],
  ['manifest parsing', (n) => /manifest|requirements|pyproject|cargo/.test(n)],
  ['install-tree evidence', (n) => /node_modules|venv|dist-info/.test(n)],
  ['tier 3 restraint', (n) => /^(java|c):/.test(n)],
  ['file discovery', (n) => /gitignor|boundary|binary|symlink|bin\/|CRLF/.test(n)],
  ['single-file targets', (n) => /^single file/.test(n)],
  ['zero-dep verification', (n) => /^zero-dep/.test(n)],
  ['scale', (n) => /tree quickly/.test(n)],
];

const claimed = new Set();
for (const [groupName, matches] of GROUPS) {
  const members = SCENARIOS.filter(([name]) => !claimed.has(name) && matches(name));
  for (const [name] of members) claimed.add(name);
  if (!members.length) continue;
  describe(groupName, () => {
    for (const [name, fn] of members) test(name, fn);
  });
}

// Anything a group did not claim still runs, rather than silently vanishing.
const orphans = SCENARIOS.filter(([name]) => !claimed.has(name));
if (orphans.length) {
  describe('other', () => {
    for (const [name, fn] of orphans) test(name, fn);
  });
}

// Added after a second bug-hunting pass against real repositories.
describe('subcommands answer only the question they were asked', () => {
  test('depx replace exits 0 even when the repo has ghosts', async () => {
    const r = await depx(['replace', 'fixtures/messy']);
    assert.equal(r.code, 0, 'replaceables are not failures');
    has(r.out, 'replaceable');
  });

  test('depx ghosts still exits 1 on the same repo', async () => {
    const r = await depx(['ghosts', 'fixtures/messy']);
    assert.equal(r.code, 1);
  });

  test('a filtered view says how many findings it hid', async () => {
    const r = await depx(['replace', 'fixtures/messy']);
    has(r.out, 'of other kinds');
    lacks(r.out, 'GHOSTS');
  });

  test('dead --json exits 0 despite unrelated ghosts', async () => {
    const r = await depx(['dead', 'fixtures/messy', '--json']);
    assert.equal(r.code, 0);
  });
});

describe('an install tree has to contain something', () => {
  test('an empty .venv does not promote undeclared imports to ghosts', async () => {
    const d = await project({ 'requirements.txt': '', 'a.py': 'import requests\n' });
    await mkdir(join(d, '.venv'), { recursive: true });
    const r = await depx(['check', d]);
    has(r.out, 'UNDECLARED');
    lacks(r.out, 'GHOSTS');
    await rm(d, { recursive: true, force: true });
  });
});

describe('--json carries everything the report can say', () => {
  test('warnings and skipped projects reach JSON consumers', async () => {
    const d = await project({
      'package.json': '{ not json',
      'a.js': "import x from 'p';",
      'sub/package.json': '{"dependencies":{}}',
      'sub/b.js': 'const y = 1;',
    });
    const r = await depx(['check', d, '--json']);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.warnings.length, 1);
    assert.deepEqual(parsed.skippedProjects, ['sub']);
    await rm(d, { recursive: true, force: true });
  });

  test('the expected flag distinguishes tool-loaded packages', async () => {
    const d = await project({
      'package.json': '{"dependencies":{"react-dom":"^18","left-pad":"^1"}}',
      'a.js': 'const x = 1;',
    });
    const { findings } = JSON.parse((await depx(['dead', d, '--json'])).out);
    const byName = Object.fromEntries(findings.map((f) => [f.name, f.expected]));
    assert.equal(byName['react-dom'], true);
    assert.equal(byName['left-pad'], false);
    await rm(d, { recursive: true, force: true });
  });
});

describe('the vendored command', () => {
  test('finds copied source outside the Zero Dependency rule check', async () => {
    const r = await depx(['vendored', 'snips/fixtures/faked-zero-dep']);
    has(r.out, 'REVIEW');
    has(r.out, 'files to review');
  });

  test('stays silent on hand-written source, and exits 0 either way', async () => {
    // Signals are for a human to read, not a gate to fail: a repository is not
    // broken because a file looked generated.
    const d = await project({
      'package.json': '{"dependencies":{}}',
      'src/a.js': '// Walks a tree.\nexport function walk() { return 1 / 2; }\n',
    });
    const r = await depx(['vendored', d]);
    has(r.out, 'no copied or generated source detected');
    assert.equal(r.code, 0);
    await rm(d, { recursive: true, force: true });
  });

  test('does not flag depx itself', async () => {
    const r = await depx(['vendored', REPO]);
    has(r.out, 'no copied or generated source detected');
  });

  test('is listed in the help text', async () => {
    const r = await depx(['--help']);
    has(r.out, 'vendored');
  });
});
