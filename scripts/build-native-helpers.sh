#!/bin/bash
# Build native Sense helper binaries
# Called via: npm run build:native

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/src/native"
OUT_DIR="$PROJECT_DIR/out/daemon/bin/sense"

mkdir -p "$OUT_DIR"

echo "Building native helpers..."

# bond-window-helper — CGWindowList for app/window detection
echo "  window-helper"
xcrun clang \
  -framework Foundation \
  -framework AppKit \
  -framework CoreGraphics \
  -fobjc-arc \
  -O2 \
  -o "$OUT_DIR/bond-window-helper" \
  "$SRC_DIR/window-helper.m"

# bond-ocr-helper — Apple Vision OCR
echo "  ocr-helper"
xcrun clang \
  -framework Foundation \
  -framework Vision \
  -framework AppKit \
  -framework CoreGraphics \
  -framework ImageIO \
  -fobjc-arc \
  -O2 \
  -o "$OUT_DIR/bond-ocr-helper" \
  "$SRC_DIR/ocr-helper.m"

# bond-accessibility-helper — AXUIElement tree walker
echo "  accessibility-helper"
xcrun clang \
  -framework Foundation \
  -framework AppKit \
  -framework ApplicationServices \
  -fobjc-arc \
  -O2 \
  -o "$OUT_DIR/bond-accessibility-helper" \
  "$SRC_DIR/accessibility-helper.m"

echo "Done. Binaries in $OUT_DIR"
