.PHONY: build test proof clean

build:
	@node --check bin/depx.mjs && chmod +x bin/depx.mjs
	@echo "built: ./bin/depx.mjs"

test:
	@node --test

proof:
	@echo '$$ cat package.json | grep -A1 dependencies' > deps-proof.txt
	@grep -A1 '"dependencies"' package.json >> deps-proof.txt
	@echo >> deps-proof.txt
	@echo '$$ ls node_modules' >> deps-proof.txt
	@ls node_modules 2>&1 | head -1 >> deps-proof.txt
	@echo >> deps-proof.txt
	@echo '$$ node bin/depx.mjs zero-dep .' >> deps-proof.txt
	@node bin/depx.mjs zero-dep . >> deps-proof.txt 2>&1 || true
	@cat deps-proof.txt

clean:
	@rm -f deps-proof.txt
