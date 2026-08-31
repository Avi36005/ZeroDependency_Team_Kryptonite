// Terminal output: colour, width-aware padding and the report layout.
//
// HEADINGS and ORDER are exported because src/tui.mjs renders the same
// findings interactively; one table means the two interfaces cannot drift.
//
// Replaces: `chalk`, `picocolors`, `string-width`, `cli-table3`, `boxen`.
// Colour comes from util.styleText, which already consults NO_COLOR and
// whether the stream is a TTY, so we do not reimplement that policy.

import { styleText } from 'node:util';

let enabled = true;

export function setColor(on) {
  enabled = on;
}

function paint(styles, text) {
  if (!enabled) return text;
  return styleText(styles, text, { validateStream: false });
}

export const c = {
  dim: (s) => paint('dim', s),
  bold: (s) => paint('bold', s),
  red: (s) => paint('red', s),
  yellow: (s) => paint('yellow', s),
  green: (s) => paint('green', s),
  cyan: (s) => paint('cyan', s),
  magenta: (s) => paint('magenta', s),
  inverse: (s) => paint('inverse', s),
};

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Display width of a string, ignoring ANSI escapes and counting East Asian
 * wide characters and emoji as two columns. This is the whole of what
 * `string-width` does for our purposes.
 */
export function displayWidth(text) {
  const plain = text.replace(ANSI_PATTERN, '');
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue; // control
    if (code >= 0x0300 && code <= 0x036f) continue; // combining mark
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

export function pad(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** Render aligned columns without a table library. */
export function columns(rows, gutter = 2) {
  if (rows.length === 0) return [];
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(String(cell)));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? String(cell) : pad(String(cell), widths[i])))
      .join(' '.repeat(gutter))
      .trimEnd(),
  );
}

export const HEADINGS = {
  // "Resolves to nothing here" is what the evidence supports. Proving a name
  // does not exist anywhere would need a registry index we deliberately do
  // not ship, so the label claims non-resolution, not non-existence.
  ghost: { label: 'GHOSTS', blurb: 'imported, but nothing here provides them', paint: c.red },
  broken: { label: 'BROKEN', blurb: 'relative imports pointing at nothing', paint: c.red },
  phantom: { label: 'PHANTOM', blurb: 'imported and installed, never declared', paint: c.yellow },
  undeclared: { label: 'UNDECLARED', blurb: 'imported but not in the manifest - install tree absent, so unverified', paint: c.yellow },
  replaceable: { label: 'REPLACEABLE', blurb: 'the standard library already ships this', paint: c.cyan },
  dead: { label: 'DEAD', blurb: 'declared, never imported', paint: c.dim },
};

export const ORDER = ['ghost', 'broken', 'phantom', 'undeclared', 'replaceable', 'dead'];

