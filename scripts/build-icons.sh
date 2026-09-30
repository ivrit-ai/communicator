#!/bin/sh
# Renders the app icons from the SVG sources in assets/. Needs rsvg-convert
# (librsvg). The PNGs are committed; run this only after changing the SVGs.
set -eu
cd "$(dirname "$0")/.."
out=public/icons
for size in 192 512 1024; do
  rsvg-convert -w "$size" -h "$size" assets/mark.svg -o "$out/icon-$size.png"
done
rsvg-convert -w 512 -h 512 assets/maskable.svg -o "$out/maskable-512.png"
# Android draws the badge as a white silhouette in the status bar.
rsvg-convert -w 72 -h 72 assets/badge.svg -o "$out/badge-72.png"
rsvg-convert -w 180 -h 180 assets/maskable.svg -o "$out/apple-touch-icon.png"
cp assets/mark.svg "$out/mark.svg"
