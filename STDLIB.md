# STDLIB.md

Every package we would normally have installed, and the standard-library
feature we used instead.

`depx` has an empty `dependencies` object and no `node_modules`. Verify with
`make proof`, or run the tool on itself: `node bin/depx.mjs zero-dep .`

Node version targeted: **22+**, developed on **26.7.0**.

---

## 1. `acorn` / `@babel/parser` / `es-module-lexer` → a hand-written masking lexer

**Where:** [`src/lang/javascript.mjs`](src/lang/javascript.mjs)

The single substitution the project rests on. To find import specifiers, the
reflex is to install a JavaScript parser and walk the AST.

We do not need a syntax tree — only the string literals that sit in import
position. So instead we *mask* the source: comments, string bodies, template
literals (including `${}` nesting) and regex literals are blanked out while
byte offsets are preserved. Every surviving string literal is then tested
against the code immediately before it (`from`, `import`, `import(`,
`require(`, `require.resolve(`).

About 150 lines replace a 100 KB dependency, and it cannot be fooled by
`// import 'fake'` or by `const s = "require('fake')"`. Both cases are tested.

The one thing a lexer gives up versus a parser is following re-exports through
aliasing. Documented in the README under Honest limits.

## 2. `@iarna/toml` / `smol-toml` → hand-written TOML subset reader

**Where:** [`src/toml.mjs`](src/toml.mjs)

Node ships **no TOML support at any version** — the one format gap that
actually forced original work. We need `Cargo.toml` and `pyproject.toml`.

We implemented the subset a dependency manifest can contain: tables, nested and
quoted table headers, dotted keys, strings, numbers, booleans, inline tables
and inline arrays. Comment stripping and the key/value split are both
quote-aware, so `key = "a=b # c"` parses correctly — the naive `split('=')` and
`split('#')` that most hand-rolled readers use would both corrupt it.

Arrays of tables and datetimes are deliberately not implemented. Six tests.

*(Note for the record: Bun 1.4 ships `Bun.TOML`. We target Node, and the
machine we built on has Bun 1.3.14, so it was not an option — but a Bun
submission could legitimately skip this file entirely.)*

## 3. `chalk` / `picocolors` / `kleur` → `util.styleText()`

**Where:** [`src/report.mjs`](src/report.mjs)

`chalk` is 319.8M weekly downloads and was the vector for the September 2025
crypto-clipper attack. `util.styleText` has been stable since Node 22.17 and
already consults `NO_COLOR` and TTY state, so we did not reimplement that
policy — we only added an explicit `--no-color` override and forced colour off
for `--json`.

## 4. `string-width` → `displayWidth()` over code points

**Where:** [`src/report.mjs`](src/report.mjs)

Aligning columns needs display width, not `String.length`. `string-width`
exists because ANSI escapes are invisible and CJK characters are two columns
wide.

Twenty lines: strip SGR escapes with one regex, then iterate *code points*
(`for…of` on a string, not indices, so astral-plane emoji are not split into
surrogate halves), skipping control characters and combining marks, counting
the East Asian wide and emoji ranges as two.

## 5. `cli-table3` / `boxen` → `columns()`

**Where:** [`src/report.mjs`](src/report.mjs)

Two passes: measure the widest cell per column, then pad. Fifteen lines, and it
composes with `displayWidth` above so colour codes never break alignment.
There is a test asserting exactly that.

## 6. `minimist` / `commander` / `yargs` → `util.parseArgs()`

**Where:** [`bin/depx.mjs`](bin/depx.mjs)

`minimist` is 80.5M weekly downloads. `parseArgs` handles flags, short
aliases and defaults; what it deliberately does not do is subcommands, so
dispatch, the help text and the `depx ./path` shorthand (a bare path with no
command means `check`) are ours. That is about 30 lines.

## 7. `globby` / `fast-glob` → `fs.opendir()` recursion

**Where:** [`src/walk.mjs`](src/walk.mjs)

`fs.glob` exists in Node 22+, but we need to make a skip decision *at each
directory* — pruning `node_modules` before descending is the difference between
a fast scan and a slow one. An async generator over `opendir` gives us that,
and streams results instead of materialising a path array.

