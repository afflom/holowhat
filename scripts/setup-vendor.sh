#!/usr/bin/env bash
#
# Setup the vendor/ directory by cloning dependencies and linking artifacts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT/vendor"

mkdir -p "$VENDOR_DIR"

echo "setup-vendor: cloning holospaces..."
if [ ! -d "$VENDOR_DIR/holospaces" ]; then
    git clone --depth 1 https://github.com/Hologram-Technologies/holospaces.git "$VENDOR_DIR/holospaces"
else
    echo "setup-vendor: holospaces already cloned"
fi

echo "setup-vendor: cloning Playground 2.0..."
if [ ! -d "$VENDOR_DIR/playground" ]; then
    git clone --depth 1 https://github.com/PlaygroundNow/Playground-2.0.git "$VENDOR_DIR/playground"
else
    echo "setup-vendor: Playground 2.0 already cloned"
fi

echo "setup-vendor: linking artifacts from holospaces vv/artifacts..."
rm -rf "$VENDOR_DIR/artifacts"
ln -sf "./holospaces/vv/artifacts" "$VENDOR_DIR/artifacts"

echo "setup-vendor: linking playground components and assets into holospaces-web..."
WEB_DIR="$ROOT/crates/holospaces-web/web"
PLAYGROUND_DIR="$VENDOR_DIR/playground"

# Create assets and assets/scripts directories if they don't exist
mkdir -p "$WEB_DIR/assets/scripts"

# Remove existing copied directories/files to avoid conflicts
rm -rf "$WEB_DIR/blocks"
rm -rf "$WEB_DIR/utils"
rm -rf "$WEB_DIR/assets/css"
rm -rf "$WEB_DIR/assets/icons"
rm -rf "$WEB_DIR/assets/img"

# Clean up scripts from playground except our custom playground.js
if [ -d "$WEB_DIR/assets/scripts" ]; then
    find "$WEB_DIR/assets/scripts" -maxdepth 1 -type l -exec rm -f {} \;
fi
# Clean up HTML templates
find "$WEB_DIR" -maxdepth 1 -type l -name "*.html" -exec rm -f {} \;

# Also clean up any physical files that are copies to ensure clean symlinking
for f in "$PLAYGROUND_DIR"/public/*.html; do
    base=$(basename "$f")
    rm -f "$WEB_DIR/$base"
done
for f in "$PLAYGROUND_DIR"/public/assets/scripts/*; do
    base=$(basename "$f")
    if [ "$base" != "playground.js" ]; then
        rm -rf "$WEB_DIR/assets/scripts/$base"
    fi
done

# Create symbolic links
ln -sf "../../../vendor/playground/blocks" "$WEB_DIR/blocks"
ln -sf "../../../vendor/playground/utils" "$WEB_DIR/utils"
ln -sf "../../../../vendor/playground/public/assets/css" "$WEB_DIR/assets/css"
ln -sf "../../../../vendor/playground/public/assets/icons" "$WEB_DIR/assets/icons"
ln -sf "../../../../vendor/playground/public/assets/img" "$WEB_DIR/assets/img"

# Link individual scripts except playground.js
for f in "$PLAYGROUND_DIR"/public/assets/scripts/*; do
    base=$(basename "$f")
    if [ "$base" != "playground.js" ]; then
        ln -sf "../../../../../vendor/playground/public/assets/scripts/$base" "$WEB_DIR/assets/scripts/$base"
    fi
done

# Link HTML pages
for f in "$PLAYGROUND_DIR"/public/*.html; do
    base=$(basename "$f")
    ln -sf "../../../vendor/playground/public/$base" "$WEB_DIR/$base"
done


echo "setup-vendor: completed successfully."

