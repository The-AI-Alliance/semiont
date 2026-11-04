#!/usr/bin/env bash
set -euo pipefail

ASSET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

render_svg() {
  local source="$1"
  local size="$2"
  local output="$3"
  local crop_height="${4:-$size}"
  local crop_width="${5:-$size}"
  local crop_offset_y="${6:-0}"
  mkdir -p "$TMP_DIR/rendered"
  qlmanage -t -s "$size" -o "$TMP_DIR/rendered" "$ASSET_DIR/$source" >/dev/null
  sips -c "$crop_height" "$crop_width" --cropOffset "$crop_offset_y" 0 -s format png \
    "$TMP_DIR/rendered/$source.png" --out "$output" >/dev/null
}

render_svg icon.svg 1024 "$ASSET_DIR/icon.png"
render_svg dmg-background.svg 760 "$ASSET_DIR/dmg-background.png" 560 760 100
render_svg dmg-background.svg 1520 "$TMP_DIR/dmg-background@2x.png" 1120 1520 200
sips -s dpiWidth 144 -s dpiHeight 144 "$TMP_DIR/dmg-background@2x.png" >/dev/null
tiffutil -cathidpicheck "$ASSET_DIR/dmg-background.png" "$TMP_DIR/dmg-background@2x.png" \
  -out "$ASSET_DIR/dmg-background.tiff"

ICONSET="$TMP_DIR/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" "$ASSET_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" "$ASSET_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ASSET_DIR/icon.icns"
