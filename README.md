# depx

**A dependency x-ray for twelve languages, with no dependencies of its own.**

`depx` reads a repository's source and its manifest, and reports where the two
disagree: imports that resolve to nothing, packages installed but never
declared, dependencies declared but never used, and dependencies the standard
library already provides.

It runs entirely offline, requires no installation, and has an empty
dependency manifest.

---

## Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
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

Large language models invent dependencies. A 2025 USENIX Security study of
576,000 generated code samples found that **19.7% of the packages the models
recommended did not exist**. The invented names repeat, so an attacker can
register them in advance and wait — a supply-chain attack in which the victim
never makes a typo.

The same class of defect predates AI. An import can work locally only because
another package dragged its dependency into the install tree, then fail the
moment CI performs a clean checkout.

Both are cases of source and manifest disagreeing, and both are visible
statically.

### What depx does

`depx` scans a project's source files, extracts every import specifier, and
resolves each against the manifest and the install tree. It reports six kinds
of disagreement, each labelled with the confidence the available evidence
supports.

It also verifies a repository against the Zero Dependency rule — an empty
runtime manifest — including the half of that rule a manifest cannot show:
whether the source was written or copied.

### Scope of its claims

`depx` performs static analysis against local evidence only. It can establish
that an import resolves to nothing **in the project being analysed**. It
cannot establish that a package does not exist anywhere, because that would
require a copy of the registry index — precisely the kind of dependency this
tool exists without.

Findings are therefore worded to match the evidence. Where a name looks
invented, `depx` reports that nothing local provides it and leaves the
registry lookup to the reader.

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

This document writes `depx` for brevity. Unless the executable is linked onto
`PATH` with `npm link`, invoke it as `node bin/depx.mjs`.

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
| `ghosts [path]` | imports that nothing in the project resolves |
| `phantom [path]` | imports installed but never declared |
| `dead [path]` | declared packages that are never imported |
| `replace [path]` | packages the standard library already provides |
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

`depx` therefore inspects the source for the traces code carries when it was
copied rather than written: source map comments, bundler-preserved `@license`
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
build 1: b9f58e2ab18ecd14ce38236f7b559327446691a1bc24560ce0884e46ff5d6865
build 2: b9f58e2ab18ecd14ce38236f7b559327446691a1bc24560ce0884e46ff5d6865
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
| `make test` | run the full suite (`node --test`) |
| `make dist` | produce the single-file build |
| `make verify` | build twice, compare hashes, diff behaviour against the source tree |
| `make snips` | regenerate `snips/` from live runs |
| `make proof` | regenerate `deps-proof.txt` |
| `make clean` | remove generated artefacts |

### Project layout

```
bin/depx.mjs          command-line entry point: argument parsing and dispatch
src/core.mjs          analysis engine: walk, scan, resolve, classify
src/walk.mjs          directory traversal, .gitignore matching, binary detection
src/report.mjs        terminal rendering: colour, width-aware columns, layout
src/mask.mjs          shared comment and string masker for non-JavaScript languages
src/toml.mjs          TOML subset reader for Cargo.toml and pyproject.toml
src/vendor.mjs        vendored-source detection
src/substitutions.mjs curated standard-library replacement and tooling tables
src/ignore.mjs        .depxignore rules: parsing, matching, and reporting
src/lang/             one adapter per language, behind a common interface
tools/bundle.mjs      deterministic single-file bundler
tools/snips.sh        regenerates snips/ from live runs
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

170 tests across 45 suites, using `node:test` and `node:assert/strict` with no
configuration file and no test framework. The resolution, vendoring and CLI
suites construct throwaway projects under `os.tmpdir()` and analyse them end to
end; 77 of those invoke `bin/depx.mjs` as a child process and assert on stdout
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
