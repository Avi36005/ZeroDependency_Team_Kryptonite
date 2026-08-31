// Interactive terminal UI: browse the findings instead of reading all of them.
//
// Replaces: `ink`, `blessed`, `enquirer`, `ora`, `cli-cursor`, `terminal-kit`.
// An alternate screen, decoded arrow keys, raw mode and resize handling are
// node:readline plus a dozen ANSI escapes - which is the whole of what those
// packages provide for a list you can arrow through.
//
// Split in two on purpose. Everything above runTui() is a pure function of
// (state, size), so the suite drives the entire interface without a terminal
// and without spawning anything. Only runTui() touches stdin, stdout or the
// process.

import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { c, displayWidth, ORDER, HEADINGS } from './report.mjs';

const LEFT_WIDTH = 22; // category pane; the report's longest label is UNDECLARED
const MIN_COLS = 60;
const MIN_ROWS = 12;

// Why each finding matters, in the report's own vocabulary. `replaceable` and
// `dead` carry their own per-finding detail, so they are not listed here.
const WHY = {
  ghost: 'Nothing local provides this name, so the build breaks on a clean checkout. Check it against its registry: if it is not there either, this is the slopsquat window.',
  broken: 'A relative import pointing at no file on disk. Not a judgement call - the path is simply not there.',
  phantom: 'Installed but never declared. It resolves today because something else dragged it in, and breaks the moment that dependency moves.',
  undeclared: 'Not in the manifest, and no install tree here to check against - so this is reported as unverified rather than as a ghost.',
};

/* ---------------------------------------------------------------- state -- */

/**
 * Group the findings the way the report orders them, dropping the kinds that
 * found nothing. An empty category is worth a count in a report and is only
 * an obstacle in a list you arrow through.
 */
export function createState(result) {
  const groups = ORDER.map((type) => ({
    type,
    items: result.findings.filter((f) => f.type === type),
  })).filter((g) => g.items.length > 0);

  return { result, groups, cat: 0, item: 0, top: 0, mode: 'nav', filter: '', message: '' };
}

/** The findings in the selected category, narrowed by the filter. */
export function visible(state) {
  return matchesIn(state, state.cat);
}

/**
 * The findings in one category that survive the filter. The filter is global -
 * it applies to every category at once - which is what makes `/` behave like a
 * search rather than a per-list narrowing.
 */
export function matchesIn(state, cat) {
  const group = state.groups[cat];
  if (!group) return [];
  const query = state.filter.trim().toLowerCase();
  if (!query) return group.items;
  return group.items.filter((f) => f.name.toLowerCase().includes(query));
}

/** How many findings the current filter matches, everywhere. */
export function totalMatches(state) {
  return state.groups.reduce((n, _, i) => n + matchesIn(state, i).length, 0);
}

/**
 * The next category in `step` direction that has something to show. While a
 * filter is active this skips the empty ones, so arrowing across the
 * categories walks the search results instead of stopping on blank panes.
 */
function nextCat(state, from, step) {
  const n = state.groups.length;
  if (!n) return 0;
  for (let i = 1; i <= n; i++) {
    const cat = (from + step * i + n * i) % n;
    if (!state.filter.trim() || matchesIn({ ...state, cat }, cat).length) return cat;
  }
  return from;
}

/** After typing, land on a category that actually has a match. */
function settle(state) {
  if (!state.filter.trim() || matchesIn(state, state.cat).length) return state;
  const cat = state.groups.findIndex((_, i) => matchesIn(state, i).length);
  return cat === -1 ? state : { ...state, cat };
}

export function selected(state) {
  return visible(state)[state.item] ?? null;
}

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * The whole key map, as a pure reduction. Returns the next state and the
 * action the caller has to perform in the world - quitting or opening an
 * editor - because those are the two things a pure function cannot do.
 */
