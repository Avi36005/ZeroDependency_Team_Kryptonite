# depx

**Dependency x-ray.** Point it at a repository and it tells you the truth about
what your code actually depends on — which is rarely what the manifest claims.

Ten languages. Fully offline. Zero third-party dependencies.

```
$ depx check .

  scanned 4 files in 3 languages
  JavaScript / TypeScript: 2 files, 7 imported packages, 6 declared
  Go: 1 files, 3 imported packages, 3 declared
  Python: 1 files, 5 imported packages, 4 declared

  GHOSTS  imported, but no such package exists
    async-retry-utils                   src/app.js:5:34
    json-schema-validator-pro           src/app.js:6:26
    github.com/acme/nonexistent-helper  gosrc/main.go:9:2

  BROKEN  relative imports pointing at nothing
    ./does-not-exist.js  src/app.js:9:25

  PHANTOM  imported and installed, never declared
    ms  src/app.js:7:16

  REPLACEABLE  the standard library already ships this
    chalk                       -> util.styleText()      (node 20.12)
    minimist                    -> util.parseArgs()      (node 18.3)
    uuid                        -> crypto.randomUUID()   (node 14.17)
    github.com/google/uuid      -> uuid                  (go 1.27)
    github.com/sirupsen/logrus  -> log/slog              (go 1.21)
    requests                    -> urllib.request        (always)

  DEAD  declared, never imported
    moment, rimraf, github.com/gorilla/mux, click

  3 ghosts / 1 broken / 1 phantom / 2 undeclared / 6 replaceable / 4 dead
```

Exit code 1 when ghosts or broken imports are found, so it works as a CI gate.

## Why

Roughly 46% of new code on GitHub is AI-generated, and models invent
dependencies: across 576,000 samples, **19.7% of the packages AI suggested did
not exist**. The invented names repeat, so attackers pre-register them and
wait — a supply-chain attack where the victim never makes a typo.

`depx ghosts` finds those imports while the name is still unclaimed.

It also finds the boring, non-AI version of the same class of bug: an import
that works on your laptop only because something else dragged the package into
your install tree, and breaks the moment CI does a clean checkout.

## Install and run

Requires **Node 22 or newer** (developed and tested on Node 26.7.0). Nothing to
install — there is nothing to install.

```sh
git clone https://github.com/Avi36005/ZeroDependency_Team_Kryptonite
cd ZeroDependency_Team_Kryptonite
make build          # verifies syntax and marks bin/depx.mjs executable
node bin/depx.mjs check /path/to/your/project
```

## Commands

| Command | What it reports |
|---|---|
| `depx check [path]` | everything (default) |
| `depx ghosts [path]` | only imports that resolve to nothing |
| `depx phantom [path]` | only imports installed but never declared |
| `depx dead [path]` | only declared packages never imported |
| `depx replace [path]` | only packages the standard library already ships |
| `depx zero-dep [path]` | verify a repo against the Zero Dependency rule |
| `depx langs` | supported languages and their detection tier |

Options: `--lang <ids>`, `--json`, `--no-color`, `--quiet`, `--help`, `--version`.
Exit codes: `0` clean, `1` findings, `2` usage error.

## What the five findings mean

| Finding | Meaning | Confidence |
|---|---|---|
| **ghost** | imported, and provably resolves to nothing | high — see below |
| **broken** | a relative import pointing at no file on disk | high |
| **phantom** | imported and installed, but never declared | high |
| **undeclared** | imported, not declared, and we could not verify it exists | deliberately low |
| **dead** | declared but never imported | high |
| **replaceable** | declared, used, and the standard library ships an equivalent | high |

The **ghost / undeclared** split is the one design decision worth reading.

An undeclared import is only *provably* a ghost when we can see the whole
resolution universe. That is true in two situations: the manifest is
authoritative for the language (Go will not compile an import missing from
`go.mod`), or an install tree is present on disk to check against. With
neither, an undeclared import might simply be a real package nobody installed
here — so we report `undeclared`, not `ghost`.

The practical consequence: **run `depx` on a repo with its dependencies
installed** and you get strong claims. Run it on a bare checkout and it tells
you honestly that it cannot be sure.

## Language support

Ghost detection requires mapping an import name to a package name. How cleanly
that maps varies by language, so support is tiered and the tool never pretends
otherwise.

| Tier | Languages | Ghost detection |
|---|---|---|
| 1 | Go, JavaScript / TypeScript, Python | yes |
| 2 | Rust, Ruby | yes, after name normalisation |
| 3 | Java / Kotlin, C#, PHP, C / C++ | **no** — suppressed by design |

Tier 3 is a correctness decision, not a missing feature. In Java,
`import org.apache.commons.lang3.StringUtils` is satisfied by the Maven
artifact `org.apache.commons:commons-lang3` — the namespace and the coordinate
are different strings, related only by a mapping that lives on Maven Central.
Resolving that offline would need a shipped copy of the registry index. The
same holds for NuGet, and for Composer's PSR-4 map when `vendor/` is absent.
C and C++ have no dependency manifest at all.

For tier 3, `depx` reports file inventory and declared dependencies and stays
quiet about ghosts. Emitting confident nonsense would be worse than saying
nothing.

## Honest limits

- **Static analysis only.** An import assembled at runtime
  (`require(process.env.PLUGIN)`) is invisible to us, by construction.
- **The JavaScript scanner is a lexer, not a parser.** It masks comments,
  strings, template literals and regex literals, then looks at what precedes
  each surviving string literal. It handles every import form we could think
  of and all of the decoys in `test/scanner.test.mjs`, but it does not build a
  syntax tree, so it cannot follow re-exports through aliasing.
- **Regex-versus-division** is resolved with the standard heuristic on the
  preceding token. This is the same heuristic real lexers use, and it is not
  perfect.
- **Python's import-to-distribution table is curated, not complete.** About 40
  well-known aliases (`yaml`→`PyYAML`, `cv2`→`opencv-python`) are handled. An
  unusual alias will be reported as undeclared.
- **The TOML reader is a subset**: tables, dotted keys, strings, numbers,
  booleans and inline tables. That covers dependency manifests. Arrays of
  tables and datetimes are not implemented.
- **Monorepos**: `depx` analyses one project at a time. A subdirectory that
  declares its own manifest is treated as a project boundary and is not
  descended into, so its imports are never judged against your manifest. Run
  `depx` once per package; workspace linking is not resolved.
- **`.gitignore` support is a subset** of git's matching rules — the common
  forms (`*`, `**`, `?`, anchoring, directory-only, negation), not the whole
  specification.

## Development

```sh
make build     # syntax check + chmod
make test      # node --test, 32 tests
make proof     # regenerate deps-proof.txt
```

## Licence

MIT. See [LICENSE](LICENSE).
