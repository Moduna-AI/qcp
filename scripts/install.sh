#!/usr/bin/env bash
# qcp installer for Linux and macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.sh | sh

set -e

QCP_VERSION="${QCP_VERSION:-latest}"
INSTALL_DIR="${QCP_INSTALL_DIR:-$HOME/.local/bin}"
REPO="Moduna-AI/qcp"
BINARY_NAME="qcp"

# ── Colors ─────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}  →${RESET} %s\n" "$1"; }
success() { printf "${GREEN}  ✓${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}  ⚠${RESET} %s\n" "$1"; }
error()   { printf "${RED}  ✗${RESET} %s\n" "$1" >&2; exit 1; }

# ── Detect OS and architecture ─────────────────────────────────────────────────

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux"  ;;
    Darwin*) os="macos"  ;;
    *)       error "Unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch="x64"   ;;
    arm64  | aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
  esac

  echo "${os}-${arch}"
}

# ── Resolve version ────────────────────────────────────────────────────────────

resolve_version() {
  if [ "$QCP_VERSION" = "latest" ]; then
    info "Fetching latest release..."
    if command -v curl >/dev/null 2>&1; then
      QCP_VERSION=$(curl -fsSL \
        "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name":' \
        | sed -E 's/.*"v([^"]+)".*/\1/')
    elif command -v wget >/dev/null 2>&1; then
      QCP_VERSION=$(wget -qO- \
        "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name":' \
        | sed -E 's/.*"v([^"]+)".*/\1/')
    else
      error "curl or wget is required to install qcp"
    fi

    if [ -z "$QCP_VERSION" ]; then
      error "Could not determine the latest qcp version"
    fi
  fi
  success "Installing qcp v${QCP_VERSION}"
}

# ── Download binary ────────────────────────────────────────────────────────────

download_binary() {
  local platform="$1"
  local download_url="https://github.com/${REPO}/releases/download/v${QCP_VERSION}/qcp-${platform}"
  local tmp_file=$(mktemp)

  info "Downloading qcp-${platform}..."

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --progress-bar "$download_url" -o "$tmp_file" || \
      error "Download failed from: $download_url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$download_url" -O "$tmp_file" || \
      error "Download failed from: $download_url"
  else
    error "curl or wget is required"
  fi

  echo "$tmp_file"
}

# ── Install ────────────────────────────────────────────────────────────────────

install_binary() {
  local tmp_file="$1"

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  local target="${INSTALL_DIR}/${BINARY_NAME}"

  # Move and set permissions
  mv "$tmp_file" "$target"
  chmod +x "$target"

  success "Installed qcp to ${target}"
}

# ── PATH check ─────────────────────────────────────────────────────────────────

check_path() {
  if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
    warn "${INSTALL_DIR} is not in your PATH"
    echo ""
    echo "  Add this to your shell config (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
  else
    success "${INSTALL_DIR} is in PATH"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

main() {
  printf "\n${BOLD}  qcp — Query Companion${RESET}\n\n"

  # Check for existing installation
  if command -v qcp >/dev/null 2>&1; then
    existing=$(qcp --version 2>/dev/null | head -1 || echo "unknown")
    info "Existing installation found: ${existing}"
  fi

  local platform
  platform=$(detect_platform)
  info "Detected platform: ${platform}"

  resolve_version

  local tmp_file
  tmp_file=$(download_binary "$platform")

  install_binary "$tmp_file"
  check_path

  echo ""
  success "qcp v${QCP_VERSION} installed!"
  echo ""
  echo "  Get started:"
  echo ""
  echo "    qcp init"
  echo "    qcp auth"
  echo "    qcp connect"
  echo "    qcp schema scan"
  echo "    qcp ask \"What were our top customers?\""
  echo ""
  echo "  Docs: https://github.com/Moduna-AI/qcp"
  echo ""
}

main "$@"
