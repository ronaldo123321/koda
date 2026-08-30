#!/usr/bin/env bash

set -euo pipefail

readonly legacy_revision="3aa84ee"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-path>" >&2
  exit 2
fi

readonly repository_root="$(git rev-parse --show-toplevel)"
readonly requested_output="$1"
readonly output_parent="$(dirname "$requested_output")"
mkdir -p "$output_parent"
readonly canonical_output_parent="$(cd "$output_parent" && pwd -P)"
readonly output_path="$canonical_output_parent/$(basename "$requested_output")"
if [[ -e "$output_path" || -L "$output_path" ]]; then
  echo "refusing to replace existing output: $output_path" >&2
  exit 1
fi
readonly temporary_root="${TMPDIR:-/tmp}"
readonly canonical_temporary_root="${temporary_root%/}"
readonly fixture_root="$(mktemp -d "$canonical_temporary_root/koda-phase-4c1-v1.XXXXXX")"
readonly source_root="$fixture_root/source"
readonly target_root="$fixture_root/target"

cleanup() {
  case "$fixture_root" in
    "$canonical_temporary_root"/koda-phase-4c1-v1.*) rm -rf -- "$fixture_root" ;;
    *) echo "refusing to remove unexpected fixture path: $fixture_root" >&2 ;;
  esac
}
trap cleanup EXIT

mkdir -p "$source_root"
git -C "$repository_root" cat-file -e "$legacy_revision^{commit}"
git -C "$repository_root" archive "$legacy_revision" | tar -x -C "$source_root"
cargo build \
  --manifest-path "$source_root/Cargo.toml" \
  --package koda-exec \
  --target-dir "$target_root"
cp "$target_root/debug/koda-exec" "$output_path"
chmod 0755 "$output_path"

echo "$output_path"
