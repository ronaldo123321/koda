#!/bin/sh
set -eu
export COPYFILE_DISABLE=1

app=${1:?"Usage: package-unsigned-pkg.sh Koda.app OUTPUT.pkg"}
output=${2:?"Usage: package-unsigned-pkg.sh Koda.app OUTPUT.pkg"}
if [ -e "$output" ]; then
    echo "Output already exists: $output" >&2
    exit 1
fi
if [ ! -x "$app/Contents/Resources/runtime/koda/bin/koda" ]; then
    echo "The app does not include the Koda runtime." >&2
    exit 1
fi

"$app/Contents/Resources/runtime/koda/bin/koda" doctor --bundle-only --json >/dev/null
pkgbuild --component "$app" --install-location /Applications \
    --identifier com.koda.gui.preview --version 0.1.0 "$output"
