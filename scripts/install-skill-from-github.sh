#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="InDreamer"
REPO_NAME="telegram-codex-bridge"
SKILL_NAME="telegram-codex-linker"
REF="master"
REF_TYPE="branch"
WORKDIR=""

usage() {
  cat <<'EOF'
Usage:
  install-skill-from-github.sh [--ref <name>] [--ref-type branch|tag]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

for cmd in curl tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required" >&2
    exit 1
  fi
done

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
SOURCE_SKILL_DIR="${SOURCE_DIR}/skills/${SKILL_NAME}"

if [[ ! -f "${SOURCE_SKILL_DIR}/SKILL.md" ]]; then
  echo "skill bundle not found: ${SOURCE_SKILL_DIR}" >&2
  exit 1
fi

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TARGET_SKILL_DIR="${CODEX_HOME_DIR}/skills/${SKILL_NAME}"
mkdir -p "${CODEX_HOME_DIR}/skills"
rm -rf "${TARGET_SKILL_DIR}"
cp -R "${SOURCE_SKILL_DIR}" "${TARGET_SKILL_DIR}"

echo "installed Codex skill ${SKILL_NAME} into ${TARGET_SKILL_DIR}"
echo "restart Codex to load the new skill"
