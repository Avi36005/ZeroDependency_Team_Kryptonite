import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/toml.mjs';

describe('TOML reader', () => {
  test('reads tables and string values', () => {
    const t = parseToml('[package]\nname = "depx"\nversion = "0.1.0"\n');
    assert.deepEqual(t.package, { name: 'depx', version: '0.1.0' });
  });

  test('reads inline tables and arrays', () => {
    const t = parseToml('[dependencies]\ntokio = { version = "1", features = ["full", "macros"] }\n');
    assert.equal(t.dependencies.tokio.version, '1');
    assert.deepEqual(t.dependencies.tokio.features, ['full', 'macros']);
  });

  test('ignores comments but not hashes inside strings', () => {
    const t = parseToml('a = "not # a comment"  # this is\nb = 1\n');
    assert.equal(t.a, 'not # a comment');
    assert.equal(t.b, 1);
  });

  test('handles nested and quoted table headers', () => {
    const t = parseToml('[tool.poetry.dependencies]\nrequests = "^2.0"\n');
    assert.equal(t.tool.poetry.dependencies.requests, '^2.0');
  });

  test('does not split on an equals sign inside a string', () => {
    const t = parseToml('key = "a=b=c"\n');
    assert.equal(t.key, 'a=b=c');
  });

  test('reads booleans and numbers', () => {
    const t = parseToml('on = true\noff = false\nn = 42\nbig = 1_000\n');
    assert.equal(t.on, true);
    assert.equal(t.off, false);
    assert.equal(t.n, 42);
    assert.equal(t.big, 1000);
  });
});
