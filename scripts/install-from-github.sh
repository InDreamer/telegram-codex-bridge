#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="InDreamer"
REPO_NAME="telegram-codex-bridge"
REF="master"
REF_TYPE="branch"
TELEGRAM_TOKEN=""
CODEX_BIN=""
PROJECT_SCAN_ROOTS=""
WORKDIR=""

usage() {
  cat <<'EOF'
Usage:
  install-from-github.sh --telegram-token <token> [--codex-bin <path>] [--project-scan-roots <path1:path2:...>] [--ref <name>] [--ref-type branch|tag]
EOF
}

if [[ "${1:-}" == "--windows-help" ]]; then
  cat <<'EOF'
Windows entry:
  powershell -ExecutionPolicy Bypass -File scripts/install-from-github.ps1 -TelegramToken "<token>" [-CodexBin "<path>"] [-ProjectScanRoots "<path1;path2;...>"] [-Ref <name>] [-RefType branch|tag]
EOF
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --telegram-token)
      TELEGRAM_TOKEN="${2:-}"
      shift 2
      ;;
    --codex-bin)
      CODEX_BIN="${2:-}"
      shift 2
      ;;
    --project-scan-roots)
      PROJECT_SCAN_ROOTS="${2:-}"
      shift 2
      ;;
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --ref-type)
      REF_TYPE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TELEGRAM_TOKEN" ]]; then
  echo "missing --telegram-token" >&2
  usage >&2
  exit 1
fi

for cmd in curl tar node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required" >&2
    exit 1
  fi
done

if ! node - <<'NODE'
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const supported = major > 24 || (major === 24 && (minor > 0 || (minor === 0 && patch >= 0)));
process.exit(supported ? 0 : 1);
NODE
then
  echo "Node >=24.0.0 is required; found $(node -v)" >&2
  exit 1
fi

case "$REF_TYPE" in
  branch)
    ARCHIVE_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REF}"
    ;;
  tag)
    ARCHIVE_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/tags/${REF}"
    ;;
  *)
    echo "invalid --ref-type: ${REF_TYPE}" >&2
    exit 1
    ;;
esac

WORKDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

curl -fsSL "$ARCHIVE_URL" | tar -xzf - -C "$WORKDIR"
SOURCE_DIR="$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

cd "$SOURCE_DIR"
npm install
npm run build

INSTALL_CMD=(node dist/cli.js install --telegram-token "$TELEGRAM_TOKEN")
if [[ -n "$CODEX_BIN" ]]; then
  INSTALL_CMD+=(--codex-bin "$CODEX_BIN")
fi
if [[ -n "$PROJECT_SCAN_ROOTS" ]]; then
  INSTALL_CMD+=(--project-scan-roots "$PROJECT_SCAN_ROOTS")
fi

env \
  CTB_INSTALL_SOURCE_KIND=github-archive \
  CTB_INSTALL_SOURCE_REPO_OWNER="$REPO_OWNER" \
  CTB_INSTALL_SOURCE_REPO_NAME="$REPO_NAME" \
  CTB_INSTALL_SOURCE_REF="$REF" \
  CTB_INSTALL_SOURCE_REF_TYPE="$REF_TYPE" \
  "${INSTALL_CMD[@]}"