## 8. `ignore` → hand-written `.gitignore` matcher

**Where:** [`src/walk.mjs`](src/walk.mjs)

Pattern-to-RegExp translation covering the forms that appear in real files:
`*`, `**`, `?`, character classes, leading `/` anchoring, trailing `/` for
directory-only, and `!` negation with **last-match-wins** ordering, which is
how git itself resolves conflicts and the rule hand-rolled matchers usually get
wrong.

The subtlest correct behaviour: a pattern containing a slash anywhere is
anchored to the repo root, while a bare name matches at any depth. Six tests.

## 9. `isbinaryfile` → an 8 KiB NUL-byte probe

**Where:** [`src/walk.mjs`](src/walk.mjs)

Read the first 8 KiB with a `FileHandle`, look for a `0x00` byte. This is the
same heuristic git uses. Six lines, one block read, and it keeps the scanner
from trying to lex a `.png` that happens to end in `.h`.

## 10. `xml2js` / `fast-xml-parser` → targeted regex extraction

**Where:** [`src/lang/tier3.mjs`](src/lang/tier3.mjs)

Reading `<dependency>` blocks out of a `pom.xml` does not require a compliant
XML parser. We match dependency blocks and pull `groupId` / `artifactId` from
each. This is *not* general XML parsing and we would not present it as such —
it is extraction from a known, narrow shape, which is why it is safe here and
would not be safe in a Track B submission.

## 11. `jest` / `mocha` / `vitest` → `node:test` + `node:assert/strict`

**Where:** [`test/`](test/)

207 tests across 52 suites, using `describe`/`test` and strict assertions. No
config file, no transform step, no watch-mode dependency. `npm test` runs
`node --test`.

The resolution suite builds throwaway projects in `os.tmpdir()` with
`fs.mkdtemp` and analyses them end to end, so the tests exercise the real
walker and the real manifest readers rather than a mocked filesystem — again
without a fixture or temp-directory package.

## 12. `esbuild` / `rollup` / `webpack` / `ncc` → `tools/bundle.mjs`

**Where:** [`tools/bundle.mjs`](tools/bundle.mjs)

To ship one file, the reflex is to install a bundler. We need exactly one
feature of one — inline a module graph we control — and that graph is nine
modules with no dynamic imports, no CSS, no tree shaking and nothing to
minify. That is a topological sort and a few textual rewrites: about 190
lines against esbuild's ~10 MB.

Each module is emitted as an IIFE returning its exports, which preserves
module scope. That is not decoration: `scanImports`, `normalize` and
`readManifest` are each defined in five different language adapters, and flat
concatenation would silently let one overwrite the others. A test asserts the
same-named functions still coexist in the output.

The output is byte-identical across runs — modules are emitted in a
deterministic post-order, builtin imports are merged and sorted, and nothing
records a timestamp, a build path or a nonce. `make verify` builds twice,
compares the hashes, and then diffs the bundle's output against the source
tree's to prove the build did not change behaviour.

## 13. `license-checker` / `oss-attribution-generator` → `src/vendor.mjs`

**Where:** [`src/vendor.mjs`](src/vendor.mjs)

The rules close the vendoring loophole in prose — copying a library into
`src/` is "a dependency with extra steps" — but nothing checks it, because
the manifest still reads `{}`. So `depx zero-dep` reads the code instead,
looking for the marks source carries when it was not typed by the person
shipping it: source-map comments, bundler-preserved `@license` pragmas,
generated-file banners, UMD wrappers, third-party licence headers, and lines
too long to have been written by hand.

Licence and banner markers are matched against *comment text only*, extracted
by a small comment lexer. That is more precise than scanning raw source, and
it is the reason the detector does not flag itself — its own patterns live in
its code, not its prose. There is a test for exactly that.

## 14. `ignore` / `minimatch` / `cosmiconfig` → `src/ignore.mjs`

**Where:** [`src/ignore.mjs`](src/ignore.mjs)

Reading a dotfile of suppression rules is where a tool normally acquires
three dependencies at once: a config loader to find the file, a glob library
to match names, and an ignore library to apply precedence.

