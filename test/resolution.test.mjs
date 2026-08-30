// Regression tests for the resolution rules - the places where an import
// looks like a missing package but is not one.
//
// Every case here was a false positive found by running depx against real
// repositories. A false ghost is the worst bug this tool can have: it sends
// someone hunting for a supply-chain attack that is not there, and a tool
// that cries wolf gets uninstalled.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/core.mjs';

/** Build a throwaway project from a {path: contents} map and analyse it. */
async function inProject(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'depx-test-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, body);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const names = (result, type) =>
  result.findings.filter((f) => f.type === type).map((f) => f.name).sort();

describe('local modules are not dependencies', () => {
  test('Rust: a file declared with `mod` is not a missing crate', async () => {
    await inProject(
      {
        'Cargo.toml': '[package]\nname = "demo"\n\n[dependencies]\n',
        'src/main.rs': 'mod utils;\nuse utils::helper;\nfn main() {}\n',
        'src/utils.rs': 'pub fn helper() {}\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
      },
    );
  });

  test('Rust: a directory module (net/mod.rs) is not a missing crate', async () => {
    await inProject(
      {
        'Cargo.toml': '[package]\nname = "demo"\n\n[dependencies]\n',
        'src/main.rs': 'use net::listen;\nfn main() {}\n',
        'src/net/mod.rs': 'pub fn listen() {}\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
      },
    );
  });

  test('Python: a sibling module is not a missing distribution', async () => {
    await inProject(
      {
        'requirements.txt': '',
        'main.py': 'import utils\nimport pkg.thing\n',
        'utils.py': 'x = 1\n',
        'pkg/__init__.py': '',
        'pkg/thing.py': 'y = 2\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.deepEqual(names(result, 'undeclared'), []);
      },
    );
  });

  test('Go: a package inside the declared module is not external', async () => {
    await inProject(
      {
        'go.mod': 'module github.com/acme/app\n\ngo 1.23\n',
        'main.go': 'package main\nimport "github.com/acme/app/util"\n',
        'util/util.go': 'package util\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
      },
    );
  });
});

describe('name normalisation', () => {
  test('Go: a /v2 module path survives trimming to module granularity', async () => {
    await inProject(
      {
        'go.mod': 'module example.com/app\n\ngo 1.23\n\nrequire github.com/acme/lib/v2 v2.1.0\n',
        'main.go': 'package main\nimport "github.com/acme/lib/v2/sub"\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.deepEqual(names(result, 'dead'), []);
      },
    );
  });

  test('Go: an // indirect requirement is not reported as dead', async () => {
    await inProject(
      {
        'go.mod':
          'module example.com/app\n\ngo 1.23\n\nrequire (\n\tgithub.com/real/dep v1.0.0\n\tgithub.com/tran/dep v1.0.0 // indirect\n)\n',
        'main.go': 'package main\nimport "github.com/real/dep"\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'dead'), []);
      },
    );
  });

  test('Go: a commented-out require line is not a declaration', async () => {
    await inProject(
      {
        'go.mod': 'module example.com/app\ngo 1.23\n// require github.com/ghost/dep v1.0.0\n',
        'main.go': 'package main\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'dead'), []);
      },
    );
  });
});

describe('standard library recognition', () => {
  test('Python: __future__ is not a package', async () => {
    await inProject(
      { 'requirements.txt': '', 'a.py': 'from __future__ import annotations\n' },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.findings.length, 0);
      },
    );
  });

  test('Ruby: English is stdlib, and require_relative is a path', async () => {
    await inProject(
      {
        Gemfile: 'source "https://rubygems.org"\n',
        'app.rb': 'require "English"\nrequire_relative "helper"\n',
        'helper.rb': 'puts 1\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.deepEqual(names(result, 'broken'), []);
      },
    );
  });

  test('Ruby: require_relative pointing at nothing is broken, not a ghost', async () => {
    await inProject(
      {
        Gemfile: 'source "https://rubygems.org"\n',
        'app.rb': 'require_relative "missing"\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.equal(names(result, 'broken').length, 1);
      },
    );
  });
});

describe('specifiers that are not packages', () => {
  test('JavaScript: subpath imports and bundler aliases are skipped', async () => {
    await inProject(
      {
        'package.json': '{"dependencies":{}}',
        'a.js': [
          "import a from '#internal/x';",
          "import b from '@/components/y';",
          "import c from '~/utils/z';",
          "import d from '$lib/w';",
        ].join('\n'),
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.findings.length, 0);
      },
    );
  });

  test('JavaScript: a scoped package is still detected', async () => {
    await inProject(
      { 'package.json': '{"dependencies":{}}', 'a.js': "import x from '@scope/pkg/deep';" },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'undeclared'), ['@scope/pkg']);
      },
    );
  });

  test('Python: a URL requirement line is not a package named "git"', async () => {
    await inProject(
      {
        'requirements.txt': 'requests\ngit+https://github.com/acme/x.git@main\n',
        'a.py': 'import requests\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'dead'), []);
      },
    );
  });
});

