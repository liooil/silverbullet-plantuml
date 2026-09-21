#!/bin/sh
# Builds plantuml.plug.js.
#
# The compiler is the plug-compile CLI that ships inside the
# @silverbulletmd/silverbullet npm package (the same artifact the
# silverbullet-plug-template uses), so no Deno and no SilverBullet checkout are
# needed:
#
#   npm install
#   npm run build
set -eu

PLUG_COMPILE=${PLUG_COMPILE:-node_modules/.bin/plug-compile}
if [ ! -x "$PLUG_COMPILE" ]; then
  echo "No plug-compile at $PLUG_COMPILE — run 'npm install' first." >&2
  exit 1
fi

"$PLUG_COMPILE" plantuml.plug.yaml

# Ship a single minified file, like upstream: drop the linked source map.
rm -f plantuml.plug.js.map
sed -i.bak '/^\/\/# sourceMappingURL=/d' plantuml.plug.js
rm -f plantuml.plug.js.bak
