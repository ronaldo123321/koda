#!/bin/sh
set -eu
export COPYFILE_DISABLE=1

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output=${1:-"$repo_root/dist/KodaGUI.app"}
runtime_dir=${2:?"Usage: package-preview.sh OUTPUT.app KODA_RUNTIME_DIR"}
if [ -e "$output" ]; then
    echo "Output already exists: $output" >&2
    exit 1
fi
if [ ! -x "$runtime_dir/bin/koda" ]; then
    echo "Koda runtime launcher is missing: $runtime_dir/bin/koda" >&2
    exit 1
fi

swift build --package-path "$repo_root/apps/macos-gui" \
    --scratch-path "$repo_root/apps/macos-gui/.build" -c release
bin_dir=$(swift build --package-path "$repo_root/apps/macos-gui" \
    --scratch-path "$repo_root/apps/macos-gui/.build" -c release --show-bin-path)
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources/runtime"
ditto --norsrc "$bin_dir/KodaGUI" "$output/Contents/MacOS/KodaGUI"
ditto --norsrc "$repo_root/apps/macos-gui/Info.plist" "$output/Contents/Info.plist"
ditto --norsrc "$runtime_dir" "$output/Contents/Resources/runtime/koda"
"$output/Contents/Resources/runtime/koda/bin/koda" doctor --bundle-only --json >/dev/null
echo "$output"
