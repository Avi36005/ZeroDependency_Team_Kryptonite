// Suppression rules.
//
// The property that matters most here is that suppression is never silent.
// A tool that quietly drops findings is worse than one that reports too many,
// because nobody can audit what they cannot see - so the count is asserted
// alongside the filtering.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIgnoreRules, isSuppressed, applyIgnoreRules } from '../src/ignore.mjs';
import { analyze } from '../src/core.mjs';

const finding = (type, name) => ({ type, name });

async function inProject(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'depx-ignore-'));
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

describe('rule parsing', () => {
  test('ignores comments, blank lines and trailing comments', () => {
    const rules = parseIgnoreRules('# a note\n\nleft-pad  # why\n');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].source, 'left-pad');
  });

  test('a bare name matches every finding type', () => {
    const rules = parseIgnoreRules('left-pad\n');
    assert.ok(isSuppressed(rules, finding('dead', 'left-pad')));
    assert.ok(isSuppressed(rules, finding('ghost', 'left-pad')));
  });

  test('a typed rule matches only that type', () => {
    const rules = parseIgnoreRules('dead:react-dom\n');
    assert.ok(isSuppressed(rules, finding('dead', 'react-dom')));
    assert.ok(!isSuppressed(rules, finding('ghost', 'react-dom')));
  });

  test('an unknown prefix is treated as part of the name, not a type', () => {
    // A package name may legitimately contain a colon; only the six real
    // finding types turn a prefix into a type selector.
    const rules = parseIgnoreRules('weird:name\n');
    assert.equal(rules[0].type, null);
    assert.ok(isSuppressed(rules, finding('dead', 'weird:name')));
  });

  test('a scoped package name survives intact', () => {
    const rules = parseIgnoreRules('@acme/thing\n');
    assert.ok(isSuppressed(rules, finding('undeclared', '@acme/thing')));
    assert.ok(!isSuppressed(rules, finding('undeclared', '@other/thing')));
  });

  test('* and ? glob, and nothing else is special', () => {
    const rules = parseIgnoreRules('@acme/*\n');
    assert.ok(isSuppressed(rules, finding('undeclared', '@acme/one')));
    assert.ok(!isSuppressed(rules, finding('undeclared', '@acmex/one')));

    // A dot in a name is a literal dot, not "any character".
    const dotted = parseIgnoreRules('github.com/a/b\n');
    assert.ok(isSuppressed(dotted, finding('ghost', 'github.com/a/b')));
    assert.ok(!isSuppressed(dotted, finding('ghost', 'githubXcom/a/b')));
  });

  test('matching is anchored at both ends', () => {
    const rules = parseIgnoreRules('pad\n');
    assert.ok(!isSuppressed(rules, finding('dead', 'left-pad')));
  });
});

describe('partitioning', () => {
  test('keeps what no rule names, and reports what it removed', () => {
    const rules = parseIgnoreRules('dead:react-dom\n');
    const { kept, suppressed } = applyIgnoreRules(rules, [
      finding('dead', 'react-dom'),
      finding('dead', 'left-pad'),
    ]);
    assert.deepEqual(kept.map((f) => f.name), ['left-pad']);
    assert.deepEqual(suppressed.map((f) => f.name), ['react-dom']);
  });

  test('no rules means no work and no copying', () => {
    const findings = [finding('dead', 'x')];
    const { kept, suppressed } = applyIgnoreRules([], findings);
    assert.equal(kept, findings);
    assert.equal(suppressed.length, 0);
  });
});

describe('end to end', () => {
  test('a suppressed ghost stops failing the build but is still counted', async () => {
    await inProject(
      {
        'go.mod': 'module ex.com/a\ngo 1.23\n',
        'a.go': 'package main\nimport "github.com/known/false-positive"\n',
        '.depxignore': '# a vendored plugin resolved by our build step\nghost:github.com/known/false-positive\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.deepEqual(result.findings, []);
        assert.equal(result.suppressed.length, 1);
        assert.equal(result.suppressed[0].name, 'github.com/known/false-positive');
      },
    );
  });

  test('an absent .depxignore suppresses nothing', async () => {
    await inProject(
      {
        'go.mod': 'module ex.com/a\ngo 1.23\n',
        'a.go': 'package main\nimport "github.com/no/such"\n',
      },
      async (dir) => {
        const result = await analyze(dir);
        assert.equal(result.findings.length, 1);
        assert.equal(result.suppressed.length, 0);
      },
    );
  });
});
