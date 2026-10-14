#!/usr/bin/env bash
# build.sh: build the Obsidian plugin into obsidian/dist/ (main.js, manifest.json, styles.css).
#
# Obsidian installs a plugin as exactly those three files, so the editor can't ship as src/'s separate
# modules. This inlines it: esbuild bundles src/app.js and its imports into one script, which goes into
# src/index.html in place of the <script> and <link> tags (dist/editor.html). Then esbuild bundles
# main.js with that page as a string (dist/main.js). esbuild runs via npx; nothing is installed in the repo.
#
# Try it: copy dist/* into <vault>/.obsidian/plugins/haashiya/ and enable Haashiya in Community plugins.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The editor: ../src in the Margin repo; editor/ in the public plugin repo (copied there by publish.sh).
src="$here/editor"; [ -d "$src" ] || src="$here/../src"
dist="$here/dist"
esbuild=(npx --yes esbuild@0.28.2)

rm -rf "$dist"
mkdir -p "$dist"

"${esbuild[@]}" "$src/app.js" --bundle --format=iife --log-level=warning --outfile="$dist/editor.js"
# Assemble the page. A literal </script> inside the bundle would end the tag early; esbuild escapes it,
# and the check below makes sure.
if grep -q '</script' "$dist/editor.js"; then echo "editor.js contains </script>; can't inline" >&2; exit 1; fi
python3 - "$src/index.html" "$src/style.css" "$dist/editor.js" "$dist/editor.html" <<'PY'
import sys
html, css, js, out = sys.argv[1:]
page = open(html).read()
page = page.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + open(css).read() + '</style>')
page = page.replace('<script type="module" src="app.js"></script>', '<script>\n' + open(js).read() + '</script>')
assert 'href="style.css"' not in page and 'src="app.js"' not in page, 'index.html changed: update obsidian/build.sh'
open(out, 'w').write(page)
PY
rm "$dist/editor.js"

"${esbuild[@]}" "$here/main.js" --bundle --format=cjs --platform=browser --external:obsidian --external:child_process \
  --loader:.html=text --log-level=warning --outfile="$dist/main.js"
cp "$here/manifest.json" "$here/styles.css" "$dist/"
rm "$dist/editor.html"

echo "plugin ready: $dist ($(du -k "$dist/main.js" | cut -f1) KB main.js)"
