// Terminal output: colour, width-aware padding and the report layout.
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

const HEADINGS = {
  ghost: { label: 'GHOSTS', blurb: 'imported, but no such package exists', paint: c.red },
  broken: { label: 'BROKEN', blurb: 'relative imports pointing at nothing', paint: c.red },
  phantom: { label: 'PHANTOM', blurb: 'imported and installed, never declared', paint: c.yellow },
  undeclared: { label: 'UNDECLARED', blurb: 'imported but not in the manifest - install tree absent, so unverified', paint: c.yellow },
  replaceable: { label: 'REPLACEABLE', blurb: 'the standard library already ships this', paint: c.cyan },
  dead: { label: 'DEAD', blurb: 'declared, never imported', paint: c.dim },
};

const ORDER = ['ghost', 'broken', 'phantom', 'undeclared', 'replaceable', 'dead'];

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
  out.push('');

  let shown = 0;
  for (const type of types) {
    const items = result.findings.filter((f) => f.type === type);
    if (items.length === 0) continue;
    shown += items.length;

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
    out.push('  ' + c.green('clean - every import resolves and nothing is unused'));
    out.push('');
  }

  const ghosts = result.findings.filter((f) => f.type === 'ghost').length;
  const broken = result.findings.filter((f) => f.type === 'broken').length;
  const summary = ORDER.map((t) => {
    const n = result.findings.filter((f) => f.type === t).length;
    return n ? `${n} ${t}${n === 1 ? '' : 's'}` : null;
  })
    .filter(Boolean)
    .join(c.dim(' / '));

  out.push('  ' + (summary || c.dim('nothing to report')));
  if (ghosts) {
    out.push('');
    out.push('  ' + c.red('These names are unclaimed today. That is the slopsquat window.'));
  }
  out.push('');

  return { text: out.join('\n'), exitCode: ghosts + broken > 0 ? 1 : 0 };
}

export function renderZeroDep(result) {
  const out = ['', '  ' + c.bold('Zero Dependency rule check'), ''];
  if (result.rows.length === 0) {
    out.push('  ' + c.dim('no dependency manifest found for any supported language'));
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
  out.push(...columns(rows));

  for (const r of result.rows.filter((x) => !x.pass)) {
    out.push('');
    out.push(
      '    ' +
        c.dim(r.manifest + ': ') +
        r.names.slice(0, 12).join(', ') +
        (r.names.length > 12 ? c.dim(` +${r.names.length - 12} more`) : ''),
    );
  }

  out.push('');
  out.push(
    '  ' +
      (result.pass
        ? c.green('empty manifest verified')
        : c.red('this repository would not pass the rule')),
  );
  out.push('');
  return { text: out.join('\n'), exitCode: result.pass ? 0 : 1 };
}
