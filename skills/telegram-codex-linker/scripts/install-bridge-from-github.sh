#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="InDreamer"
REPO_NAME="telegram-codex-bridge"
REF="master"
REF_TYPE="branch"
TELEGRAM_TOKEN=""
CODEX_BIN=""
PROJECT_SCAN_ROOTS=""
VOICE_INPUT=""
VOICE_OPENAI_API_KEY=""
VOICE_OPENAI_MODEL=""
VOICE_FFMPEG_BIN=""
WORKDIR=""

usage() {
  cat <<'EOF'
Usage:
  install-bridge-from-github.sh --telegram-token <token> [--codex-bin <path>] [--project-scan-roots <path1:path2:...>] [--voice-input true|false] [--voice-openai-api-key <key>] [--voice-openai-model <model>] [--voice-ffmpeg-bin <bin>] [--ref <name>] [--ref-type branch|tag]
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
    --project-scan-roots)
      PROJECT_SCAN_ROOTS="${2:-}"
      shift 2
      ;;
    --voice-input)
      VOICE_INPUT="${2:-}"
      shift 2
      ;;
    --voice-openai-api-key)
      VOICE_OPENAI_API_KEY="${2:-}"
      shift 2
      ;;
    --voice-openai-model)
      VOICE_OPENAI_MODEL="${2:-}"
      shift 2
      ;;
    --voice-ffmpeg-bin)
      VOICE_FFMPEG_BIN="${2:-}"
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
if [[ -n "$PROJECT_SCAN_ROOTS" ]]; then
  INSTALL_CMD+=(--project-scan-roots "$PROJECT_SCAN_ROOTS")
fi
if [[ -n "$VOICE_INPUT" ]]; then
  INSTALL_CMD+=(--voice-input "$VOICE_INPUT")
fi
if [[ -n "$VOICE_OPENAI_API_KEY" ]]; then
  INSTALL_CMD+=(--voice-openai-api-key "$VOICE_OPENAI_API_KEY")
fi
if [[ -n "$VOICE_OPENAI_MODEL" ]]; then
  INSTALL_CMD+=(--voice-openai-model "$VOICE_OPENAI_MODEL")
fi
if [[ -n "$VOICE_FFMPEG_BIN" ]]; then
  INSTALL_CMD+=(--voice-ffmpeg-bin "$VOICE_FFMPEG_BIN")
fi

"${INSTALL_CMD[@]}"
