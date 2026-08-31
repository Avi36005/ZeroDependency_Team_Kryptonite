// The interactive interface, driven without a terminal.
//
// src/tui.mjs keeps its state machine and its frame renderer as pure
// functions of (state, size) precisely so this suite can exist: every key the
// interface responds to is exercised here through reduce(), and every frame
// is asserted on as a string. Only runTui() needs a TTY, and the one thing
// worth checking about it - that it refuses to run without one - is an
// end-to-end case at the bottom.

import { describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setColor, displayWidth } from '../src/report.mjs';
import {
  runTui,
  createState,
  matchesIn,
  totalMatches,
  reduce,
  visible,
  selected,
  renderFrame,
  editorCommand,
  fit,
  wrap,
  centre,
} from '../src/tui.mjs';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

setColor(false); // assert on layout, not on escape sequences

/** A result shaped like core.mjs produces, with the findings a test needs. */
function result(findings, extra = {}) {
  return {
    root: '/tmp/demo',
    filesScanned: 4,
    filesSkipped: 0,
    languages: [{ lang: { name: 'JavaScript / TypeScript' }, files: [], importCount: 0, manifest: null }],
    warnings: [],
    skippedProjects: [],
    suppressed: [],
    findings,
    ...extra,
  };
}

const site = (file, line = 1, column = 1) => ({ file, line, column, kind: 'import' });

function finding(type, name, over = {}) {
  return { type, name, language: 'js', detail: `${name} detail`, sites: [site('src/app.js')], ...over };
}

const SAMPLE = result([
  finding('ghost', 'async-retry-utils'),
  finding('ghost', 'json-schema-validator-pro'),
  finding('dead', 'moment'),
  finding('replaceable', 'chalk', { detail: 'util.styleText()', since: 'node 20.12', note: 'honours NO_COLOR' }),
]);

/** Feed a sequence of keys through the reducer, ignoring the actions. */
function press(state, ...keys) {
  for (const key of keys) ({ state } = reduce(state, typeof key === 'string' ? { name: key, sequence: key } : key));
  return state;
}

describe('tui state', () => {
  test('groups findings in the report order and drops empty kinds', () => {
    const state = createState(SAMPLE);
    assert.deepEqual(state.groups.map((g) => g.type), ['ghost', 'replaceable', 'dead']);
    assert.equal(state.groups[0].items.length, 2);
  });

  test('a clean result has no groups to navigate', () => {
    assert.deepEqual(createState(result([])).groups, []);
  });

  test('up and down clamp instead of wrapping', () => {
    const state = createState(SAMPLE);
    assert.equal(press(state, 'up', 'up').item, 0);
    assert.equal(press(state, 'down', 'down', 'down', 'down').item, 1); // 2 ghosts
  });

  test('categories wrap in both directions and reset the row', () => {
    const at = (s) => s.groups[s.cat].type;
    const start = createState(SAMPLE);

    let state = press(start, 'down');
    assert.equal(state.item, 1);
    state = press(state, 'right');
    assert.equal(at(state), 'replaceable');
    assert.equal(state.item, 0, 'moving category resets the selected row');

    // three categories, so three steps in either direction come back round
    assert.equal(at(press(start, 'right', 'right', 'right')), 'ghost');
    assert.equal(at(press(start, 'left')), 'dead', 'left from the first wraps to the last');
    assert.equal(at(press(start, 'left', 'left', 'left')), 'ghost');
  });

  test('vim keys move as the arrows do', () => {
    const arrows = press(createState(SAMPLE), 'down', 'right');
    const vim = press(createState(SAMPLE), { name: 'j', sequence: 'j' }, { name: 'l', sequence: 'l' });
    assert.equal(vim.cat, arrows.cat);
    assert.equal(vim.item, arrows.item);
  });

  test('g and G jump to the ends', () => {
    const state = createState(SAMPLE);
    assert.equal(press(state, { name: 'G', sequence: 'G' }).item, 1);
    assert.equal(press(state, { name: 'G', sequence: 'G' }, { name: 'g', sequence: 'g' }).item, 0);
  });

  test('q quits, and so does ctrl-c', () => {
    assert.equal(reduce(createState(SAMPLE), { name: 'q', sequence: 'q' }).action, 'quit');
    assert.equal(reduce(createState(SAMPLE), { name: 'c', ctrl: true }).action, 'quit');
  });

  test('enter opens the selection, and does nothing when there is none', () => {
    assert.equal(reduce(createState(SAMPLE), { name: 'return' }).action, 'open');
    assert.equal(reduce(createState(result([])), { name: 'return' }).action, null);
  });
});