export function renderReport(result, { only = null } = {}) {
  const out = [];
  const types = only ? [only] : ORDER;

  out.push('');
  out.push(
    '  ' +
      c.dim(
        `scanned ${result.filesScanned} files` +
          (result.filesSkipped ? ` (${result.filesSkipped} skipped)` : '') +
          ` in ${result.languages.length} language${result.languages.length === 1 ? '' : 's'}`,
      ),
  );

  for (const lang of result.languages) {
    const declared = lang.manifest ? lang.manifest.declared.size : 0;
    out.push(
      '  ' +
        c.dim(
          `${lang.lang.name}: ${lang.files.length} files, ${lang.importCount} imported packages, ` +
            (lang.manifest ? `${declared} declared` : 'no manifest found'),
        ) +
        (lang.lang.ghostCapable === false ? c.dim(`  [tier 3: ${lang.lang.reason}]`) : ''),
    );
  }
  for (const warning of result.warnings ?? []) {
    out.push('  ' + c.yellow('warning: ') + c.dim(warning));
  }

  // A nested project is skipped on purpose, but silence about it reads as a
  // broken scan - especially in a monorepo, where every package sits in a
  // subdirectory and the root scan legitimately finds nothing.
  const nested = result.skippedProjects ?? [];
  if (nested.length) {
    const shown = nested.slice(0, 6).join(', ');
    out.push(
      '  ' +
        c.dim(
          `${nested.length} nested project${nested.length === 1 ? '' : 's'} not descended into: ${shown}` +
            (nested.length > 6 ? `, +${nested.length - 6} more` : ''),
        ),
    );
    out.push('  ' + c.dim('each has its own manifest - run depx inside it to check it'));
  }
  out.push('');

  let shown = 0;
  for (const type of types) {
    let items = result.findings.filter((f) => f.type === type);
    if (items.length === 0) continue;
    shown += items.length;

    // Packages a framework or build tool loads are unimported by design, so
    // they sink below the ones that are actually worth deleting.
    if (type === 'dead') {
      items = [...items].sort((a, b) => Number(a.expected ?? false) - Number(b.expected ?? false));
    }

    const head = HEADINGS[type];
    out.push('  ' + head.paint(c.bold(head.label)) + '  ' + c.dim(head.blurb));

    const rows = [];
    for (const f of items.slice(0, 40)) {
      const site = f.sites[0];
      const where = site ? c.dim(`${site.file}:${site.line}:${site.column}`) : c.dim('-');
      const extra =
        type === 'replaceable'
          ? c.green('-> ' + f.detail) + c.dim(`  (${f.since})`)
          : type === 'dead'
            ? c.dim(f.detail)
            : where;
      rows.push(['    ' + head.paint(f.name), extra]);
      if (type === 'replaceable' && f.note) rows.push(['', c.dim('      ' + f.note)]);
      if ((type === 'ghost' || type === 'phantom' || type === 'undeclared') && f.sites.length > 1) {
        rows.push(['', c.dim(`      +${f.sites.length - 1} more site${f.sites.length === 2 ? '' : 's'}`)]);
      }
    }
    out.push(...columns(rows));
    if (items.length > 40) out.push(c.dim(`    ...and ${items.length - 40} more`));
    out.push('');
  }

  if (shown === 0) {
    // "Clean" has to mean clean. A repository whose findings were all
    // suppressed is configured, not clean, and the line says which.
    const suppressedCount = (result.suppressed ?? []).length;
    out.push(
      '  ' +
        (result.filesScanned === 0
          ? c.yellow('no source files found here - nothing was analysed')
          : suppressedCount
            ? c.green('nothing to report outside .depxignore')
            : c.green('clean - every import resolves and nothing is unused')),
    );
    out.push('');
  }

  // A subcommand asked about one kind of finding, so the summary and the exit
  // code answer that question. Counting findings the user filtered out would
  // make `depx replace` fail a CI job over an unrelated ghost.
  const inScope = only ? result.findings.filter((f) => f.type === only) : result.findings;
  const ghosts = inScope.filter((f) => f.type === 'ghost').length;
  const broken = inScope.filter((f) => f.type === 'broken').length;

  // `broken`, `undeclared`, `replaceable` and `dead` read as their own plural.
  const PLURAL = { ghost: 'ghosts', phantom: 'phantoms' };
  const summary = ORDER.map((t) => {
    const n = inScope.filter((f) => f.type === t).length;
    return n ? `${n} ${n === 1 ? t : PLURAL[t] ?? t}` : null;
  })
    .filter(Boolean)
    .join(c.dim(' / '));

  const hidden = result.findings.length - inScope.length;

  out.push('  ' + (summary || c.dim('nothing to report')));

  // Suppression is always visible, even when the findings are not. A reader
  // has to be able to tell a clean repository from a well-configured one.
  const suppressed = result.suppressed ?? [];
  if (suppressed.length) {
    out.push(
      '  ' +
        c.dim(
          `${suppressed.length} finding${suppressed.length === 1 ? '' : 's'} suppressed by .depxignore`,
        ),
    );
  }
  if (hidden > 0) {
    out.push(
      '  ' + c.dim(`${hidden} finding${hidden === 1 ? '' : 's'} of other kinds - run 'depx check' to see them`),
    );
  }
  if (ghosts) {
    out.push('');
    out.push(
      '  ' + c.red('Nothing local provides these, so the build breaks on a clean checkout.'),
    );
    out.push(
      '  ' +
        c.dim(
          'Check each name against its registry before shipping: one that is not\n  there either is a hallucinated import, and that is the slopsquat window.',
        ),
    );
  }
  out.push('');

  return { text: out.join('\n'), exitCode: ghosts + broken > 0 ? 1 : 0 };
}

/**
 * The vendoring report on its own, outside the Zero Dependency rule check.
 * Same evidence, same refusal to call it a verdict.
 */
