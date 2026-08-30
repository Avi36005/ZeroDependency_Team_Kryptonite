#!/bin/sh
# Regenerate snips/ - captured output, one file per scenario.
#
# Everything under snips/*.txt is produced here, so the folder can never drift
# from what the tool actually prints. Colour is stripped so the files stay
# readable anywhere; run the same command in a terminal to see it in colour.

set -e
cd "$(dirname "$0")/.."

DEPX="node bin/depx.mjs"

# Capture a command with its output and its real exit code.
#
# The status is read through an `if`, not after `|| true`: `|| true` would
# make every snip claim it exited 0, which is precisely the thing these files
# are meant to prove. The `if` also keeps `set -e` from aborting on the
# non-zero exits that several of these scenarios are supposed to produce.
snip() {
  file="snips/$1"
  shift
  if $DEPX "$@" --no-color >/dev/null 2>&1; then status=0; else status=$?; fi
  {
    printf '$ depx %s\n' "$*"
    $DEPX "$@" --no-color 2>&1 || true
    printf '$ echo $?\n%s\n' "$status"
  } >"$file"
  printf '  %-36s exit %s\n' "$file" "$status"
}

snip 01-check.txt check fixtures/messy
snip 02-ghosts.txt ghosts fixtures/messy
snip 03-replace.txt replace fixtures/messy
snip 04-dead.txt dead fixtures/messy
snip 05-phantom.txt phantom fixtures/messy
snip 06-zero-dep-pass.txt zero-dep .
snip 07-langs.txt langs
snip 08-zero-dep-vendored.txt zero-dep snips/fixtures/faked-zero-dep
snip 10-monorepo.txt check snips/fixtures/monorepo
snip 11-help.txt --help
snip 12-realistic-app.txt check snips/fixtures/realistic-app
snip 13-single-file.txt check fixtures/messy/src/app.js
snip 19-depxignore.txt check snips/fixtures/suppressed

# The no-manifest case has to be a Python file with no requirements.txt.
# Committing one would make this repo fail its own zero-dep check, so it is
# built in a temp directory and thrown away.
TMP=$(mktemp -d)/no-manifest
mkdir -p "$TMP"
printf 'import os\nimport sys\n\nprint(os.getcwd())\n' >"$TMP/tool.py"
if $DEPX zero-dep "$TMP" --no-color >/dev/null 2>&1; then status=0; else status=$?; fi
{
  printf '$ depx zero-dep .\n'
  $DEPX zero-dep "$TMP" --no-color 2>&1 | sed "s|$TMP|.|g" || true
  printf '$ echo $?\n%s\n' "$status"
} >snips/09-zero-dep-no-manifest.txt
rm -rf "$(dirname "$TMP")"
printf '  %-36s exit %s\n' 'snips/09-zero-dep-no-manifest.txt' "$status"

{
  printf '$ depx check fixtures/messy --json | head -40\n'
  $DEPX check fixtures/messy --json | head -40
  printf '...\n'
} >snips/14-json.txt
printf '  snips/14-json.txt\n'

# 6,000 files, generated fresh so the timing is honest.
PERF=$(mktemp -d)
python3 - "$PERF" <<'PY'
import os, sys
root = sys.argv[1]
open(f'{root}/package.json', 'w').write('{"dependencies":{"react":"^18"}}')
for i in range(3000):
    d = f'{root}/src/mod{i // 100}'
    os.makedirs(d, exist_ok=True)
    open(f'{d}/file{i}.js', 'w').write(
        "import React from 'react';\n"
        f"import helper from './helper{i}';\n"
        "const re = /not an import 'x'/g;\n"
        "// import 'commented';\n"
        "const s = `template ${1/2} literal`;\n"
        + f"export const x{i} = 1;\n" * 20)
    open(f'{d}/helper{i}.js', 'w').write("export default 1;\n")
PY
START=$(python3 -c 'import time; print(time.time())')
OUT=$($DEPX check "$PERF" --no-color 2>&1 || true)
ELAPSED=$(python3 -c "import time; print(f'{time.time()-$START:.2f}')")
{
  printf '# 6,000 generated files, each carrying a real import, a relative\n'
  printf '# import, and three decoys (regex, comment, template literal).\n\n'
  printf '$ find . -name "*.js" | wc -l\n6000\n\n'
  printf '$ time depx check .\n'
  printf '%s\n' "$OUT" | sed "s|$PERF|.|g"
  printf '\nreal\t0m%ss\n' "$ELAPSED"
} >snips/15-performance.txt
rm -rf "$PERF"
printf '  snips/15-performance.txt\n'

{
  printf '$ make verify\n'
  make --no-print-directory verify 2>&1 || true
  printf '\n$ shasum -a 256 dist/depx.mjs\n'
  shasum -a 256 dist/depx.mjs
  printf '\n$ wc -l dist/depx.mjs\n'
  wc -l dist/depx.mjs | awk '{print $1, $2}'
  printf '\n$ grep -c "^import .*node:" dist/depx.mjs   # every import is a builtin\n'
  grep -c "^import .*node:" dist/depx.mjs
} >snips/16-reproducible-build.txt
printf '  snips/16-reproducible-build.txt\n'

{
  printf '$ make test\n'
  make --no-print-directory test 2>&1 | tail -26
} >snips/17-test-suite.txt
printf '  snips/17-test-suite.txt\n'

{
  printf '$ cat deps-proof.txt\n\n'
  cat deps-proof.txt
} >snips/18-deps-proof.txt
printf '  snips/18-deps-proof.txt\n'
