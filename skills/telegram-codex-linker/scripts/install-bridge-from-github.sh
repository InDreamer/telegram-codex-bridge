#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="InDreamer"
REPO_NAME="telegram-codex-bridge"
REF="master"
REF_TYPE="branch"
TELEGRAM_TOKEN=""
CODEX_BIN=""
WORKDIR=""

usage() {
  cat <<'EOF'
Usage:
  install-bridge-from-github.sh --telegram-token <token> [--codex-bin <path>] [--ref <name>] [--ref-type branch|tag]
EOF
}

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

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 25 ]]; then
  echo "Node >=25 is required; found $(node -v)" >&2
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

"${INSTALL_CMD[@]}"
