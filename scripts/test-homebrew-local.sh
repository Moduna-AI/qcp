#!/usr/bin/env bash
set -euo pipefail

FORMULA_NAME="qcp-local"
CLASS_NAME="QcpLocal"
TAP_USER="qcp"
TAP_REPO="local"
TAP_NAME="${TAP_USER}/${TAP_REPO}"
HOMEPAGE="https://github.com/Moduna-AI/qcp"
VERSION=$(node -p "require('./package.json').version")

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_BIN="${ROOT_DIR}/dist/qcp"
TAP_DIR="$(brew --repository)/Library/Taps/${TAP_USER}/homebrew-${TAP_REPO}"
FORMULA_DIR="${TAP_DIR}/Formula"
FORMULA_PATH="${FORMULA_DIR}/${FORMULA_NAME}.rb"

cd "$ROOT_DIR"

echo "==> Cleaning old dist"
rm -rf dist
mkdir -p dist

echo "==> Installing dependencies"
bun install

echo "==> Building binary"
bun build ./src/cli/index.ts --compile --outfile "$DIST_BIN"

chmod +x "$DIST_BIN"

echo "==> Testing raw binary"
"$DIST_BIN" --version
"$DIST_BIN" --help >/dev/null

LOCAL_SHA="$(shasum -a 256 "$DIST_BIN" | awk '{print $1}')"

echo "==> Ensuring local tap exists"
if ! brew tap | grep -qx "${TAP_NAME}"; then
  brew tap-new "${TAP_NAME}"
fi

mkdir -p "$FORMULA_DIR"

echo "==> Writing formula: $FORMULA_PATH"
cat > "$FORMULA_PATH" <<EOF
class ${CLASS_NAME} < Formula
  desc "AI-powered CLI for querying PostgreSQL in natural language"
  homepage "${HOMEPAGE}"
  url "file://${DIST_BIN}"
  sha256 "${LOCAL_SHA}"
  version "${VERSION}"
  license "MIT"

  def install
    bin.install "qcp"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/qcp --version")
    assert_match "Query Companion", shell_output("#{bin}/qcp --help")
  end
end
EOF

echo "==> Reinstalling with Homebrew"
brew uninstall "${FORMULA_NAME}" 2>/dev/null || true
brew cleanup -s "${FORMULA_NAME}" 2>/dev/null || true
brew install --build-from-source "${TAP_NAME}/${FORMULA_NAME}"

echo "==> Verifying installed binary"
INSTALLED_BIN="$(which qcp)"

echo "Installed at: $INSTALLED_BIN"

"$INSTALLED_BIN" --version
"$INSTALLED_BIN" --help >/dev/null

echo "==> Comparing hashes"
echo "Local:     $(shasum -a 256 "$DIST_BIN" | awk '{print $1}')"
echo "Installed: $(shasum -a 256 "$INSTALLED_BIN" | awk '{print $1}')"

if [[ "$(shasum -a 256 "$DIST_BIN" | awk '{print $1}')" != "$(shasum -a 256 "$INSTALLED_BIN" | awk '{print $1}')" ]]; then
  echo "ERROR: Installed binary does not match dist/qcp"
  exit 1
fi

echo "✅ Homebrew local distribution test passed"