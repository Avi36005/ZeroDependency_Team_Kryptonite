.PHONY: build test dist verify proof snips demo clean

build:
	@node --check bin/depx.mjs && chmod +x bin/depx.mjs
	@echo "built: ./bin/depx.mjs"

test:
	@node --test

# Single-file build. tools/bundle.mjs inlines the module graph; the output is
# byte-identical across runs, which `make verify` proves.
dist:
	@node tools/bundle.mjs
	@node --check dist/depx.mjs
	@chmod +x dist/depx.mjs
	@shasum -a 256 dist/depx.mjs

# Reproducible-build proof: build twice from a clean slate, compare hashes,
# then check the bundle behaves exactly like the source tree.
verify:
	@node tools/bundle.mjs >/dev/null
	@shasum -a 256 dist/depx.mjs | cut -d' ' -f1 > .hash1
	@rm -f dist/depx.mjs
	@node tools/bundle.mjs >/dev/null
	@shasum -a 256 dist/depx.mjs | cut -d' ' -f1 > .hash2
	@echo "build 1: $$(cat .hash1)"
	@echo "build 2: $$(cat .hash2)"
	@if cmp -s .hash1 .hash2; then echo "reproducible: byte-identical"; \
	 else echo "NOT reproducible"; rm -f .hash1 .hash2; exit 1; fi
	@rm -f .hash1 .hash2
	@node bin/depx.mjs check fixtures/messy --no-color > .out1 2>&1 || true
	@node dist/depx.mjs check fixtures/messy --no-color > .out2 2>&1 || true
	@if cmp -s .out1 .out2; then echo "bundle matches source tree"; \
	 else echo "bundle DIVERGES from source"; rm -f .out1 .out2; exit 1; fi
	@rm -f .out1 .out2

proof:
	@echo '$$ cat package.json | grep -A1 dependencies' > deps-proof.txt
	@grep -A1 '"dependencies"' package.json >> deps-proof.txt
	@echo >> deps-proof.txt
	@echo '$$ ls node_modules' >> deps-proof.txt
	@ls node_modules 2>&1 | head -1 >> deps-proof.txt
	@echo >> deps-proof.txt
	@echo '$$ grep -rn "from '"'"'[^n.]" bin src tools   # any import not node: and not relative' >> deps-proof.txt
	@grep -rnE "from '\''[^n.]" bin src tools >> deps-proof.txt 2>&1 || echo '(no matches - every import is node: or relative)' >> deps-proof.txt
	@echo >> deps-proof.txt
	@echo '$$ node bin/depx.mjs zero-dep .' >> deps-proof.txt
	@node bin/depx.mjs zero-dep . --no-color >> deps-proof.txt 2>&1 || true
	@echo >> deps-proof.txt
	@echo '$$ make verify   # reproducible build' >> deps-proof.txt
	@$(MAKE) --no-print-directory verify >> deps-proof.txt 2>&1 || true
	@cat deps-proof.txt

# A paced walkthrough, built to be screen-recorded. DEMO_PAUSE=0 to run flat.
demo:
	@sh tools/demo.sh

# Regenerate snips/ - captured output, one file per scenario.
snips:
	@sh tools/snips.sh

clean:
	@rm -f deps-proof.txt .hash1 .hash2 .out1 .out2
	@rm -rf dist