describe('tui filter', () => {
  test('typing narrows the list, case-insensitively', () => {
    let state = press(createState(SAMPLE), { sequence: '/' });
    assert.equal(state.mode, 'filter');
    for (const ch of 'JSON') state = press(state, { sequence: ch });
    assert.deepEqual(visible(state).map((f) => f.name), ['json-schema-validator-pro']);
  });

  test('backspace removes the last character', () => {
    let state = press(createState(SAMPLE), { sequence: '/' });
    for (const ch of 'jsonx') state = press(state, { sequence: ch });
    assert.equal(visible(state).length, 0);
    state = press(state, { name: 'backspace' });
    assert.equal(visible(state).length, 1);
  });

  test('enter keeps the filter, escape abandons it', () => {
    let state = press(createState(SAMPLE), { sequence: '/' }, { sequence: 'j' });
    assert.equal(press(state, 'return').filter, 'j');
    assert.equal(press(state, 'return').mode, 'nav');
    assert.equal(press(state, 'escape').filter, '');
  });

  test('escape in the list clears a filter before it quits', () => {
    const filtered = press(createState(SAMPLE), { sequence: '/' }, { sequence: 'j' }, 'return');
    const cleared = reduce(filtered, { name: 'escape' });
    assert.equal(cleared.action, null, 'the first escape only clears');
    assert.equal(cleared.state.filter, '');
    assert.equal(reduce(cleared.state, { name: 'escape' }).action, 'quit');
  });

  test('the selection stays inside the narrowed list', () => {
    let state = press(createState(SAMPLE), 'down');
    state = press(state, { sequence: '/' }, { sequence: 'a' }, 'return');
    assert.equal(state.item, 0);
    assert.ok(selected(state));
  });
});

describe('tui search', () => {
  // The four SAMPLE findings span three categories. "a" hits two of them:
  // async-retry-utils and json-schema-validator-pro (ghost) and chalk
  // (replaceable). "moment" has no 'a' in it, so dead matches nothing.
  const search = (state, text) =>
    press(createState(state), { sequence: '/' }, ...[...text].map((ch) => ({ sequence: ch })));

  test('the filter applies to every category, not just the open one', () => {
    const state = search(SAMPLE, 'a');
    assert.equal(matchesIn(state, 0).length, 2, 'ghosts');
    assert.equal(matchesIn(state, 1).length, 1, 'replaceable');
    assert.equal(matchesIn(state, 2).length, 0, 'dead');
    assert.equal(totalMatches(state), 3);
  });

  test('typing jumps to wherever the match is', () => {
    // "chalk" is a replaceable; the search starts on ghosts and has to move.
    const state = search(SAMPLE, 'chalk');
    assert.equal(state.groups[state.cat].type, 'replaceable');
    assert.equal(selected(state).name, 'chalk');
  });

  test('a search that matches nothing leaves you where you were', () => {
    const state = search(SAMPLE, 'zzzz');
    assert.equal(totalMatches(state), 0);
    assert.equal(state.groups[state.cat].type, 'ghost');
    assert.equal(selected(state), null);
  });

  test('arrows skip the categories a search emptied', () => {
    // "moment" is only in dead, so left and right both stay put.
    const state = press(search(SAMPLE, 'moment'), 'return');
    assert.equal(state.groups[state.cat].type, 'dead');
    assert.equal(press(state, 'right').groups[press(state, 'right').cat].type, 'dead');
    assert.equal(press(state, 'left').groups[press(state, 'left').cat].type, 'dead');
  });

  test('arrows visit every category once the search is cleared', () => {
    // the search left us on dead; clearing it puts the other two back in reach
    const cleared = press(search(SAMPLE, 'moment'), 'escape');
    assert.equal(cleared.filter, '');
    const at = (s) => s.groups[s.cat].type;
    assert.equal(at(cleared), 'dead');
    assert.equal(at(press(cleared, 'right')), 'ghost');
    assert.equal(at(press(cleared, 'right', 'right')), 'replaceable');
    assert.equal(at(press(cleared, 'right', 'right', 'right')), 'dead');
  });

  test('each category shows its own share of the matches', () => {
    const frame = renderFrame(search(SAMPLE, 'a'), { cols: 90, rows: 20 }).join('\n');
    assert.match(frame, /GHOSTS \(2\/2\)/);
    assert.match(frame, /REPLACEABLE \(1\/1\)/);
    assert.match(frame, /DEAD \(0\/1\)/);
  });

  test('a category with no matches says 0 rather than hiding', () => {
    const frame = renderFrame(search(SAMPLE, 'chalk'), { cols: 90, rows: 20 }).join('\n');
    assert.match(frame, /GHOSTS \(0\/2\)/);
    assert.match(frame, /REPLACEABLE \(1\/1\)/);
  });

  test('the header counts the matches instead of the files', () => {
    const one = renderFrame(search(SAMPLE, 'chalk'), { cols: 90, rows: 20 }).join('\n');
    assert.match(one, /1 match for "chalk"/);
    const many = renderFrame(search(SAMPLE, 'a'), { cols: 90, rows: 20 }).join('\n');
    assert.match(many, /3 matches for "a"/);
    // and goes back to the file count when the search is cleared
    const cleared = renderFrame(press(search(SAMPLE, 'a'), 'escape'), { cols: 90, rows: 20 }).join('\n');
    assert.match(cleared, /4 files · 1 lang/);
  });
});

