// Suppression rules: `.depxignore`.
//
// Every auditing tool needs an escape hatch. Without one, a single
// intentional finding - a plugin loaded at runtime, a package a build step
// injects, an alias this tool cannot see - means the build is never green
// again, and the tool gets removed from CI rather than argued with.
//
// The rule this file follows is that suppression must never be silent. A
// hidden finding is worse than a reported one, because nobody can audit what
// they cannot see, so the count of what was suppressed is always reported
// even when the findings themselves are not.
//
// Format, one rule per line:
//
//   left-pad              suppress every finding for this package
//   dead:react-dom        suppress only that finding type for that package
//   undeclared:@acme/*    `*` and `?` glob within a name
//   # comment             ignored, as are blank lines
//
// Replaces: `ignore`, `minimatch`, and the config loaders (`cosmiconfig`,
// `rc`) a tool would normally install to read a dotfile.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FINDING_TYPES = new Set([
  'ghost',
  'broken',
  'phantom',
  'undeclared',
  'dead',
  'replaceable',
]);

/**
 * Translate one name pattern into a RegExp. Only `*` and `?` are special;
 * everything else - including the `.`, `-`, `@` and `/` that fill real
 * package names - is matched literally.
 */
function nameToRegExp(pattern) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * @typedef {{ type: string|null, regexp: RegExp, source: string }} IgnoreRule
 */

/** Parse `.depxignore` text into rules. Exported for testing. */
export function parseIgnoreRules(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;

    // `type:name`, but only where the prefix is a finding type we know -
    // a scoped package like `@acme/x` has no colon, and a name that happens
    // to contain one is treated as a name rather than silently dropped.
    const colon = line.indexOf(':');
    const prefix = colon === -1 ? null : line.slice(0, colon);
    const isTyped = prefix !== null && FINDING_TYPES.has(prefix);

    rules.push({
      type: isTyped ? prefix : null,
      regexp: nameToRegExp(isTyped ? line.slice(colon + 1).trim() : line),
      source: line,
    });
  }
  return rules;
}

/** Read `.depxignore` from a project root. Absent file means no rules. */
export async function loadIgnoreRules(root) {
  try {
    return parseIgnoreRules(await readFile(join(root, '.depxignore'), 'utf8'));
  } catch {
    return [];
  }
}

/** True when any rule suppresses this finding. */
export function isSuppressed(rules, finding) {
  return rules.some(
    (rule) =>
      (rule.type === null || rule.type === finding.type) && rule.regexp.test(finding.name),
  );
}

/**
 * Partition findings into those that survive and those a rule suppressed.
 *
 * @returns {{ kept: Array, suppressed: Array }}
 */
export function applyIgnoreRules(rules, findings) {
  if (rules.length === 0) return { kept: findings, suppressed: [] };
  const kept = [];
  const suppressed = [];
  for (const finding of findings) {
    (isSuppressed(rules, finding) ? suppressed : kept).push(finding);
  }
  return { kept, suppressed };
}
