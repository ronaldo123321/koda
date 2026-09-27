#!/bin/sh
set -eu
export COPYFILE_DISABLE=1

app=${1:?"Usage: package-unsigned-pkg.sh Koda.app OUTPUT.pkg"}
output=${2:?"Usage: package-unsigned-pkg.sh Koda.app OUTPUT.pkg"}
if [ -e "$output" ]; then
    echo "Output already exists: $output" >&2
    exit 1
fi
if [ "$(basename -- "$app")" != Koda.app ]; then
    echo "The app bundle must be named Koda.app for an in-place installation." >&2
    exit 1
fi
if [ ! -x "$app/Contents/Resources/runtime/koda/bin/koda" ]; then
    echo "The app does not include the Koda runtime." >&2
    exit 1
fi

"$app/Contents/Resources/runtime/koda/bin/koda" doctor --bundle-only --json >/dev/null
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
pkgbuild --component "$app" --install-location /Applications \
    --identifier com.koda.gui.preview --version "$version" "$output"
