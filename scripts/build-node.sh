#!/bin/sh
# Build plantuml.plug.js without Deno, using the plug-compile CLI of a
# SilverBullet checkout:
#
#   SB_DIR=~/src/silverbullet sh scripts/build-node.sh
#
# The checkout is used for the CLI itself, for the worker runtime that gets
# prepended to every plug bundle, and for the `@silverbulletmd/silverbullet`
# package the plug imports its syscalls from. That package is linked into
# node_modules (git-ignored) on first run. Deno users do not need any of this:
# `deno task build` does the same thing.
set -eu

SB_DIR=${SB_DIR:-../silverbullet}
SB_DIR=$(cd "$SB_DIR" && pwd)
PLUG_COMPILE="$SB_DIR/dist/plug-compile.js"

if [ ! -f "$PLUG_COMPILE" ]; then
  echo "No plug-compile CLI at $PLUG_COMPILE" >&2
  echo "Build it in the SilverBullet checkout first:" >&2
  echo "  cd $SB_DIR && npm run build:plug-compile" >&2
  exit 1
fi

# esbuild resolves "@silverbulletmd/silverbullet/syscalls" relative to the
# plug source, so point that package at the checkout.
if [ ! -e node_modules/@silverbulletmd/silverbullet ]; then
  mkdir -p node_modules/@silverbulletmd
  ln -s "$SB_DIR" node_modules/@silverbulletmd/silverbullet
fi

node "$PLUG_COMPILE" --dist . plantuml.plug.yaml

# The upstream build ships a single minified file; drop the source map.
rm -f plantuml.plug.js.map
sed -i '/^\/\/# sourceMappingURL=/d' plantuml.plug.js
