#!/usr/bin/env bash
# Run on a Mac after `npm run tauri ios init`.
# Copies the iCloud entitlements into the generated Xcode project. The
# Info.plist additions (Files app visibility, iCloud Drive folder, permission
# texts) are merged automatically from src-tauri/Info.ios.plist by Tauri.
set -euo pipefail
cd "$(dirname "$0")/.."

GEN=src-tauri/gen/apple
if [ ! -d "$GEN" ]; then
  echo "Run 'npm run tauri ios init' first (needs Xcode)." >&2
  exit 1
fi

target=$(find "$GEN" -maxdepth 2 -name '*.entitlements' | head -n 1)
if [ -z "$target" ]; then
  echo "No .entitlements file found under $GEN. Add src-tauri/ios/Meridian.entitlements to the iOS target in Xcode by hand." >&2
  exit 1
fi
cp src-tauri/ios/Meridian.entitlements "$target"
echo "Wrote iCloud entitlements to $target"

id=$(node -p "require('./src-tauri/tauri.conf.json').identifier")
if ! grep -q "iCloud.$id" src-tauri/ios/Meridian.entitlements src-tauri/Info.ios.plist; then
  echo "WARNING: the bundle identifier is '$id' but the iCloud container in" >&2
  echo "src-tauri/ios/Meridian.entitlements and src-tauri/Info.ios.plist is different." >&2
  echo "Both must be 'iCloud.$id'." >&2
fi
echo "Next: open the project (npm run tauri ios dev -- --open), pick your team under Signing & Capabilities,"
echo "and confirm the iCloud capability lists iCloud.$id with 'iCloud Documents' ticked."
