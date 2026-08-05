#!/bin/sh
# Boot time, as the non-root 'app' user.
# One exec line: node becomes PID 1 and receives stop signals directly.
# The sender is forked from inside node, not spawned here.
set -eu

exec node --max-old-space-size=512 server.js
