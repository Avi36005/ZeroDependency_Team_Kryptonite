import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, loadIgnoreFile } from '../src/walk.mjs';
import { displayWidth, columns } from '../src/report.mjs';

// loadIgnoreFile parses; isIgnored applies. Build rules through the real path.
async function rules(lines) {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'depx-'));
  await writeFile(join(dir, '.gitignore'), lines.join('\n'));
  return loadIgnoreFile(dir);
}

describe('gitignore matcher', () => {
  test('matches a bare name at any depth', async () => {
    const r = await rules(['secret.txt']);
    assert.equal(isIgnored(r, 'secret.txt', false), true);
    assert.equal(isIgnored(r, 'a/b/secret.txt', false), true);
    assert.equal(isIgnored(r, 'other.txt', false), false);
  });

  test('anchors a pattern containing a slash', async () => {
    const r = await rules(['build/out']);
    assert.equal(isIgnored(r, 'build/out', true), true);
    assert.equal(isIgnored(r, 'a/build/out', true), false);
  });

  test('applies a directory-only pattern only to directories', async () => {
    const r = await rules(['cache/']);
    assert.equal(isIgnored(r, 'cache', true), true);
    assert.equal(isIgnored(r, 'cache', false), false);
  });

  test('lets a later negation re-include a file, as git does', async () => {
    const r = await rules(['*.log', '!keep.log']);
    assert.equal(isIgnored(r, 'debug.log', false), true);
    assert.equal(isIgnored(r, 'keep.log', false), false);
  });

  test('supports a double-star wildcard', async () => {
    const r = await rules(['docs/**/draft.md']);
    assert.equal(isIgnored(r, 'docs/a/b/draft.md', false), true);
  });

  test('ignores blank lines and comments', async () => {
    const r = await rules(['', '# a comment', 'real']);
    assert.equal(r.length, 1);
    assert.equal(isIgnored(r, 'real', false), true);
  });
});

describe('display width', () => {
  test('ignores ANSI escapes', () => {
    assert.equal(displayWidth('\u001b[31mred\u001b[39m'), 3);
  });

  test('counts wide characters as two columns', () => {
    assert.equal(displayWidth('\u4f60\u597d'), 4);
  });

  test('aligns columns using display width, not string length', () => {
    const [first] = columns([['\u001b[31mab\u001b[39m', 'x'], ['abcd', 'y']]);
    assert.ok(first.endsWith('  x'), 'padding should account for the invisible escape');
  });
});
