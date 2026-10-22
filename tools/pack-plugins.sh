#!/bin/sh
# Rebuilds the bundled example archives in plugins/ from their source folders.
set -e
cd "$(dirname "$0")/../plugins"
for dir in */; do
  name=${dir%/}
  rm -f "$name.zip"
  (cd "$name" && zip -X -q -r "../$name.zip" . -x '.*')
  echo "plugins/$name.zip"
done