export function reduce(state, key) {
  const next = { ...state, message: '' };
  const name = key.name ?? '';
  const ch = key.sequence ?? '';

  if (key.ctrl && (name === 'c' || name === 'd')) return { state: next, action: 'quit' };

  if (state.mode === 'filter') {
    if (name === 'return' || name === 'escape') {
      // Escape abandons the filter; Enter keeps it and goes back to the list.
      if (name === 'escape') next.filter = '';
      next.mode = 'nav';
      next.item = 0;
      next.top = 0;
      return { state: next, action: null };
    }
    if (name === 'backspace') {
      next.filter = state.filter.slice(0, -1);
    } else if (ch && ch.length === 1 && ch >= ' ' && ch !== '\x7f') {
      next.filter = state.filter + ch;
    }
    next.item = 0;
    next.top = 0;
    // Typing jumps to wherever the match is: a search that made you guess the
    // category first would not be a search.
    return { state: settle(next), action: null };
  }

  const count = visible(state).length;
  const last = Math.max(0, count - 1);

  switch (true) {
    case name === 'q' || name === 'escape':
      if (state.filter) {
        next.filter = '';
        next.item = 0;
        next.top = 0;
        return { state: next, action: null };
      }
      return { state: next, action: 'quit' };

    case name === 'up' || ch === 'k':
      next.item = clamp(state.item - 1, 0, last);
      break;
    case name === 'down' || ch === 'j':
      next.item = clamp(state.item + 1, 0, last);
      break;

    // Categories wrap, because six of them in a row is a carousel, not a list.
    case name === 'left' || ch === 'h':
      next.cat = nextCat(state, state.cat, -1);
      next.item = 0;
      next.top = 0;
      break;
    case name === 'right' || ch === 'l' || name === 'tab':
      next.cat = nextCat(state, state.cat, 1);
      next.item = 0;
      next.top = 0;
      break;

    case ch === 'g':
      next.item = 0;
      break;
    case ch === 'G':
      next.item = last;
      break;

    case ch === '/':
      next.mode = 'filter';
      break;

    case name === 'return':
      return { state: next, action: selected(state) ? 'open' : null };
  }

  return { state: next, action: null };
}

/** Scroll the window so the selection stays inside it. */
function reframe(state, height) {
  const count = visible(state).length;
  let top = state.top;
  if (state.item < top) top = state.item;
  if (state.item >= top + height) top = state.item - height + 1;
  return clamp(top, 0, Math.max(0, count - height));
}

/* --------------------------------------------------------------- render -- */

/** Pad or truncate plain text to an exact display width. */
export function fit(text, width) {
  if (width <= 0) return '';
  const w = displayWidth(text);
  if (w === width) return text;
  if (w < width) return text + ' '.repeat(width - w);

  let out = '';
  let used = 0;
  for (const chr of text) {
    const cw = displayWidth(chr);
    if (used + cw > width - 1) break;
    out += chr;
    used += cw;
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1));
}

/** Centre plain text in an exact width. */
export function centre(text, width) {
  const pad = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  return fit(' '.repeat(pad) + text, width);
}

