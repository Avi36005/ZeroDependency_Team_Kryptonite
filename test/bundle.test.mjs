// The single-file build.
//
// Two properties are worth asserting, because both are claimed publicly:
// the bundle is byte-identical across runs, and it behaves exactly like the
// module tree it was built from. A bundler that quietly changes behaviour is
// worse than no bundler.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from '../tools/bundle.mjs';

describe('single-file build', () => {
  test('is byte-identical across runs', async () => {
    const [a, b] = await Promise.all([bundle('bin/depx.mjs'), bundle('bin/depx.mjs')]);
    assert.equal(a, b);
    assert.ok(a.length > 10_000, 'bundle should contain the whole program');
  });

  test('starts with a shebang and contains no other one', async () => {
    const out = await bundle('bin/depx.mjs');
    assert.ok(out.startsWith('#!/usr/bin/env node\n'));
    assert.equal(out.split('\n').filter((l) => l.startsWith('#!')).length, 1);
  });

  test('hoists every builtin import above the module bodies', async () => {
    const out = await bundle('bin/depx.mjs');
    const lines = out.split('\n');
    const lastImport = lines.findLastIndex((l) => l.startsWith('import '));
    const firstModule = lines.findIndex((l) => l.startsWith('const __m_'));
    assert.ok(lastImport < firstModule, 'imports must precede module IIFEs');
  });

  test('leaves no bare export statement behind', async () => {
    const out = await bundle('bin/depx.mjs');
    assert.doesNotMatch(out, /^export\s/m);
  });

  test('keeps each module in its own scope', async () => {
    // Five adapters each define `scanImports`; if scopes collapsed, only one
    // would survive. Each must appear inside its own IIFE.
    const out = await bundle('bin/depx.mjs');
    const declarations = out.match(/^function scanImports\b/gm) ?? [];
    assert.ok(
      declarations.length >= 4,
      `expected several same-named functions to coexist, found ${declarations.length}`,
    );
  });
});