describe('tui frame', () => {
  const sizes = [
    [60, 12],
    [78, 20],
    [130, 50],
    [200, 24],
  ];

  test('every frame is exactly the size it was asked for', () => {
    for (const [cols, rows] of sizes) {
      const frame = renderFrame(createState(SAMPLE), { cols, rows });
      assert.equal(frame.length, rows, `${cols}x${rows} row count`);
      for (const [i, line] of frame.entries()) {
        assert.equal(displayWidth(line), cols, `${cols}x${rows} line ${i}: ${JSON.stringify(line)}`);
      }
    }
  });

  test('a frame stays exact while navigating and filtering', () => {
    let state = createState(SAMPLE);
    for (const key of ['down', 'right', 'down', 'left', { sequence: '/' }, { sequence: 'a' }]) {
      state = press(state, key);
      const frame = renderFrame(state, { cols: 90, rows: 24 });
      assert.equal(frame.length, 24);
      assert.ok(frame.every((l) => displayWidth(l) === 90));
    }
  });

  test('the selected row is marked without relying on colour', () => {
    const frame = renderFrame(createState(SAMPLE), { cols: 78, rows: 20 }).join('\n');
    assert.match(frame, /› async-retry-utils/);
    assert.match(frame, /▸ GHOSTS \(2\)/);
    assert.doesNotMatch(frame, /› json-schema/);
  });

  test('the header names the directory and what was scanned', () => {
    const frame = renderFrame(createState(SAMPLE), { cols: 78, rows: 20 }).join('\n');
    assert.match(frame, /depx · demo/);
    assert.match(frame, /4 files · 1 lang\b/);
  });

  test('the detail strip explains the selected finding', () => {
    const ghost = renderFrame(createState(SAMPLE), { cols: 100, rows: 20 }).join('\n');
    assert.match(ghost, /slopsquat window/);

    // replaceable carries its own substitution rather than a generic blurb
    const state = press(createState(SAMPLE), 'right');
    const frame = renderFrame(state, { cols: 100, rows: 20 }).join('\n');
    assert.match(frame, /-> util\.styleText\(\)/);
    assert.match(frame, /node 20\.12/);
  });

  test('a finding with several sites says how many', () => {
    const many = result([
      finding('ghost', 'everywhere', { sites: [site('a.js', 1), site('b.js', 2), site('c.js', 3)] }),
    ]);
    assert.match(renderFrame(createState(many), { cols: 100, rows: 20 }).join('\n'), /3 sites:/);
  });

  test('a clean repository gets a composed panel, not a blank screen', () => {
    const frame = renderFrame(createState(result([])), { cols: 78, rows: 20 });
    const text = frame.join('\n');
    assert.match(text, /✓  clean/);
    assert.match(text, /every import resolves, and nothing is unused/);
    assert.match(text, /4 files scanned across 1 language/);
    // the thing this panel exists to prevent
    const blank = frame.filter((l) => l.trim() === '').length;
    assert.ok(blank < frame.length - 4, `screen is mostly empty: ${blank}/${frame.length} rows blank`);
  });

  test('the three no-findings outcomes stay distinct', () => {
    const clean = renderFrame(createState(result([])), { cols: 78, rows: 20 }).join('\n');
    assert.match(clean, /✓  clean/);

    const suppressed = result([], { suppressed: [{ type: 'dead', name: 'left-pad' }] });
    const sframe = renderFrame(createState(suppressed), { cols: 78, rows: 20 }).join('\n');
    assert.match(sframe, /nothing outside \.depxignore/);
    assert.match(sframe, /every finding here is suppressed by \.depxignore \(1\)/);
    assert.doesNotMatch(sframe, /✓  clean/, 'configured is not the same as clean');

    const empty = result([], { filesScanned: 0, languages: [] });
    const eframe = renderFrame(createState(empty), { cols: 78, rows: 20 }).join('\n');
    assert.match(eframe, /nothing analysed/);
    assert.match(eframe, /no source files were found/);
  });

  test('the clean panel names the nested projects it skipped', () => {
    const nested = result([], { skippedProjects: ['client', 'server'] });
    const frame = renderFrame(createState(nested), { cols: 78, rows: 20 }).join('\n');
    assert.match(frame, /2 nested projects not descended into/);
  });

  test('the footer drops keys that do nothing when there is nothing to browse', () => {
    const frame = renderFrame(createState(result([])), { cols: 78, rows: 20 }).join('\n');
    assert.match(frame, /q quit/);
    assert.doesNotMatch(frame, /↑↓ move/, 'no list to move through');
  });

  test('an empty frame is still exactly the size it was asked for', () => {
    for (const [cols, rows] of [[60, 12], [78, 20], [130, 45]]) {
      const frame = renderFrame(createState(result([])), { cols, rows });
      assert.equal(frame.length, rows);
      assert.ok(frame.every((l) => displayWidth(l) === cols), `${cols}x${rows}`);
    }
  });

  test('an unusable terminal is told so rather than drawn on', () => {
    const frame = renderFrame(createState(SAMPLE), { cols: 30, rows: 8 }).join('\n');
    assert.match(frame, /terminal too small/);
  });

  test('a long list scrolls to keep the selection visible', () => {
    const long = result(Array.from({ length: 40 }, (_, i) => finding('ghost', `pkg-${String(i).padStart(2, '0')}`)));
    let state = createState(long);
    for (let i = 0; i < 39; i++) state = press(state, 'down');
    const frame = renderFrame(state, { cols: 78, rows: 20 }).join('\n');
    assert.match(frame, /› pkg-39/);
    assert.doesNotMatch(frame, /pkg-00/);
  });
});

