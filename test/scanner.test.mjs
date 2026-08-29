import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import js from '../src/lang/javascript.mjs';
import py from '../src/lang/python.mjs';
import go from '../src/lang/go.mjs';
import rust from '../src/lang/rust.mjs';
import ruby from '../src/lang/ruby.mjs';

const specifiers = (lang, src) => lang.scanImports(src).map((i) => i.specifier);

describe('JavaScript scanner', () => {
  test('finds every import form', () => {
    const src = [
      "import a from 'esm-default';",
      "import { b } from 'esm-named';",
      "import 'side-effect';",
      "const c = require('cjs');",
      "const d = await import('dynamic');",
      "export { e } from 'reexport';",
      "export * from 'star-reexport';",
      "import type { F } from 'ts-type-only';",
    ].join('\n');
    assert.deepEqual(specifiers(js, src), [
      'esm-default', 'esm-named', 'side-effect', 'cjs',
      'dynamic', 'reexport', 'star-reexport', 'ts-type-only',
    ]);
  });

  test('ignores imports inside comments', () => {
    const src = "// import 'line';\n/* import 'block'; */\n/**\n * require('doc')\n */\nimport x from 'real';";
    assert.deepEqual(specifiers(js, src), ['real']);
  });

  test('ignores imports inside string and template literals', () => {
    const src = [
      `const a = "require('in-double')";`,
      `const b = 'require("in-single")';`,
      'const c = `require(${x}) import "in-template"`;',
      "import real from 'real';",
    ].join('\n');
    assert.deepEqual(specifiers(js, src), ['real']);
  });

  test('ignores imports inside a regex literal', () => {
    const src = "const re = /require\\('in-regex'\\)/g;\nimport real from 'real';";
    assert.deepEqual(specifiers(js, src), ['real']);
  });

  test('does not mistake division for a regex', () => {
    const src = "const ratio = a / b / c;\nimport real from 'real';";
    assert.deepEqual(specifiers(js, src), ['real']);
  });

  test('survives an unterminated string without swallowing the file', () => {
    const src = "const broken = 'oops\nimport real from 'real';";
    assert.ok(specifiers(js, src).includes('real'));
  });

  test('reports 1-based line and column', () => {
    const found = js.scanImports("\n\nimport x from 'pkg';");
    assert.equal(found[0].line, 3);
    assert.equal(found[0].column, 15, "column points at the opening quote");
  });

  test('normalises scoped and deep specifiers', () => {
    assert.equal(js.normalize('@scope/pkg/deep/path'), '@scope/pkg');
    assert.equal(js.normalize('lodash/fp'), 'lodash');
    assert.equal(js.normalize('node:fs/promises'), null);
    assert.equal(js.normalize('fs'), null);
    assert.equal(js.normalize('./local'), null);
    assert.equal(js.normalize('https://esm.sh/x'), null);
  });
});

describe('Python scanner', () => {
  test('finds import and from-import forms', () => {
    const src = 'import os\nimport numpy as np\nfrom sklearn.metrics import x\nimport a, b\n';
    assert.deepEqual(specifiers(py, src), ['sklearn.metrics', 'os', 'numpy', 'a', 'b']);
  });

  test('ignores hash comments and triple-quoted strings', () => {
    const src = '# import fake_a\n"""\nimport fake_b\n"""\nimport real\n';
    assert.deepEqual(specifiers(py, src), ['real']);
  });

  test('maps import names to distribution names', () => {
    assert.equal(py.normalize('yaml'), 'PyYAML');
    assert.equal(py.normalize('sklearn.metrics'), 'scikit-learn');
    assert.equal(py.normalize('cv2'), 'opencv-python');
    assert.equal(py.normalize('os.path'), null, 'stdlib resolves to nothing');
    assert.equal(py.normalize('.relative'), null);
  });
});

describe('Go scanner', () => {
  test('reads grouped and single import forms', () => {
    const src = 'package main\n\nimport "single"\n\nimport (\n\t"fmt"\n\talias "github.com/a/b"\n\t_ "github.com/c/d"\n)\n';
    assert.deepEqual(specifiers(go, src).sort(), ['fmt', 'github.com/a/b', 'github.com/c/d', 'single'].sort());
  });

  test('treats a dotless first segment as standard library', () => {
    assert.equal(go.normalize('net/http'), null);
    assert.equal(go.normalize('fmt'), null);
    assert.equal(go.normalize('github.com/a/b'), 'github.com/a/b');
  });

  test('trims deep package paths to module granularity', () => {
    assert.equal(go.normalize('github.com/a/b/internal/c'), 'github.com/a/b');
  });

  test('ignores raw string literals and comments', () => {
    const src = 'package main\n// import "commented"\nvar q = `import "raw"`\nimport "real"\n';
    assert.deepEqual(specifiers(go, src), ['real']);
  });
});

describe('Rust scanner', () => {
  test('finds use and extern crate', () => {
    const src = 'use serde_json::Value;\nuse std::fs;\nextern crate libc;\nuse crate::internal;\n';
    const names = specifiers(rust, src);
    assert.ok(names.includes('serde_json'));
    assert.ok(names.includes('libc'));
    assert.equal(rust.normalize('serde_json'), 'serde-json');
    assert.equal(rust.normalize('std'), null);
    assert.equal(rust.normalize('crate'), null);
  });
});

describe('Ruby scanner', () => {
  test('finds require and skips stdlib', () => {
    const src = "require 'nokogiri'\nrequire 'json'\n# require 'commented'\n";
    assert.deepEqual(specifiers(ruby, src), ['nokogiri', 'json']);
    assert.equal(ruby.normalize('json'), null);
    assert.equal(ruby.normalize('nokogiri'), 'nokogiri');
  });
});