export function renderVendored(result) {
  const out = ['', '  ' + c.dim(`scanned ${result.filesScanned} source files`), ''];
  const vendored = result.vendored ?? [];

  if (vendored.length === 0) {
    out.push('  ' + c.green('no copied or generated source detected'));
    out.push('');
    return { text: out.join('\n'), exitCode: 0 };
  }

  out.push('  ' + c.yellow(c.bold('REVIEW')) + '  ' + c.dim('source that does not read as hand-written'));
  const rows = [];
  for (const suspect of vendored.slice(0, 20)) {
    rows.push(['    ' + c.yellow(suspect.file), c.dim(`:${suspect.signals[0].line}`)]);
    for (const signal of suspect.signals) rows.push(['', c.dim('      ' + signal.why)]);
  }
  out.push(...columns(rows));
  if (vendored.length > 20) out.push(c.dim(`    ...and ${vendored.length - 20} more files`));

  out.push('');
  out.push(
    '  ' +
      `${vendored.length} file${vendored.length === 1 ? '' : 's'} to review` +
      c.dim(' - signals, not proof: open them and decide'),
  );
  out.push('');
  return { text: out.join('\n'), exitCode: 0 };
}

export function renderZeroDep(result) {
  const out = ['', '  ' + c.bold('Zero Dependency rule check'), ''];
  const missing = result.missing ?? [];

  if (result.rows.length === 0 && missing.length === 0) {
    out.push('  ' + c.dim('no source files and no dependency manifest found here'));
    out.push('');
    return { text: out.join('\n'), exitCode: 1 };
  }

  const rows = result.rows.map((r) => [
    '  ' + (r.pass ? c.green('PASS') : c.red('FAIL')),
    r.manifest,
    r.pass
      ? c.dim('no runtime dependencies')
      : c.red(`${r.runtimeDeps} runtime dep${r.runtimeDeps === 1 ? '' : 's'}`),
    r.devDeps ? c.dim(`(${r.devDeps} dev)`) : '',
  ]);
  // A language with source but no manifest cannot be verified at a glance,
  // which is what the rule asks for - so it is a failure with a fix attached.
  for (const m of missing) {
    rows.push([
      '  ' + c.red('FAIL'),
      m.expected,
      c.red('missing'),
      c.dim(`${m.files} ${m.language} file${m.files === 1 ? '' : 's'} present`),
    ]);
  }
  out.push(...columns(rows));

  if (missing.length) {
    out.push('');
    for (const m of missing) {
      out.push(
        '    ' +
          c.dim(`add an empty ${m.expected} so the empty manifest is verifiable on sight`),
      );
    }
  }

  for (const r of result.rows.filter((x) => !x.pass)) {
    out.push('');
    out.push(
      '    ' +
        c.dim(r.manifest + ': ') +
        r.names.slice(0, 12).join(', ') +
        (r.names.length > 12 ? c.dim(` +${r.names.length - 12} more`) : ''),
    );
  }

  // The second half of the rule: source that was copied rather than written.
  // Reported as files to read, never as a verdict - the tool cannot know who
  // typed a line, and saying otherwise would be an accusation it cannot back.
  const vendored = result.vendored ?? [];
  if (vendored.length) {
    out.push('');
    out.push(
      '  ' + c.yellow(c.bold('REVIEW')) + '  ' + c.dim('source that does not read as hand-written'),
    );
    const rows = [];
    for (const suspect of vendored.slice(0, 10)) {
      rows.push(['    ' + c.yellow(suspect.file), c.dim(`:${suspect.signals[0].line}`)]);
      for (const signal of suspect.signals) rows.push(['', c.dim('      ' + signal.why)]);
    }
    out.push(...columns(rows));
    if (vendored.length > 10) out.push(c.dim(`    ...and ${vendored.length - 10} more files`));
    out.push('');
    out.push(
      '  ' +
        c.dim(
          'Signals, not proof. Vendored source must be disclosed in STDLIB.md;\n  undisclosed, it scores against you.',
        ),
    );
  }

  out.push('');
  out.push(
    '  ' +
      (result.pass
        ? vendored.length
          ? c.yellow(`empty manifest verified - ${vendored.length} file${vendored.length === 1 ? '' : 's'} to review`)
          : c.green('empty manifest verified, no vendored source detected')
        : c.red('this repository would not pass the rule')),
  );
  out.push('');
  return { text: out.join('\n'), exitCode: result.pass ? 0 : 1 };
}