describe('tui helpers', () => {
  test('fit pads and truncates to an exact display width', () => {
    assert.equal(fit('ab', 5), 'ab   ');
    assert.equal(displayWidth(fit('a-very-long-package-name', 10)), 10);
    assert.match(fit('a-very-long-package-name', 10), /…$/);
    assert.equal(displayWidth(fit('日本語のパッケージ', 8)), 8, 'wide characters count as two');
  });

  test('centre puts text in the middle at an exact width', () => {
    assert.equal(centre('ab', 6), '  ab  ');
    assert.equal(displayWidth(centre('odd', 8)), 8);
    assert.equal(displayWidth(centre('', 5)), 5);
  });

  test('wrap breaks on spaces and hard-breaks a long token', () => {
    assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
    assert.ok(wrap('x'.repeat(25), 10).every((l) => l.length <= 10));
    assert.deepEqual(wrap('', 10), []);
  });

  test('editorCommand speaks each editor\'s line syntax', () => {
    assert.deepEqual(editorCommand('vim', 'src/app.js', 12), { bin: 'vim', args: ['+12', 'src/app.js'] });
    assert.deepEqual(editorCommand('nvim', 'a.go', 3), { bin: 'nvim', args: ['+3', 'a.go'] });
    assert.deepEqual(editorCommand('code', 'a.ts', 9), { bin: 'code', args: ['-g', 'a.ts:9'] });
    assert.deepEqual(editorCommand('code --wait', 'a.ts', 9), { bin: 'code', args: ['--wait', '-g', 'a.ts:9'] });
    assert.deepEqual(editorCommand('subl', 'a.rb', 4), { bin: 'subl', args: ['a.rb'] });
  });
});

