#!/bin/sh
# A paced walkthrough, built to be screen-recorded.
#
# Seven beats, covering what the submission asks a demo to show - the tool
# working, and the manifest being empty - in the order that makes the argument
# rather than the order the code is written in.
#
# The commands take about four seconds in total, so DEMO_PAUSE sets the
# runtime: 2 is roughly 25s, 6 is roughly 65s, both leaving room to narrate
# over them inside a five-minute video. Beat 7 is the interactive interface
# and waits for you to quit it - unless there is no terminal or DEMO_PAUSE=0,
# where it is skipped, so a CI dry run can never hang.
#
#   DEMO_PAUSE=0 sh tools/demo.sh    # no pauses, for CI or a quick check
#   DEMO_PAUSE=4 sh tools/demo.sh    # slower, if you narrate as you go

set -e
cd "$(dirname "$0")/.."

PAUSE="${DEMO_PAUSE-2}"
DEPX="node bin/depx.mjs"

# Colour only when attached to a terminal, so a piped run stays clean.
if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
else B=''; D=''; R=''; fi

beat() {
  printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$D" "$R"
  printf '%s%s%s\n' "$B" "$1" "$R"
  [ -n "$2" ] && printf '%s%s%s\n' "$D" "$2" "$R"
  printf '\n'
}

run() {
  printf '%s$ %s%s\n\n' "$D" "$1" "$R"
  # Demo commands legitimately exit non-zero when they find things.
  sh -c "$1" || true
  [ "$PAUSE" = "0" ] || sleep "$PAUSE"
}

beat "depx — a dependency x-ray with no dependencies" \
     "Team Kryptonite · Zero Dependency 2026 · Track A"

beat "1. The manifest is empty." \
     "Nothing is installed. There is nothing to install."
run "cat package.json"
run "ls node_modules 2>&1 | head -1"

beat "2. Point it at a project and it reads the source, not the manifest." \
     "Six kinds of disagreement between what the code imports and what the project declares."
run "$DEPX check fixtures/messy"

beat "3. Models invent packages. This is what that looks like." \
     "Nothing local resolves these, so the build breaks on a clean checkout."
run "$DEPX ghosts fixtures/messy"

beat "4. An empty manifest is easy to verify — and easy to fake." \
     "This repository declares {} and passes. Its src/ tells a different story."
run "cat snips/fixtures/faked-zero-dep/package.json"
run "$DEPX vendored snips/fixtures/faked-zero-dep"

beat "5. The tool on itself." \
     "Empty manifest, no vendored source, every import resolving."
run "$DEPX zero-dep ."
run "$DEPX check ."

beat "6. The receipts." \
     "237 tests, and a single-file build that is byte-identical across runs."
run "make test 2>&1 | grep -E '^. (tests|suites|pass|fail) '"
run "make verify"

beat "7. The same findings, as a screen you can move around in." \
     "Arrow keys, a live filter, \$EDITOR on Enter - and no ink, blessed or enquirer."
# Interactive by definition, so it only runs when a person is watching:
# DEMO_PAUSE=0 is the CI path, and a pipe has no terminal to hand over.
if [ -t 0 ] && [ -t 1 ] && [ "$PAUSE" != "0" ]; then
  printf '%s$ depx tui fixtures/messy%s\n' "$D" "$R"
  printf '%s  (arrow keys to look around, q when you are done)%s\n\n' "$D" "$R"
  sleep 1
  $DEPX tui fixtures/messy || true
else
  printf '%s$ depx tui fixtures/messy%s\n\n' "$D" "$R"
  printf '%s  needs a terminal - run it yourself to see it%s\n' "$D" "$R"
fi

beat "Twelve languages, fully offline, zero third-party dependencies." \
     "github.com/Avi36005/ZeroDependency_Team_Kryptonite"