The file is a list of lines. Two forms - `name` and `type:name` - with `*` and
`?` globbing inside the name and `#` starting a comment. Everything else in a
package name, including the `.`, `-`, `@` and `/` that fill real ones, is
matched literally, which is a four-line pattern-to-RegExp translation rather
than a matcher library.

The design decision worth recording is that suppression is never silent: the
count of what a rule removed is reported even when the findings are not, so a
reader can tell a clean repository from a well-configured one. A hidden
finding is worse than a reported one, because nobody can audit what they
cannot see.

## 15. `semver` → not needed at all

Worth recording as a substitution *avoided*. We report the version string a
manifest declares but never compare ranges, so the dependency never became
necessary. The cheapest package to replace is the one you notice you do not
need.

## 16. `ink` / `blessed` / `enquirer` / `ora` → `src/tui.mjs`

**Where:** [`src/tui.mjs`](src/tui.mjs)

`depx tui` is a full-screen interactive interface: an alternate screen, arrow
keys, a live filter, a scrolling list and reflow on resize. The reflex here is
`ink` — which is React, plus a reconciler, plus a Yoga layout engine compiled
to WebAssembly, to draw a list you can arrow through in a terminal.

Every piece of it is already in Node:

| Need | Package normally installed | Standard library |
|---|---|---|
| Decode arrow keys and escape sequences | `keypress`, `ink` | `readline.emitKeypressEvents()` |
| Read keys unbuffered | `blessed`, `enquirer` | `stdin.setRawMode(true)` |
| Alternate screen, cursor hiding | `blessed`, `cli-cursor`, `ora` | `\x1b[?1049h` / `\x1b[?25l` |
| Know the terminal size, and when it changes | `term-size`, `blessed` | `stdout.columns` / `rows`, the `resize` event |
| Lay out two panes and wrap text | `ink`, Yoga (WASM) | `fit()` and `wrap()`, 30 lines over `displayWidth()` |
| Highlight the selection | `chalk` | `util.styleText('inverse')` |

The layout maths is the `displayWidth()` from item 4 doing a second job, and
the category labels and colours are imported from `src/report.mjs` rather than
restated, so the two interfaces cannot describe the same finding differently.

The design decision worth recording is that the state machine and the frame
renderer are **pure functions of `(state, size)`**. `reduce(state, key)`
returns the next state, and `renderFrame(state, {cols, rows})` returns an array
of exactly `rows` strings of exactly `cols` display width. Only `runTui()`
touches stdin, stdout or the process — so 33 tests drive the entire interface
with no terminal involved, asserting on frames as strings. Testing an `ink`
interface normally means installing `ink-testing-library` too.

---

## Package Killer

Our nomination is **`depcheck` and `dependency-cruiser`**, the packages `depx`
replaces wholesale — but the substitution we would put forward is
**item 1: the JavaScript parser**.

Every tool in this category (`depcheck`, `dependency-cruiser`, `madge`,
`eslint-plugin-import`, every bundler) installs a full JavaScript parser to
answer one question: *which strings are import specifiers?* We answered it with
a 150-line lexer that passes decoy cases those tools also handle, and shipped a
dependency scanner with no dependencies — which is the entire point of the
exercise.

The lexer is tested against the decoys those parsers exist to handle: an
import inside a line comment, inside a block comment, inside a string, inside
a template literal, inside a regex literal, and a `/` that is division rather
than a regex — plus the webpack magic-comment form
`import(/* webpackChunkName: "x" */ 'pkg')`, where the specifier follows a
comment that has just been masked away. All eight real import forms are
found and all six decoys rejected.

Combined weekly downloads of the packages named across this document exceed
**400 million**.

## Vendoring disclosure

**None.** No third-party source is copied into this repository. Every line in
`src/`, `bin/` and `test/` was written during the event window - including the
ANSI escape sequences in `src/tui.mjs`, which are values from the terminal
specification rather than code taken from a library. The curated
data tables — Python's standard-library module list, the Python
import-to-distribution aliases, the Ruby standard-library list, and the
substitution table in `src/substitutions.mjs` — are facts compiled from
language documentation and this event's own cheat-sheet, not copied code.