describe('tui lifecycle', () => {
  /** Drive runTui over injected streams, so no terminal is involved. */
  function drive(res, keys) {
    const stdin = new PassThrough();
    stdin.isTTY = false; // no setRawMode on a pipe
    const stdout = new PassThrough();
    stdout.columns = 90;
    stdout.rows = 24;

    let written = '';
    stdout.on('data', (chunk) => {
      written += chunk;
    });

    const done = runTui(res, { stdin, stdout });
    setImmediate(() => {
      for (const key of keys) stdin.write(key);
    });
    return done.then((code) => ({ code, written }));
  }

  test('quitting returns the same exit code as depx check', async () => {
    // ghosts present -> 1, exactly as renderReport would have exited
    assert.equal((await drive(SAMPLE, ['q'])).code, 1);
    assert.equal((await drive(result([finding('dead', 'moment')]), ['q'])).code, 0);
    assert.equal((await drive(result([]), ['q'])).code, 0);
  });

  test('a broken import fails the same way a ghost does', async () => {
    assert.equal((await drive(result([finding('broken', './gone.js')]), ['q'])).code, 1);
  });

  test('the alternate screen is entered and always left again', async () => {
    const { written } = await drive(SAMPLE, ['j', 'q']);
    assert.ok(written.startsWith('\x1b[?1049h'), 'enters the alternate screen first');
    assert.ok(written.endsWith('\x1b[?1049l'), 'leaves it last, whatever happened in between');
    assert.match(written, /\x1b\[\?25l/, 'hides the cursor');
    assert.match(written, /\x1b\[\?25h/, 'and puts it back');
  });

  test('the process is not left holding stdin open', async () => {
    // The event loop keeps running while a TTY read is referenced, so quitting
    // has to release it or `depx tui` restores the prompt and then hangs.
    const stdin = new PassThrough();
    stdin.isTTY = false;
    let unreffed = false;
    stdin.unref = () => {
      unreffed = true;
    };
    const stdout = new PassThrough();
    stdout.columns = 90;
    stdout.rows = 24;
    stdout.resume();

    const done = runTui(SAMPLE, { stdin, stdout });
    setImmediate(() => stdin.write('q'));
    await done;
    assert.ok(unreffed, 'stdin was unreffed on the way out');
    assert.equal(stdin.listenerCount('keypress'), 0, 'the key handler was removed');
  });

  test('ctrl-c leaves the terminal as it found it', async () => {
    const { written } = await drive(SAMPLE, ['\x03']);
    assert.ok(written.endsWith('\x1b[?1049l'));
  });
});

describe('tui end to end', () => {
  test('refuses to run without a terminal, and names the command that works', async () => {
    // node:test gives the child a pipe, not a TTY - which is the case itself.
    const failed = await run('node', [join(REPO, 'bin/depx.mjs'), 'tui', 'fixtures/messy'], { cwd: REPO }).catch(
      (e) => e,
    );
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /needs an interactive terminal/);
    assert.match(failed.stderr, /depx check/);
  });

  test('bare depx stays the batch report when there is no terminal', async () => {
    // node:test gives the child pipes, which is the case being asserted: the
    // interface only appears for a person, never for a script.
    const { stdout } = await run('node', [join(REPO, 'bin/depx.mjs'), '--no-color'], { cwd: REPO });
    assert.match(stdout, /scanned \d+ files/);
    assert.doesNotMatch(stdout, /q quit/, 'no interface chrome reached the pipe');
  });

  test('--json and --quiet keep the report even on a terminal', async () => {
    const { stdout } = await run('node', [join(REPO, 'bin/depx.mjs'), '--json'], { cwd: REPO });
    assert.doesNotThrow(() => JSON.parse(stdout));
  });

  test('tui is listed in the help', async () => {
    const { stdout } = await run('node', [join(REPO, 'bin/depx.mjs'), '--help', '--no-color'], { cwd: REPO });
    assert.match(stdout, /^\s+tui\s+browse the findings interactively/m);
  });
});