/** Greedy wrap on spaces, falling back to a hard break for a long token. */
export function wrap(text, width) {
  if (width <= 0) return [];
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
    } else if (displayWidth(line) + 1 + displayWidth(word) <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
    while (displayWidth(line) > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Where a finding is, as the report writes it. */
function siteOf(finding) {
  const site = finding?.sites?.[0];
  if (!site) return '';
  return `${site.file}:${site.line}:${site.column}`;
}

/** The detail block for the selected finding - two lines, wrapped to width. */
function detailLines(state, width, height) {
  const finding = selected(state);
  if (!finding) return [];

  const parts = [];
  if (finding.type === 'replaceable') {
    parts.push(`-> ${finding.detail}  (${finding.since})`);
    if (finding.note) parts.push(finding.note);
  } else if (finding.type === 'dead') {
    parts.push(finding.detail);
  } else {
    parts.push(WHY[finding.type] ?? finding.detail ?? '');
  }

  const sites = finding.sites ?? [];
  if (sites.length > 1) {
    const shown = sites.slice(0, 4).map((s) => `${s.file}:${s.line}:${s.column}`).join('  ');
    parts.push(`${sites.length} sites: ${shown}` + (sites.length > 4 ? '  …' : ''));
  }

  return wrap(parts.filter(Boolean).join('  '), width).slice(0, height);
}

/**
 * The frame shown while the walk is still running. Same chrome as every other
 * frame, so the interface does not jump when the results arrive.
 */
export function renderScanning({ path, files = 0, done = false }, { cols, rows }) {
  if (cols < MIN_COLS || rows < MIN_ROWS) return [fit('  scanning…', cols)];

  const inner = cols - 2;
  const rule = c.dim('  ' + '─'.repeat(inner));
  const out = [];

  out.push('  ' + c.bold(fit(`depx · ${basename(path || '.')}`, inner)));
  out.push(rule);

  const body = rows - 4;
  // A spinner would be decoration; the file count is the actual evidence that
  // something is happening, so that is what moves.
  const panel = [
    ' '.repeat(inner),
    centre(done ? c.green('✓  scanned') : c.cyan('scanning…'), inner),
    ' '.repeat(inner),
    centre(c.dim(`${files} file${files === 1 ? '' : 's'}`), inner),
    ' '.repeat(inner),
    centre(c.dim(path || '.'), inner),
  ];
  const lead = Math.max(0, Math.floor((body - panel.length) / 3));
  for (let i = 0; i < body; i++) out.push('  ' + (panel[i - lead] ?? ' '.repeat(inner)));

  out.push(rule);
  out.push('  ' + c.dim(fit('reading every import and resolving it against the manifest', inner)));
  return out.slice(0, rows);
}

/**
 * One frame, as an array of exactly `rows` lines each exactly `cols` wide.
 * Pure: the same state and size always produce the same frame, which is what
 * makes the suite able to assert on the interface.
 */
export function renderFrame(state, { cols, rows }) {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `terminal too small - depx tui needs ${MIN_COLS}x${MIN_ROWS}, this is ${cols}x${rows}`;
    return [...wrap(msg, Math.max(1, cols - 2)).map((l) => '  ' + l)];
  }

  const inner = cols - 2; // the report's two-space left margin, kept
  const rule = c.dim('  ' + '─'.repeat(inner));
  const out = [];

  // Header: what was scanned, and how much of it.
  const langs = state.result.languages.length;
  const left = `depx · ${basename(state.result.root || '.')}`;
  const hits = state.filter.trim() ? totalMatches(state) : null;
  const files = state.result.filesScanned;
  const right =
    hits === null
      ? `${files} file${files === 1 ? '' : 's'} · ${langs} lang${langs === 1 ? '' : 's'}`
      : `${hits} match${hits === 1 ? '' : 'es'} for "${state.filter.trim()}"`;
  out.push('  ' + c.bold(fit(left, Math.max(0, inner - displayWidth(right)))) + c.dim(right));
  out.push(rule);

  // header, rule, body, rule, footer - plus the detail strip and its own rule
  // when there are findings to explain.
  const detailHeight = state.groups.length ? 3 : 0;
  const chrome = state.groups.length ? 5 : 4;
  const bodyHeight = Math.max(1, rows - chrome - detailHeight);

  if (state.groups.length === 0) {
    // Nothing to browse. A screen of empty rows reads as a broken program, so
    // the three no-findings outcomes each get a composed panel instead - and
    // they stay distinct, because a repository whose findings were all
    // suppressed is configured, not clean.
    const suppressed = (state.result.suppressed ?? []).length;
    const blank = state.result.filesScanned === 0;

    const mark = blank ? c.yellow('!') : suppressed ? c.yellow('✓') : c.green('✓');
    const headline = blank ? 'nothing analysed' : suppressed ? 'nothing outside .depxignore' : 'clean';
    const detail = blank
      ? 'no source files were found in this directory'
      : suppressed
        ? `every finding here is suppressed by .depxignore (${suppressed})`
        : 'every import resolves, and nothing is unused';

    const langs = state.result.languages.length;
    const stats = `${state.result.filesScanned} file${state.result.filesScanned === 1 ? '' : 's'} scanned` +
      (langs ? ` across ${langs} language${langs === 1 ? '' : 's'}` : '');
    const nested = state.result.skippedProjects ?? [];

    const gap = ' '.repeat(inner); // every row in a frame is full width
    const panel = [
      gap,
      centre(`${mark}  ${blank || suppressed ? c.yellow(headline) : c.green(headline)}`, inner),
      gap,
      centre(c.dim(detail), inner),
      gap,
      centre(c.dim(stats), inner),
    ];
    if (nested.length) {
      panel.push(
        centre(
          c.dim(`${nested.length} nested project${nested.length === 1 ? '' : 's'} not descended into`),
          inner,
        ),
        centre(c.dim('each has its own manifest - open depx inside it'), inner),
      );
    }

    // Sit the panel a third of the way down rather than pinned to the top.
    const lead = Math.max(0, Math.floor((bodyHeight - panel.length) / 3));
    for (let i = 0; i < bodyHeight; i++) {
      out.push('  ' + (panel[i - lead] ?? ' '.repeat(inner)));
    }
  } else {
    const searching = Boolean(state.filter.trim());
    const items = visible(state);
    const top = reframe(state, bodyHeight);
    const listWidth = inner - LEFT_WIDTH - 2;

    for (let row = 0; row < bodyHeight; row++) {
      // Left pane: the categories. While a filter is active each one carries
      // its own match count, so a search shows where its results are rather
      // than only what the open category happens to hold.
      const group = state.groups[row];
      let leftCell;
      if (!group) {
        leftCell = ' '.repeat(LEFT_WIDTH);
      } else {
        const head = HEADINGS[group.type];
        const hits = searching ? matchesIn(state, row).length : group.items.length;
        const count = searching ? `${hits}/${group.items.length}` : `${group.items.length}`;
        const label = `${row === state.cat ? '▸' : ' '} ${head.label} (${count})`;
        leftCell =
          row === state.cat
            ? head.paint(c.bold(fit(label, LEFT_WIDTH)))
            : searching && hits === 0
              ? c.dim(fit(label, LEFT_WIDTH))
              : (searching ? head.paint : c.dim)(fit(label, LEFT_WIDTH));
      }

      // Right pane: the findings in the selected category. The selected row
      // carries a glyph as well as reverse video, so the interface still
      // reads under NO_COLOR or on a terminal that ignores the escape.
      const finding = items[top + row];
      const isCurrent = top + row === state.item;
      let rightCell;
      if (!finding) {
        rightCell =
          top + row === 0 && state.filter
            ? c.dim(fit(`  no ${state.groups[state.cat].type} matches "${state.filter}"`, listWidth))
            : ' '.repeat(listWidth);
      } else {
        const body = listWidth - 2;
        const where = siteOf(finding);
        const nameWidth = Math.max(8, body - displayWidth(where) - 2);
        const whereWidth = body - nameWidth - 2;
        rightCell = isCurrent
          ? c.inverse('\u203a ' + fit(finding.name, nameWidth) + '  ' + fit(where, whereWidth))
          : '  ' +
            HEADINGS[state.groups[state.cat].type].paint(fit(finding.name, nameWidth)) +
            '  ' +
            c.dim(fit(where, whereWidth));
      }

      out.push('  ' + leftCell + c.dim('│ ') + rightCell);
    }

    out.push(rule);
    const detail = detailLines(state, inner, detailHeight);
    for (let i = 0; i < detailHeight; i++) out.push('  ' + c.dim(fit(detail[i] ?? '', inner)));
  }

  out.push(rule);

  // Footer: the filter prompt while typing, the key map otherwise.
  const footer =
    state.mode === 'filter'
      ? c.cyan('/' + state.filter) + c.dim('▏  ⏎ keep   esc clear   (searches every category)')
      : state.message
        ? c.yellow(state.message)
        : state.groups.length === 0
          ? c.dim('q quit')
          : c.dim('↑↓ move   ←→ category   / search   ⏎ open   q quit') +
            (state.filter ? c.cyan(`   /${state.filter}`) : '');

  // Every line in a frame is exactly `cols` wide, the footer included - and
  // an over-long one falls back to a shorter hint rather than being sliced,
  // because slicing coloured text cuts an escape sequence in half.
  const footerWidth = displayWidth(footer);
  out.push(
    '  ' +
      (footerWidth > inner
        ? c.dim(fit('↑↓ ←→ move   / search   q quit', inner))
        : footer + ' '.repeat(inner - footerWidth)),
  );

  // A frame is always exactly `rows` tall, so nothing from the last one shows.
  while (out.length < rows) out.splice(out.length - 1, 0, ' '.repeat(cols));
  return out.slice(0, rows);
}

/* ------------------------------------------------------------- the world -- */

const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';

/** `$EDITOR +12 src/app.js`, or the `-g file:line` form VS Code wants. */
export function editorCommand(editor, file, line) {
  const argv = editor.trim().split(/\s+/);
  const bin = argv[0];
  const rest = argv.slice(1);
  if (/\bcode(-insiders)?$/.test(bin)) return { bin, args: [...rest, '-g', `${file}:${line}`] };
  if (/\b(vim|nvim|vi|nano|emacs|kak|hx|helix)$/.test(bin)) return { bin, args: [...rest, `+${line}`, file] };
  return { bin, args: [...rest, file] };
}

/**
 * Run the interface. Resolves with the exit code once the user quits.
 *
 * The terminal is a global the process borrows, so every escape sequence
 * written here is undone in finish() - including on a crash, which is why the
 * restore runs from a finally and not from the quit path.
 */
export function runTui(source, { stdin = process.stdin, stdout = process.stdout, progress = null } = {}) {
  // `source` is either a result or a promise of one. Given a promise, the scan
  // screen is drawn first and the interface takes over when it settles - which
  // on a small project is a flicker, and on a large one is the only feedback
  // there is.
  const pending = typeof source?.then === 'function' ? source : null;
  if (!pending) return drive(source, { stdin, stdout });

  return new Promise((resolve, reject) => {
    const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    const paint = (done) =>
      stdout.write(
        '\x1b[H' +
          renderScanning({ path: progress?.path, files: progress?.files ?? 0, done }, size())
            .map((l) => l + '\x1b[K')
            .join('\r\n') +
          '\x1b[J',
      );

    stdout.write(ALT_ON);
    paint(false);
    // Redraw on a timer rather than per file: the walk reports thousands of
    // times on a large tree, and a terminal cannot show that and should not try.
    const tick = setInterval(() => paint(false), 80);
    if (typeof tick.unref === 'function') tick.unref();

    pending.then(
      (result) => {
        clearInterval(tick);
        resolve(drive(result, { stdin, stdout, alreadyOnAltScreen: true }));
      },
      (error) => {
        clearInterval(tick);
        stdout.write(ALT_OFF);
        reject(error);
      },
    );
  });
}

function drive(result, { stdin, stdout, alreadyOnAltScreen = false }) {
  return new Promise((resolve) => {
    let state = createState(result);
    let closed = false;

    const draw = () => {
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;
      // Home, then clear each line as it is rewritten: no full-screen erase,
      // so the frame does not flash between renders.
      stdout.write('\x1b[H' + renderFrame(state, { cols, rows }).map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J');
    };

    const finish = (code) => {
      if (closed) return;
      closed = true;
      stdin.off('keypress', onKey);
      stdout.off('resize', draw);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      // emitKeypressEvents leaves a reader on the handle, and a referenced TTY
      // keeps the event loop alive: without this the report is restored, the
      // prompt comes back, and the process never actually exits.
      stdin.unref?.();
      stdout.write(ALT_OFF);
      resolve(code);
    };

    const onKey = (str, key = {}) => {
      const { state: nextState, action } = reduce(state, { ...key, sequence: key.sequence ?? str });
      state = nextState;

      if (action === 'quit') {
        // The exit code has to agree with `depx check`, or the same repository
        // passes in one interface and fails in the other.
        const bad = result.findings.some((f) => f.type === 'ghost' || f.type === 'broken');
        finish(bad ? 1 : 0);
        return;
      }
      if (action === 'open') openInEditor();
      draw();
    };

    const openInEditor = () => {
      const finding = selected(state);
      const site = finding?.sites?.[0];
      if (!site) return;
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (!editor) {
        state.message = `no $EDITOR set - ${siteOf(finding)}`;
        return;
      }
      const { bin, args } = editorCommand(editor, site.file, site.line);
      // Hand the terminal over whole: leave the alt screen, drop raw mode, and
      // take both back when the editor exits.
      if (stdin.isTTY) stdin.setRawMode(false);
      stdout.write(ALT_OFF);
      try {
        spawn(bin, args, { stdio: 'inherit', cwd: result.root }).on('exit', () => {
          stdout.write(ALT_ON);
          if (stdin.isTTY) stdin.setRawMode(true);
          draw();
        });
      } catch (error) {
        stdout.write(ALT_ON);
        if (stdin.isTTY) stdin.setRawMode(true);
        state.message = `could not run ${bin}: ${error.message}`;
      }
    };

    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.on('resize', draw);
    if (!alreadyOnAltScreen) stdout.write(ALT_ON);
    draw();
  });
}
