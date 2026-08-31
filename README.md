# depx

**A dependency x-ray for twelve languages, with no dependencies of its own.**

`depx` reads a repository's source and its manifest, and reports where the two
disagree: imports that resolve to nothing, packages installed but never
declared, dependencies declared but never used, and dependencies the standard
library already provides.

It runs entirely offline, requires no installation, and has an empty
dependency manifest.

---

**Zero Dependency 2026 · Team Kryptonite · Track A — Developer Tools & CLI**

| | |
|---|---|
| Build | `make build` (one command; nothing is downloaded or compiled) |
| Manifest | [`package.json`](package.json) — `"dependencies": {}`, no `node_modules` |
| Proof | [`deps-proof.txt`](deps-proof.txt), regenerate with `make proof` |
| Substitutions | [`STDLIB.md`](STDLIB.md) — 16 packages replaced with the standard library |
| Bonuses claimed | Reproducible Build (`make verify`) · Package Killer · STDLIB Log |
| Licence | MIT |

Everything in `src/`, `bin/`, `test/` and `tools/` was written during the event
window. No third-party source is vendored; `depx vendored .` checks that claim
against this repository itself.

---

## Contents

- [Overview](#overview) — the problem, in plain terms
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [The interactive interface](#the-interactive-interface)
- [Findings](#findings)
- [Suppressing findings](#suppressing-findings)
- [Language support](#language-support)
- [Verifying the Zero Dependency rule](#verifying-the-zero-dependency-rule)
- [Limitations](#limitations)
- [Zero dependencies](#zero-dependencies)
- [Development](#development)
- [Licence](#licence)

---

## Overview

### The problem

**Large language models invent packages that do not exist.**

A 2025 USENIX Security study fed 576,000 AI-generated code samples through a
checker and found that **19.7% of the packages the models recommended were not
real**. Not typos — inventions.

The dangerous part is that the inventions *repeat*. Ask ten models for an HTTP
retry helper and a good number will reach for the same plausible-sounding name.
So an attacker does not need to guess: they read what the models suggest,
register those names on the registry first, and wait. You run `npm install`,
the name resolves, and their code is now in your build.

You never made a mistake. The model did, and the attacker was already there.
The industry calls this **slopsquatting**, and it is the first supply-chain
attack where the victim types everything correctly.

The same defect predates AI, in a quieter form: an import works on your machine
only because some other package happened to drag its dependency into
`node_modules`, then fails the first time CI does a clean checkout.

**Both are the same bug — the code and the manifest disagree — and both are
visible without running anything.**

### What depx does

It reads two things and compares them:

- what your **source code imports**
- what your **manifest declares** (and what is actually installed)

Then it reports every place they disagree, in six kinds:

| Finding | In plain English | Why you care |
|---|---|---|
| **ghost** | You import it, and nothing here provides it. | The build breaks on a clean checkout. **This is the slopsquat case.** |
| **broken** | You import a file that is not on disk. | Same, and not a judgement call. |
| **phantom** | You use it but never declared it. | Works today; breaks the moment that transitive dependency moves. |
| **undeclared** | Not declared, and there is no evidence here to judge it further. | Deliberately low-confidence — see below. |
| **replaceable** | The standard library already ships this. | Delete a dependency for free. |
| **dead** | Declared, never imported. | Dead weight in your install and your audit surface. |

Twelve languages, one pass, entirely offline. It also verifies a repository
against this event's Zero Dependency rule — including the half a manifest
cannot show: whether the source was **written or copied in**.

### What it does not claim

This is the part worth reading, because it is where most tools in this category
overreach.

`depx` is offline by design. It can prove an import **resolves to nothing in
the project in front of it**. It cannot prove a package exists nowhere on
earth — that would need a copy of the registry index, which is exactly the kind
of dependency this tool exists without.

So the findings are worded to match the evidence. A name that looks invented is
reported as *"nothing local provides this"*, and the registry lookup is left to
you. `undeclared` exists as a separate, deliberately weaker finding for exactly
the cases where the evidence does not support calling something a ghost.

A false ghost is the worst error this tool can make — it sends someone hunting a
supply-chain compromise that is not there — so the whole design leans away from
it. See [Exclusions](#exclusions).

### The twist

**It is a tool that finds dependency problems, and it has zero dependencies
itself.**

No `npm install`. No `node_modules`. An empty `dependencies` object. Everything
that would normally have been a package — a JavaScript parser, a TOML reader,
`chalk`, `minimist`, a glob library, a test framework, a bundler, and an entire
interactive terminal UI that would usually mean React and a WebAssembly layout
engine — is written against Node's standard library instead. All sixteen
substitutions are documented, with the reasoning, in [`STDLIB.md`](STDLIB.md).

### Verify all of that in 60 seconds

```sh
cat package.json                     # "dependencies": {}
ls node_modules                      # No such file or directory
make test                            # 217 tests, no test framework
node bin/depx.mjs zero-dep .         # the tool's verdict on itself
make verify                          # two builds, byte-identical
```

And to see it actually working:

```sh
node bin/depx.mjs check fixtures/messy   # a broken project, all six findings
cd fixtures/messy && node ../../bin/depx.mjs tui   # the interactive interface
```

Or read [`deps-proof.txt`](deps-proof.txt), which is all of the above captured
in one file.

---

## Installation

### Requirements

Node.js 22 or newer. Developed and tested on Node 26.7.0. No other software is
required.

### From source

```sh
git clone https://github.com/Avi36005/ZeroDependency_Team_Kryptonite
cd ZeroDependency_Team_Kryptonite
make build
```

`make build` performs a syntax check and marks the entry point executable.
Nothing is downloaded or compiled.

### Single-file build

```sh
make dist
node dist/depx.mjs check .
```

`make dist` inlines the module graph into `dist/depx.mjs`, a single file whose
only imports are Node built-ins. The build is deterministic; see
[Reproducible build](#reproducible-build).

### Invocation

This document writes `depx` for brevity. Out of the box, invoke it as
`node bin/depx.mjs`.

To get the short form, symlink the entry point onto your `PATH`:

```sh
ln -s "$PWD/bin/depx.mjs" ~/.local/bin/depx    # or any directory on your PATH
depx --version
```

A symlink rather than `npm link`, deliberately: `npm link` would create a
`node_modules` directory in a repository whose entire claim is that it does not
have one.

With that in place, `depx` on its own in a terminal opens the
[interactive interface](#the-interactive-interface); everywhere else it is the
batch report.

---

## Quick start

```
$ node bin/depx.mjs check fixtures/messy

  scanned 4 files in 3 languages
  JavaScript / TypeScript: 2 files, 7 imported packages, 6 declared
  Go: 1 files, 3 imported packages, 3 declared
  Python: 1 files, 5 imported packages, 4 declared

  GHOSTS  imported, but nothing here provides them
    async-retry-utils                   src/app.js:5:34
    json-schema-validator-pro           src/app.js:6:26
    github.com/acme/nonexistent-helper  gosrc/main.go:9:2

  BROKEN  relative imports pointing at nothing
    ./does-not-exist.js  src/app.js:9:25

  PHANTOM  imported and installed, never declared
    ms  src/app.js:7:16

  UNDECLARED  imported but not in the manifest - install tree absent, so unverified
    fastapi_turbo_helpers  pysrc/main.py:5:6
    numpy                  pysrc/main.py:6:8

  REPLACEABLE  the standard library already ships this
    chalk                       -> util.styleText()  (node 20.12)
                                      honours NO_COLOR and TTY detection for you
    minimist                    -> util.parseArgs()  (node 18.3)
                                      strings and booleans only; subcommands are yours
    uuid                        -> crypto.randomUUID()  (node 14.17)
                                      v4 only
    github.com/google/uuid      -> uuid  (go 1.27)
                                      moved into the standard library
    github.com/sirupsen/logrus  -> log/slog  (go 1.21)
    requests                    -> urllib.request  (always)
                                      HTTP/1.1 only, no pooling

  DEAD  declared, never imported
    moment                  declared but no import of it was found
    rimraf                  unused, and fs.rm(path, { recursive: true, force: true }) replaces it anyway
    github.com/gorilla/mux  unused, and net/http ServeMux replaces it anyway
    click                   unused, and argparse replaces it anyway

  3 ghosts / 1 broken / 1 phantom / 2 undeclared / 6 replaceable / 4 dead

  Nothing local provides these, so the build breaks on a clean checkout.
  Check each name against its registry before shipping: one that is not
  there either is a hallucinated import, and that is the slopsquat window.
```

This is unedited output, reproduced verbatim from the fixture in this
repository.

Captured output for every command and every significant case is in
[`snips/`](snips/), generated by `make snips` so it cannot drift from the
tool's actual behaviour. Two are worth reading first: a repository that
[fakes an empty manifest](snips/08-zero-dep-vendored.txt), and a
[realistic application carrying four distinct problems](snips/12-realistic-app.txt).

---

## Usage

```
depx [command] [path] [options]
```

`path` accepts a directory or a single file, and defaults to the current
directory. A single file is analysed against its project's manifest, located
by walking up from the file.

### Commands

| Command | Reports |
|---|---|
| `check [path]` | all findings (default) |
| `tui [path]` | the same findings, browsable — also what bare `depx` opens in a terminal |
| `ghosts [path]` | imports that nothing in the project resolves |
| `phantom [path]` | imports installed but never declared |
| `dead [path]` | declared packages that are never imported |
| `replace [path]` | packages the standard library already provides |
| `vendored [path]` | third-party source copied into the repo rather than installed |
| `zero-dep [path]` | verification against the Zero Dependency rule |
| `langs` | supported languages and their detection tier |

A subcommand's summary and exit code reflect only the findings it was asked
about. `depx replace` will not fail a build over an unrelated ghost.

### Options

| Option | Effect |
|---|---|
| `--lang <ids>` | restrict analysis to a comma-separated list of language ids |
| `--json` | emit machine-readable JSON instead of a report |
| `--no-color` | disable colour (`NO_COLOR` is honoured automatically) |
| `--quiet` | suppress output and rely on the exit code |
| `--help`, `-h` | show usage |
| `--version`, `-v` | print the version |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | no findings in scope |
| `1` | findings requiring attention (ghosts or broken imports) |
| `2` | usage error |

### Continuous integration

The exit code makes `depx` usable as a build gate:

```sh
depx ghosts . --quiet || exit 1
```

`--json` exposes the full result, including warnings, suppressed findings and
any nested projects that were not descended into, so a CI consumer can explain
a surprising outcome without parsing the report.

This repository's own workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml),
runs the four commands a reviewer would run by hand — the test suite, the
zero-dependency self-check, the reproducible build, and `depx` against its own
source — using the runner's Node and installing nothing.

---

## The interactive interface

The report is built to be read once, in CI or in a scrollback buffer. On a
repository with fifty findings it is a wall. `depx tui` renders the same
analysis as a screen you can move around in — and typing `depx` on its own in a
terminal opens it:

```sh
cd your-project
depx
```

```
  depx · messy                                             4 files · 3 langs
  ──────────────────────────────────────────────────────────────────────────
    GHOSTS (3)          │   chalk                            src/app.js:1:19
    BROKEN (1)          │ › minimist                         src/app.js:2:22
    PHANTOM (1)         │   uuid                             src/app.js:3:20
    UNDECLARED (2)      │   github.com/google/uuid         gosrc/main.go:7:2
  ▸ REPLACEABLE (6)     │   github.com/sirupsen/logrus     gosrc/main.go:8:2
    DEAD (4)            │   requests                       pysrc/main.py:2:8
                        │
                        │
                        │
                        │
  ──────────────────────────────────────────────────────────────────────────
  -> util.parseArgs() (node 18.3) strings and booleans only; subcommands are
  yours

  ──────────────────────────────────────────────────────────────────────────
  ↑↓ move   ←→ category   ⏎ open   / filter   q quit
```

| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` | move through the findings in the selected category |
| `←` `→` / `h` `l` / `tab` | change category; the list wraps in both directions |
| `g` / `G` | first / last finding |
| `/` | search — see below |
| `⏎` | open the file at the line in `$VISUAL` or `$EDITOR` |
| `q` / `esc` / `ctrl-c` | quit |

### Search

`/` searches **every category at once**, not the open one. Three things follow
from that, and together they are what makes it a search rather than a filter:

- Typing moves you to wherever the match is. Searching `chalk` from the ghosts
  pane lands on REPLACEABLE, because that is where `chalk` is.
- Every category carries its own share of the matches — `GHOSTS (0/3)`,
  `REPLACEABLE (2/6)` — so the result is visible before you navigate to it, and
  the header counts the total.
- `←` `→` skip the categories the search emptied, so arrowing across walks the
  results instead of stopping on blank panes.

`⏎` keeps the search and returns to the list; `esc` clears it.

### Where it runs

Bare `depx` opens the interface **only when both ends are a terminal**. In a
pipe, a redirect, a CI job, or with `--json` or `--quiet`, it is the batch
report exactly as before — and any explicit subcommand always is. `depx tui`
asked for directly in a pipe exits `2` and names `depx check`.

The rule that decides this is that a script's behaviour must never depend on
where its output is going. Only the no-argument interactive case changes, which
is the one case where a person is definitely watching.

The exit code is the one `depx check` would have returned, so quitting the
interface still answers the question a script would have asked.

### How it is tested

The state machine and the frame renderer are pure functions of `(state, size)`:
`reduce(state, key)` returns the next state, and `renderFrame(state, {cols,
rows})` returns an array of exactly `rows` strings of exactly `cols` display
width. Only `runTui()` touches stdin, stdout or the process.

That split is what makes the interface testable. Forty-three tests drive every
key it responds to and assert on the resulting frames as strings, with no
terminal involved — including that the frame stays exactly the requested size
at four terminal sizes and through every navigation state, that the selected
row is marked without relying on colour, that a search reaches every category
and reports its per-category counts, that the alternate screen is always left
again on the way out, and that bare `depx` in a pipe is still the report.

---

## Findings

| Finding | Meaning | Confidence |
|---|---|---|
| `ghost` | imported, and nothing in the project resolves it | high |
| `broken` | a relative import pointing at no file on disk | high |
| `phantom` | imported and installed, but never declared | high |
| `undeclared` | imported and not declared, with no evidence available to judge further | deliberately low |
| `dead` | declared but never imported | high; annotated where a build tool loads it |
| `replaceable` | declared, used, and available in the standard library | high |

### The ghost / undeclared distinction

An undeclared import can only be judged when the full resolution universe is
visible. That holds in two situations: the manifest is authoritative for the
language (Go will not compile an import absent from `go.mod`), or an install
tree is present on disk to check against. With neither, an undeclared import
may simply be a real package that nobody installed here, and `depx` reports
`undeclared` rather than overstating.

In practice: run `depx` against a repository with its dependencies installed
and the claims are strong. Run it against a bare checkout and it will say so.

An install tree must also contain something. An empty `.venv` directory is a
directory, not evidence, and does not promote anything to a ghost.

### Exclusions

A false ghost is the most damaging error this tool can make: it sends a
developer looking for a supply-chain compromise that does not exist. The
following are therefore excluded before any judgement is made.

| Excluded | Example |
|---|---|
| Modules the repository defines | `mod utils;` beside `src/utils.rs`; `import utils` beside `utils.py` |
| The project's own name | `github.com/you/app/internal/store` under `module github.com/you/app`; a `src/bin/` target importing its own crate; a package importing itself through its `exports` map |
| Subpath imports and bundler aliases | `#internal/x`, `@/components/y`, `~/utils/z`, `$lib/w` |
| Standard library, including names that read like packages | Python's `__future__`, Ruby's `English` |
| Relative paths | checked against the filesystem and reported as `broken` if absent; Ruby's `require_relative` is routed here |

Each exclusion originates in a false positive observed against a real
repository, and each has a corresponding regression test.

### Nested projects

A subdirectory carrying its own manifest is a separate project. `depx` does
not descend into it, since judging its imports against the parent manifest
would produce only noise. The skipped projects are named, because a monorepo
root legitimately contains no source of its own:

```
  scanned 0 files in 0 languages
  2 nested projects not descended into: client, server
  each has its own manifest - run depx inside it to check it
```

Cargo and npm workspaces behave the same way. Run `depx` once per package;
workspace linking is not resolved.

---

## Suppressing findings

Some findings are correct but unwanted: a plugin resolved at runtime, a
package a build step injects, an alias `depx` cannot see. Without a way to
record those decisions, one intentional finding keeps a build red forever and
the tool gets removed from CI rather than argued with.

Create a `.depxignore` file at the project root:

```
# a native addon our build step resolves; the import is deliberate
optional-native-addon

# only the dead finding for this one - still report it if it goes missing
dead:react-dom

# * and ? glob within a name
undeclared:@acme/*
```

| Form | Effect |
|---|---|
| `name` | suppress every finding for that package |
| `type:name` | suppress only that finding type, where `type` is one of the six above |
| `#` | comment; blank lines are ignored |

Only `*` and `?` are special. Everything else in a name — including the `.`,
`-`, `@` and `/` that fill real package names — matches literally, and
matching is anchored at both ends.

**Suppression is never silent.** The number of findings a rule removed is
always reported, and `--json` lists them by name and type, so a reviewer can
audit the suppressions rather than take them on trust:

```
  1 undeclared / 1 dead
  3 findings suppressed by .depxignore
```

A repository whose findings are all suppressed reports `nothing to report
outside .depxignore`, not `clean`.

---

## Language support

Ghost detection depends on mapping an import name to a package name. The
reliability of that mapping varies by language, so support is tiered and the
tool does not claim uniform coverage.

Twelve languages are covered by nine adapters, which is what `depx langs`
lists.

| Tier | Languages | Ghost detection |
|---|---|---|
| 1 | Go, JavaScript / TypeScript, Python | yes |
| 2 | Rust, Ruby | yes, after name normalisation |
| 3 | Java / Kotlin, C#, PHP, C / C++ | no — suppressed by design |

Tier 3 reflects a correctness decision rather than an unimplemented feature.
In Java, `import org.apache.commons.lang3.StringUtils` is satisfied by the
Maven artifact `org.apache.commons:commons-lang3`; the namespace and the
coordinate are unrelated strings, connected only by a mapping held on Maven
Central. Resolving that offline would require shipping the registry index. The
same applies to NuGet, and to Composer's PSR-4 map when `vendor/` is absent. C
and C++ have no dependency manifest at all.

For tier 3, `depx` reports file inventory and declared dependencies, and stays
silent on both `ghost` and `dead` — a coordinate never matches an import
namespace literally, so every declared dependency would otherwise be reported
unused.

---

## Verifying the Zero Dependency rule

`depx zero-dep` verifies both halves of the rule.

```
$ depx zero-dep .

  Zero Dependency rule check

  PASS  package.json  no runtime dependencies

  empty manifest verified, no vendored source detected
```

### Vendored source

An empty manifest is simple to verify and equally simple to fake. The rule
closes the loophole in prose — copying a library into `src/` is "a dependency
with extra steps" — but no tool checks it, because the manifest still reads
`{}`.

The check is also available on its own, because "is there third-party code
pasted into this repository?" is worth asking outside this rule:

```sh
depx vendored .
```

`depx` inspects the source for the traces code carries when it was copied
rather than written: source map comments, bundler-preserved `@license`
pragmas, generated-file banners, UMD wrappers, third-party licence headers,
and line density characteristic of minified output.

```
  REVIEW  source that does not read as hand-written
    src/bundle.js    :2
        carries a source map comment, which a build tool emits and a person does not write
        packs 904 characters onto one line and averages 313 per line, which means minified or bundled output
    src/vendored.js  :3
        carries a full third-party licence header, which is what copied library source looks like

  Signals, not proof. Vendored source must be disclosed in STDLIB.md;
  undisclosed, it scores against you.
```

These are **signals, not a verdict**. The tool cannot know who typed a line
and does not pretend to; it produces a ranked list of files for a human to
review. Because a false accusation is the costlier error, the markers are
selected to be rare in hand-written code, and the test suite asserts that
ordinary source — including an author's own copyright line, an inline SVG
path, and files dense with utility class strings — produces no signal. Across
the eighteen repositories used in testing, nothing hand-written was flagged.

### Missing manifests

The rule requires an empty manifest that is verifiable on sight. A repository
containing source but no manifest at all fails that requirement, and `depx`
names the file to add:

```
  FAIL  requirements.txt  missing  34 Python files present

    add an empty requirements.txt so the empty manifest is verifiable on sight
```

---

## Limitations

These are properties of the design, not defects.

| Limitation | Detail |
|---|---|
| Static analysis only | An import assembled at runtime (`require(process.env.PLUGIN)`) is invisible by construction. |
| No registry verification | `depx` is offline by design. It can report that an import resolves to nothing locally, never that a package exists nowhere. |
| The JavaScript scanner is a lexer | It masks comments, strings, template literals and regex literals, then inspects what precedes each surviving string literal. It handles every import form and decoy in the test suite, but builds no syntax tree and cannot follow re-exports through aliasing. |
| Regex versus division | Resolved with the standard preceding-token heuristic, as real lexers do. Not infallible. |
| Python's alias table is curated | Thirty well-known import-to-distribution aliases (`yaml`→`PyYAML`, `cv2`→`opencv-python`). An unusual alias is reported as undeclared. |
| The TOML reader is a subset | Tables, dotted keys, strings, numbers, booleans, inline tables and multi-line arrays — sufficient for dependency manifests. Arrays of tables and datetimes are not implemented. |
| `.gitignore` support is a subset | The common forms (`*`, `**`, `?`, anchoring, directory-only, negation), not the full specification. |
| Symlinks are not followed | A symlinked source directory is skipped rather than risk traversing a cycle. |
| Large and binary files are skipped | Files above 2 MB or containing a NUL byte, counted in the reported `skipped` total. |
| Vendoring detection is heuristic | It finds copied code that still carries its provenance, not source that has been reformatted and stripped of headers. |
| `dead` does not mean "safe to delete" | A package may be loaded by a framework or named as a string in a build config. Such packages are annotated and sorted last rather than omitted. |

---

## Zero dependencies

`package.json` declares an empty `dependencies` object and there is no
`node_modules` directory. [`STDLIB.md`](STDLIB.md) documents every package
that would conventionally have been installed and the standard-library
facility used in its place.

### Verifying the claim

```sh
make proof                  # regenerates deps-proof.txt
node bin/depx.mjs zero-dep . # the tool's verdict on itself
```

[`deps-proof.txt`](deps-proof.txt) contains the empty manifest, the absence of
`node_modules`, a search for any import that is neither a Node built-in nor
relative, the tool's own verdict, and two matching build hashes.

### Reproducible build

`make dist` inlines the module graph using [`tools/bundle.mjs`](tools/bundle.mjs),
a bundler of roughly 200 lines that is itself dependency-free. The output is
byte-identical across runs:

```
$ make verify
build 1: 63627deaaa5df7524059f295a07566d82d3a1312b66aad39b302e568d545995b
build 2: 63627deaaa5df7524059f295a07566d82d3a1312b66aad39b302e568d545995b
reproducible: byte-identical
bundle matches source tree
```

The final line matters as much as the hashes: `make verify` also compares the
bundle's output against the source tree's, so a build that altered behaviour
would fail even if it hashed consistently.

The hashes above are those of the current commit; `make verify` recomputes
them, and [`deps-proof.txt`](deps-proof.txt) carries the pair recorded at
submission.

---

## Development

### Make targets

| Target | Action |
|---|---|
| `make build` | syntax check and set the executable bit |
| `make test` | run all 217 tests (`node --test`) |
| `make dist` | produce the single-file build |
| `make verify` | build twice, compare hashes, diff behaviour against the source tree |
| `make demo` | paced walkthrough, built to be screen-recorded (`DEMO_PAUSE=0` to run flat) |
| `make snips` | regenerate `snips/` from live runs |
| `make proof` | regenerate `deps-proof.txt` |
| `make clean` | remove generated artefacts |

### Project layout

```
bin/depx.mjs          command-line entry point: argument parsing and dispatch
src/core.mjs          analysis engine: walk, scan, resolve, classify
src/walk.mjs          directory traversal, .gitignore matching, binary detection
src/report.mjs        terminal rendering: colour, width-aware columns, layout
src/tui.mjs           the interactive interface: state machine, frame renderer
src/mask.mjs          shared comment and string masker for non-JavaScript languages
src/toml.mjs          TOML subset reader for Cargo.toml and pyproject.toml
src/vendor.mjs        vendored-source detection
src/substitutions.mjs curated standard-library replacement and tooling tables
src/ignore.mjs        .depxignore rules: parsing, matching, and reporting
src/lang/             one adapter per language, behind a common interface
tools/bundle.mjs      deterministic single-file bundler
tools/snips.sh        regenerates snips/ from live runs
tools/demo.sh         paced walkthrough for recording
test/                 unit and end-to-end suites
fixtures/             a deliberately broken multi-language project
snips/                captured output, one file per scenario
```

Adding a language means adding one module to `src/lang/` and registering it in
`src/lang/index.mjs`.

### Testing

```sh
make test
```

217 tests across 53 suites, using `node:test` and `node:assert/strict` with no
configuration file and no test framework. The resolution, vendoring and CLI
suites construct throwaway projects under `os.tmpdir()` and analyse them end to
end; 81 of those invoke `bin/depx.mjs` as a child process and assert on stdout
and the exit code, exercising the walker, the manifest readers, the report and
the exit codes exactly as a user or CI job would.

Beyond the suite, `depx` was validated against eighteen real repositories,
comprising every public Zero Dependency 2026 submission available on GitHub
together with working Go, Rust, Python, TypeScript and JavaScript projects with
dependency trees installed. It was additionally exercised against generated
projects of 6,000 files (0.70 s), deeply nested trees, CRLF and BOM-prefixed
sources, binary files carrying source extensions, malformed manifests, symlink
cycles, empty virtualenvs, Cargo and npm workspaces, and adversarial scanner
input for each supported language.

That campaign produced twenty-one defects, the majority false positives and
several unsupportable claims. All are fixed, and each has a regression test
named for the case that produced it.

---

## Licence

MIT. See [`LICENSE`](LICENSE).
