#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-}"
LIMIT="3"
FORMAT="colon"

usage() {
  cat <<'EOF'
Usage:
  discover-project-scan-roots.sh [--home <path>] [--limit <count>] [--format colon|lines]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      HOME_DIR="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --format)
      FORMAT="${2:-}"
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

if [[ -z "$HOME_DIR" || ! -d "$HOME_DIR" ]]; then
  echo "home directory does not exist: $HOME_DIR" >&2
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
  echo "--limit must be a positive integer" >&2
  exit 1
fi

if [[ "$FORMAT" != "colon" && "$FORMAT" != "lines" ]]; then
  echo "--format must be colon or lines" >&2
  exit 1
fi

canonicalize_dir() {
  (
    cd "$1" >/dev/null 2>&1
    pwd -P
  )
}

looks_like_project_dir() {
  local dir="$1"
  [[ -d "$dir/.git" \
    || -d "$dir/.hg" \
    || -d "$dir/.svn" \
    || -f "$dir/package.json" \
    || -f "$dir/pyproject.toml" \
    || -f "$dir/Cargo.toml" \
    || -f "$dir/go.mod" \
    || -f "$dir/Makefile" ]]
}

score_candidate_root() {
  local root="$1"
  local score="0"
  local child=""

  while IFS= read -r -d '' child; do
    if looks_like_project_dir "$child"; then
      score=$((score + 1))
    fi
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

  if [[ "$score" -ge 2 ]]; then
    printf '%s\t%s\n' "$score" "$root"
  fi
}

CANDIDATES_FILE="$(mktemp)"
SORTED_FILE="$(mktemp)"
cleanup() {
  rm -f "$CANDIDATES_FILE" "$SORTED_FILE"
}
trap cleanup EXIT

candidate_exists() {
  local root="$1"
  local line=""

  while IFS= read -r line; do
    if [[ "${line#*$'\t'}" == "$root" ]]; then
      return 0
    fi
  done < "$CANDIDATES_FILE"

  return 1
}

add_candidate_root() {
  local raw_root="$1"
  local root=""
  local scored=""

  root="$(canonicalize_dir "$raw_root" 2>/dev/null || true)"
  if [[ -z "$root" ]]; then
    return 0
  fi

  if candidate_exists "$root"; then
    return 0
  fi

  scored="$(score_candidate_root "$root")"
  if [[ -n "$scored" ]]; then
    printf '%s\n' "$scored" >> "$CANDIDATES_FILE"
  fi
}

for preferred_name in projects work workspace code src dev repos repositories git github; do
  if [[ -d "$HOME_DIR/$preferred_name" ]]; then
    add_candidate_root "$HOME_DIR/$preferred_name"
  fi
done

while IFS= read -r -d '' root_dir; do
  add_candidate_root "$root_dir"
done < <(find "$HOME_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

sort -t "$(printf '\t')" -k1,1nr -k2,2 "$CANDIDATES_FILE" > "$SORTED_FILE"

paths_overlap() {
  local left="$1"
  local right="$2"
  [[ "$left" == "$right" || "$left" == "$right"/* || "$right" == "$left"/* ]]
}

SELECTED=()
while IFS=$'\t' read -r _score root; do
  local_overlap="0"
  if [[ "${#SELECTED[@]}" -gt 0 ]]; then
    for selected_root in "${SELECTED[@]}"; do
      if paths_overlap "$root" "$selected_root"; then
        local_overlap="1"
        break
      fi
    done
  fi

  if [[ "$local_overlap" == "0" ]]; then
    SELECTED+=("$root")
  fi

  if [[ "${#SELECTED[@]}" -ge "$LIMIT" ]]; then
    break
  fi
done < "$SORTED_FILE"

if [[ "${#SELECTED[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ "$FORMAT" == "lines" ]]; then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

(
  IFS=":"
  printf '%s\n' "${SELECTED[*]}"
)