describe('manifest parsing', () => {
  test('Python: a multi-line dependencies array in pyproject.toml is read', async () => {
    await inProject(
      {
        'pyproject.toml':
          '[project]\nname = "demo"\ndependencies = [\n  "requests>=2.28",\n  "flask",  # a comment\n]\n',
        'a.py': 'import requests\nimport flask\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.deepEqual(names(result, 'undeclared'), []);
      },
    );
  });

  test('a manifest that exists but does not parse is reported, not ignored', async () => {
    await inProject(
      { 'package.json': '{ not json at all', 'a.js': "import x from 'foo';" },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /package\.json exists but could not be parsed/);
      },
    );
  });
});

describe('install-tree evidence', () => {
  test('Python: a package in a virtualenv is a phantom, not a ghost', async () => {
    await inProject(
      {
        'a.py': 'import requests\n',
        '.venv/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA': 'Name: requests\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
        assert.deepEqual(names(result, 'phantom'), ['requests']);
      },
    );
  });

  test('Python: a distribution name is matched case- and underscore-insensitively', async () => {
    await inProject(
      {
        'a.py': 'import yaml\n',
        '.venv/lib/python3.12/site-packages/PyYAML-6.0.dist-info/METADATA': 'Name: PyYAML\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'phantom'), ['PyYAML']);
      },
    );
  });
});

describe('tier 3 restraint', () => {
  test('Java: a Maven coordinate is never reported as dead', async () => {
    await inProject(
      {
        'pom.xml':
          '<project><dependencies><dependency><groupId>org.apache.commons</groupId>' +
          '<artifactId>commons-lang3</artifactId></dependency></dependencies></project>',
        'Main.java': 'import org.apache.commons.lang3.StringUtils;\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.findings.length, 0);
      },
    );
  });

  test('Java: platform namespaces are not counted as dependencies', async () => {
    await inProject(
      { 'pom.xml': '<project></project>', 'Main.java': 'import java.util.List;\n' },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.languages[0].importCount, 0);
      },
    );
  });
});

describe('analysis targets', () => {
  test('a single file is judged against its project manifest', async () => {
    await inProject(
      {
        'package.json': '{"dependencies":{"react":"^18"}}',
        'src/deep/a.js': "import react from 'react';\nimport x from 'not-declared';",
      },
      async (dir) => {
        const result = await analyze(join(dir, 'src/deep/a.js'));
        assert.equal(result.filesScanned, 1);
        assert.deepEqual(names(result, 'undeclared'), ['not-declared']);
      },
    );
  });

  test('a single file never claims a declared package is dead', async () => {
    await inProject(
      {
        'package.json': '{"dependencies":{"react":"^18"}}',
        'a.js': "const x = 1;",
      },
      async (dir) => {
        const result = await analyze(join(dir, 'a.js'));
        assert.deepEqual(names(result, 'dead'), []);
      },
    );
  });

  test('a path that does not exist is an error, not an empty clean report', async () => {
    await assert.rejects(() => analyze('/definitely/not/a/real/path'), /does not exist/);
  });
});

describe('a project is not its own dependency', () => {
  test('Rust: a bin target importing its own crate is not a ghost', async () => {
    // Found against a real repo: src/bin/x.rs importing the library crate by
    // its [package] name is the standard bin+lib layout.
    await inProject(
      {
        'Cargo.toml': '[package]\nname = "croniter-core"\n\n[dependencies]\n',
        'src/lib.rs': 'pub mod api {}\n',
        'src/bin/croniter.rs': 'use croniter_core::api::Thing;\nfn main() {}\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(names(result, 'ghost'), []);
      },
    );
  });

  test('JavaScript: a package importing itself by name is not a ghost', async () => {
    await inProject(
      {
        'package.json': '{"name":"mypkg","exports":{"./x":"./x.js"},"dependencies":{}}',
        'a.js': "import x from 'mypkg/x';",
        'x.js': 'export default 1;',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.findings.length, 0);
      },
    );
  });
});

describe('nested projects are reported, not silently dropped', () => {
  test('a monorepo root names the packages it did not descend into', async () => {
    await inProject(
      {
        'package.json': '{"dependencies":{}}',
        'client/package.json': '{"dependencies":{}}',
        'client/a.js': "import x from 'inner';",
        'server/package.json': '{"dependencies":{}}',
        'server/b.js': "import y from 'other';",
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(result.skippedProjects, ['client', 'server']);
        assert.equal(result.filesScanned, 0);
        assert.equal(result.findings.length, 0);
      },
    );
  });
});

describe('packages a build tool loads are not reported as simply unused', () => {
  test('react-dom is annotated rather than called dead weight', async () => {
    await inProject(
      { 'package.json': '{"dependencies":{"react-dom":"^18"}}', 'a.js': 'const x = 1;' },
      async (dir) => {
        const result = await analyze(dir);
        const dead = result.findings.find((f) => f.type === 'dead' && f.name === 'react-dom');
        assert.ok(dead, 'still reported, because it is genuinely not imported');
        assert.equal(dead.expected, true);
        assert.match(dead.detail, /loaded by your framework/);
      },
    );
  });

  test('an ordinary unused package keeps the plain wording', async () => {
    await inProject(
      { 'package.json': '{"dependencies":{"left-pad":"^1"}}', 'a.js': 'const x = 1;' },
      async (dir) => {
        const result = await analyze(dir);
        const dead = result.findings.find((f) => f.type === 'dead' && f.name === 'left-pad');
        assert.equal(dead.expected, false);
        assert.match(dead.detail, /no import of it was found/);
      },
    );
  });
});
