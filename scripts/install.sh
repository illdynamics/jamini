#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# Jamini Installer — curl | bash oneliner
# ───────────────────────────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/illdynamics/jamini/main/scripts/install.sh | bash
#
# Downloads the release zip matching the version in VERSION, extracts
# it, and runs ./jamini install.
#
# One source of truth: the VERSION file at the repo root.
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="illdynamics/jamini"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"
TMP_DIR=""

# ── Cleanup on exit ──────────────────────────────────────────────

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

# ── Colors ───────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${GREEN}→${RESET} ${BOLD}$*${RESET}"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
error() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

# ── Detect platform ──────────────────────────────────────────────

detect_platform() {
  case "$(uname -s)" in
    Linux)  echo "linux" ;;
    Darwin) echo "macos" ;;
    *)      error "Unsupported platform: $(uname -s). Jamini supports Linux and macOS." ;;
  esac
}

# ── Check prerequisites ──────────────────────────────────────────

check_prereqs() {
  local missing=()

  if ! command -v curl &>/dev/null; then
    missing+=("curl")
  fi
  if ! command -v unzip &>/dev/null; then
    missing+=("unzip")
  fi
  if ! command -v podman &>/dev/null && ! command -v docker &>/dev/null; then
    warn "Neither podman nor docker found. You'll need one to build the image."
    warn "  Install: brew install podman (macOS) or apt install podman (Linux)"
    echo ""
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required tools: ${missing[*]}. Install them and try again."
  fi
}

# ── Get version from VERSION file ────────────────────────────────
# One source of truth — reads VERSION from the default branch.

get_version() {
  local ver
  ver=$(curl -fsSL "${RAW_BASE}/VERSION" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "${ver}" ]]; then
    error "Could not read VERSION from ${RAW_BASE}/VERSION"
  fi

  echo "${ver}"
}

# ── Main ─────────────────────────────────────────────────────────

main() {
  local platform
  platform=$(detect_platform)

  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║       Jamini Installer (${platform})        ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
  echo ""

  check_prereqs

  # Read version from VERSION file on the default branch
  info "Fetching version..."
  local tag
  tag=$(get_version)
  info "Version: ${tag}"

  # Download and extract
  TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t jamini-install)
  local archive_url="https://github.com/${REPO}/releases/download/${tag}/jamini-${tag}.zip"
  local archive="${TMP_DIR}/jamini-${tag}.zip"

  info "Downloading jamini-${tag}.zip..."
  curl -fsSL "${archive_url}" -o "${archive}" || \
    error "Failed to download ${archive_url}"

  info "Extracting..."
  unzip -q "${archive}" -d "${TMP_DIR}" || \
    error "Failed to extract archive"

  # Run ./jamini install
  local extract_dir="${TMP_DIR}/jamini-${tag}"
  if [[ ! -d "${extract_dir}" ]]; then
    # Try to find the extracted directory
    extract_dir=$(find "${TMP_DIR}" -maxdepth 2 -name "jamini" -type f | head -1)
    if [[ -z "${extract_dir}" ]]; then
      error "Could not find ./jamini in extracted archive"
    fi
    extract_dir=$(dirname "${extract_dir}")
  fi

  info "Installing Jamini..."
  cd "${extract_dir}"
  chmod +x jamini
  ./jamini install
}

main "$@"

