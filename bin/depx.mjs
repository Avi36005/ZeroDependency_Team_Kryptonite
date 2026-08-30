#!/usr/bin/env node
// depx - dependency x-ray.
//
// Argument parsing is util.parseArgs (replaces `minimist`, `commander`,
// `yargs`). parseArgs handles strings and booleans; subcommand dispatch and
// the help text are ours, which is the whole reason the package exists.

import { parseArgs } from 'node:util';
import { analyze, verifyZeroDep } from '../src/core.mjs';
import { renderReport, renderZeroDep, setColor, columns, c } from '../src/report.mjs';
import { LANGUAGES } from '../src/lang/index.mjs';

const VERSION = '0.1.0';

const COMMANDS = {
  check: 'every finding: ghosts, broken, phantom, replaceable, dead (default)',
  ghosts: 'only imports nothing here resolves - the slopsquat candidates',
  phantom: 'only imports that are installed but never declared',
  dead: 'only declared packages that are never imported',
  replace: 'only packages the standard library already ships',
  'zero-dep': 'verify this repo against the Zero Dependency rule',
  langs: 'list supported languages and their detection tier',
};

function usage() {
  const rows = Object.entries(COMMANDS)
    .map(([name, blurb]) => `    ${name.padEnd(10)} ${c.dim(blurb)}`)
    .join('\n');

  return `
  ${c.bold('depx')} ${c.dim('- dependency x-ray, zero dependencies')}

  ${c.bold('USAGE')}
    depx [command] [path] [options]

  ${c.bold('COMMANDS')}
${rows}

  ${c.bold('OPTIONS')}
    --lang <ids>   restrict to a comma-separated list of language ids
    --json         emit machine-readable JSON instead of a report
    --no-color     disable colour (NO_COLOR is honoured automatically)
    --quiet        suppress the report; rely on the exit code
    --help, -h     show this help
    --version, -v  print the version

  ${c.bold('EXIT CODES')}
    0  clean
    1  findings that need attention (ghosts or broken imports)
    2  usage error

  ${c.bold('EXAMPLES')}
    depx                          ${c.dim('# check the current directory')}
    depx ghosts ./src             ${c.dim('# only hallucinated imports')}
    depx check . --lang go,rust   ${c.dim('# restrict languages')}
    depx zero-dep . --json        ${c.dim('# CI gate for the hackathon rule')}
`;
}

function fail(message) {
  process.stderr.write(`depx: ${message}\n`);
  process.stderr.write(`Try 'depx --help'.\n`);
  process.exit(2);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        lang: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    fail(error.message);
    return;
  }

  const { values, positionals } = parsed;

  // NO_COLOR is a de facto standard; util.styleText already respects it, and
  // we mirror it here so --json output is never contaminated either way.
  if (values['no-color'] || values.json || process.env.NO_COLOR) setColor(false);

  if (values.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let [command, path] = positionals;
  if (command && !(command in COMMANDS)) {
    // `depx ./some/path` - a bare path with no command means `check`.
    path = command;
    command = 'check';
  }
  command ??= 'check';
  path ??= '.';

  if (command === 'langs') {
    // columns() measures display width, so a name longer than the assumed
    // padding still lines up - padEnd would run the columns together.
    const rows = columns(
      LANGUAGES.map((l) => [
        '    ' + l.name,
        l.ghostCapable === false ? c.yellow('tier 3') : c.green(`tier ${l.tier}`),
        c.dim(l.ghostCapable === false ? l.reason : 'full ghost detection'),
      ]),
    ).join('\n');
    process.stdout.write(`\n  ${c.bold('SUPPORTED LANGUAGES')}\n${rows}\n\n`);
    return 0;
  }

  const include = values.lang
    ? values.lang.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  if (include) {
    const known = new Set(LANGUAGES.map((l) => l.id));
    const unknown = include.filter((id) => !known.has(id));
    if (unknown.length) fail(`unknown language id: ${unknown.join(', ')}`);
  }

  if (command === 'zero-dep') {
    const result = await verifyZeroDep(path);
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.pass ? 0 : 1;
    }
    const { text, exitCode } = renderZeroDep(result);
    if (!values.quiet) process.stdout.write(text);
    return exitCode;
  }

  const result = await analyze(path, { include });
  const only = { ghosts: 'ghost', phantom: 'phantom', dead: 'dead', replace: 'replaceable' }[command] ?? null;

  if (values.json) {
    process.stdout.write(JSON.stringify(toJson(result, only), null, 2) + '\n');
    // Same rule as the text report: the exit code answers the question the
    // subcommand asked, not one the user filtered out.
    const inScope = only ? result.findings.filter((f) => f.type === only) : result.findings;
    return inScope.some((f) => f.type === 'ghost' || f.type === 'broken') ? 1 : 0;
  }

  const { text, exitCode } = renderReport(result, { only });
  if (!values.quiet) process.stdout.write(text);
  return exitCode;
}

/**
 * Sets and adapter objects are not JSON-serialisable; flatten for --json.
 * `only` applies the same subcommand filter the text report uses, so
 * `depx ghosts --json` and `depx ghosts` describe the same findings.
 */
function toJson(result, only = null) {
  const findings = only ? result.findings.filter((f) => f.type === only) : result.findings;
  return {
    root: result.root,
    filesScanned: result.filesScanned,
    filesSkipped: result.filesSkipped,
    // Everything the text report can say has to be reachable from --json too,
    // or a CI consumer never learns why a result looked surprising.
    warnings: result.warnings ?? [],
    skippedProjects: result.skippedProjects ?? [],
    languages: result.languages.map((l) => ({
      id: l.lang.id,
      name: l.lang.name,
      tier: l.lang.tier,
      ghostCapable: l.lang.ghostCapable !== false,
      files: l.files.length,
      importedPackages: l.importCount,
      declared: l.manifest ? [...l.manifest.declared] : null,
    })),
    findings: findings.map((f) => ({
      type: f.type,
      language: f.language,
      name: f.name,
      detail: f.detail,
      since: f.since ?? null,
      note: f.note ?? null,
      // dead only: true when a framework or build tool is expected to load
      // this rather than your source importing it.
      expected: f.expected ?? false,
      sites: f.sites.map((s) => ({ file: s.file, line: s.line, column: s.column, kind: s.kind })),
    })),
  };
}

try {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;
} catch (error) {
  process.stderr.write(`depx: ${error.message}\n`);
  process.exitCode = 2;
}
