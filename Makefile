.PHONY: dev build build-binary build-all test lint clean install-local \
        brew-local brew-tap-local release-dry docker-test help

# ─── Variables ─────────────────────────────────────────────────────────────────

VERSION := $(shell node -p "require('./package.json').version")
BINARY   := dist/qcp
NODE_BIN := dist/qcp.js
SRC      := src/cli/index.ts

# ─── Help ──────────────────────────────────────────────────────────────────────

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?##"}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ─── Development ───────────────────────────────────────────────────────────────

dev:  ## Run qcp in development mode
	bun run $(SRC) $(ARGS)

test:  ## Run all tests
	bun test

test-watch:  ## Run tests in watch mode
	bun test --watch

lint:  ## Type-check with TypeScript
	bunx tsc --noEmit

# ─── Build ─────────────────────────────────────────────────────────────────────

build:  ## Build Node.js bundle (for npm distribution)
	@mkdir -p dist
	bun build $(SRC) --target=node --outfile=$(NODE_BIN)
	@echo '#!/usr/bin/env node' | cat - $(NODE_BIN) > dist/tmp && mv dist/tmp $(NODE_BIN)
	@chmod +x $(NODE_BIN)
	@echo "  ✓ Built dist/qcp.js (Node.js bundle)"

build-binary:  ## Build self-contained binary for current platform
	@mkdir -p dist
	bun build $(SRC) --compile --outfile=$(BINARY)
	@chmod +x $(BINARY)
	@echo "  ✓ Built $(BINARY)"

build-linux-x64:  ## Build Linux x64 binary
	@mkdir -p dist
	bun build $(SRC) --compile --target=bun-linux-x64 --outfile=dist/qcp-linux-x64
	@echo "  ✓ Built dist/qcp-linux-x64"

build-linux-arm64:  ## Build Linux arm64 binary
	@mkdir -p dist
	bun build $(SRC) --compile --target=bun-linux-arm64 --outfile=dist/qcp-linux-arm64
	@echo "  ✓ Built dist/qcp-linux-arm64"

build-all:  ## Build all platform binaries
	@mkdir -p dist
	@echo "Building all platform binaries..."
	$(MAKE) build
	$(MAKE) build-binary
	$(MAKE) build-linux-x64
	$(MAKE) build-linux-arm64
	@echo ""
	@ls -lh dist/
	@echo ""
	@echo "  ✓ All binaries built"

# ─── Checksums ─────────────────────────────────────────────────────────────────

checksums:  ## Generate SHA256 checksums for dist binaries
	@cd dist && sha256sum qcp-* > checksums.txt && cat checksums.txt

# ─── Local install / test ──────────────────────────────────────────────────────

install-local: build-binary  ## Install binary to /usr/local/bin (requires sudo)
	@echo "Installing qcp to /usr/local/bin..."
	@sudo cp $(BINARY) /usr/local/bin/qcp
	@echo "  ✓ Installed: $$(which qcp)"
	@qcp --version

uninstall-local:  ## Remove local binary installation
	@sudo rm -f /usr/local/bin/qcp
	@echo "  ✓ Uninstalled qcp"

# ─── Homebrew local testing ────────────────────────────────────────────────────

brew-tap-local:  ## Tap formula from current directory (for local testing)
	@echo "Tapping Moduna-AI/qcp from current directory..."
	brew tap Moduna-AI/qcp "$(PWD)"
	@echo "  ✓ Tapped. Run: brew install --HEAD Moduna-AI/qcp/qcp"

brew-install-local: brew-tap-local  ## Install via Homebrew from local tap (builds from source)
	brew install --HEAD Moduna-AI/qcp/qcp
	@echo "  ✓ Installed via Homebrew"
	@qcp --version

brew-uninstall:  ## Uninstall local Homebrew tap
	-brew uninstall Moduna-AI/qcp/qcp 2>/dev/null
	-brew untap Moduna-AI/qcp 2>/dev/null
	@echo "  ✓ Homebrew tap removed"

# ─── Release ───────────────────────────────────────────────────────────────────

release-dry:  ## Dry-run: show what would be released
	@echo "  Version: $(VERSION)"
	@echo "  Tag:     v$(VERSION)"
	@echo ""
	@echo "  To release:"
	@echo "    git tag v$(VERSION)"
	@echo "    git push origin v$(VERSION)"

tag:  ## Create and push a release tag (usage: make tag VERSION=0.2.0)
	@[ "$(VERSION)" ] || ( echo "usage: make tag VERSION=x.y.z" && exit 1 )
	@echo "Tagging v$(VERSION)..."
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
	@echo "  ✓ Tag pushed. Release workflow will start shortly."

# ─── Clean ─────────────────────────────────────────────────────────────────────

clean:  ## Remove all build artifacts
	rm -rf dist/
	rm -f qcp-support.zip
	@echo "  ✓ Cleaned"

clean-all: clean  ## Remove build artifacts and installed packages
	rm -rf node_modules/
	@echo "  ✓ node_modules removed"

# ─── CI simulation ─────────────────────────────────────────────────────────────

ci: lint test build  ## Run the full CI pipeline locally
	@echo ""
	@echo "  ✓ CI pipeline passed"

# ─── Default ───────────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help
