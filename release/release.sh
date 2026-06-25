#!/usr/bin/env bash
#
# Build Reader for Android + macOS, then distribute:
#   - copies the (signed) APK, Reader.app, and a shareable Reader.zip into a
#     destination folder (e.g. your local Google Drive folder)
#   - overwrites Reader.app in /Applications
#
# Usage:
#   ./release/release.sh                          # build + copy to the default Drive folder
#   ./release/release.sh "/path/to/Drive/Folder"  # build + copy to a given folder
#   ./release/release.sh --no-build "/path/..."    # skip building, just distribute
#   ./release/release.sh -o                        # also reveal the folder / launch the app when done
#
# NOTE: the destination must be a LOCAL folder path (the mounted Google Drive
#       folder under ~/Library/CloudStorage/...), NOT a drive.google.com link.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# default destination (used when no folder argument is given)
DEFAULT_DEST="/Users/balaji-9678/Library/CloudStorage/GoogleDrive-balaji19961910@gmail.com/My Drive/ReaderApp"

# --- parse args (flags + optional destination folder, any order) ---
#   --minor / --major          bump y / major by hand (drastic changes)
#   --set-version=X.Y.Z         pin an exact version
# (otherwise the patch number auto-increments once per new commit)
NO_BUILD=0
OPEN=0
DEST=""
VERSION_FLAGS=()
for a in "$@"; do
  case "$a" in
    --no-build) NO_BUILD=1 ;;
    -o|--open) OPEN=1 ;;
    --minor) VERSION_FLAGS+=(--minor) ;;
    --major) VERSION_FLAGS+=(--major) ;;
    --set-version=*) VERSION_FLAGS+=(--set "${a#*=}") ;;
    http://*|https://*)
      echo "✗ That looks like a web link. Pass the LOCAL Drive folder path instead," >&2
      echo "  e.g. \"$DEFAULT_DEST\"" >&2
      exit 1
      ;;
    *) DEST="$a" ;;
  esac
done
DEST="${DEST:-$DEFAULT_DEST}"

APP="$ROOT/src-tauri/target/release/bundle/macos/Reader.app"
APK_DIR="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/release"

# --- 0) version bump (patch auto-increments once per new commit) ---
if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "▶ Versioning…"
  node "$ROOT/release/version.mjs" ${VERSION_FLAGS[@]+"${VERSION_FLAGS[@]}"}
fi

# --- 1) build ---
if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "▶ Building Android APK (aarch64)…"
  npm run tauri android build -- --apk --target aarch64
  echo "▶ Building macOS app…"
  npm run tauri build
fi

# --- 2) locate freshest APK ---
APK="$(ls -t "$APK_DIR"/*.apk 2>/dev/null | head -1 || true)"
[[ -n "$APK" ]] || { echo "✗ No APK in $APK_DIR" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "✗ No app at $APP" >&2; exit 1; }
case "$APK" in
  *-unsigned.apk)
    echo "⚠  APK is UNSIGNED ($(basename "$APK")) — it won't install on a device."
    echo "   Set up src-tauri/gen/android/keystore.properties (see README)." ;;
esac

# --- 3) quit a running Reader so /Applications can be overwritten ---
osascript -e 'quit app "Reader"' >/dev/null 2>&1 || true
sleep 1

# --- 4) distribute to DEST (overwrite) ---
mkdir -p "$DEST"
cp -f "$APK" "$DEST/"
echo "✓ $(basename "$APK") → $DEST/"
rm -rf "$DEST/Reader.app" && cp -R "$APP" "$DEST/"
ditto -c -k --keepParent "$APP" "$DEST/Reader.zip"   # shareable zip (raw .app breaks on Drive)
echo "✓ Reader.app + Reader.zip → $DEST/"

# --- 5) install locally (overwrite) ---
rm -rf /Applications/Reader.app && cp -R "$APP" /Applications/
echo "✓ Reader.app → /Applications/"

# --- 6) reveal (only with -o / --open) ---
if [[ "$OPEN" -eq 1 ]]; then
  open "$DEST" 2>/dev/null || true
  open /Applications/Reader.app 2>/dev/null || true
fi
echo "✅ Done → $DEST"
