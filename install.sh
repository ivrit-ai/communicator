#!/bin/sh
# Build time, as root. Output is baked into the image.
set -eu

npm ci --omit=dev --no-audit --no-fund
