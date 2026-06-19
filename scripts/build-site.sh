#!/usr/bin/env bash
#
# Build the GitHub Pages site locally into _site/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINAL_SITE_DIR="${1:-$ROOT/_site}"
MARKER="$FINAL_SITE_DIR/.holospaces-site-build"
SITE_TMP="$ROOT/target/site-tmp"
STAGE_DIR="$ROOT/target/site-build-$$"
BACKUP_DIR="$ROOT/target/site-prev-$$"

cleanup() {
    rm -rf "$STAGE_DIR" "$BACKUP_DIR"
}
trap cleanup EXIT

find_wasm_bindgen() {
    local version="$1"
    local candidate

    if command -v wasm-bindgen >/dev/null 2>&1; then
        candidate="$(command -v wasm-bindgen)"
        if [ "$("$candidate" --version)" = "wasm-bindgen $version" ]; then
            printf '%s\n' "$(dirname "$candidate")"
            return 0
        fi
    fi

    for candidate in "$HOME"/.cache/.wasm-pack/wasm-bindgen-*/wasm-bindgen "$ROOT"/target/.wasm-pack/wasm-bindgen-*/wasm-bindgen; do
        if [ -x "$candidate" ] && [ "$("$candidate" --version)" = "wasm-bindgen $version" ]; then
            printf '%s\n' "$(dirname "$candidate")"
            return 0
        fi
    done

    return 1
}

cd "$ROOT"

if [ -e "$FINAL_SITE_DIR" ] && [ ! -f "$MARKER" ]; then
    printf 'build-site: ERROR: %s exists but is not marked as a holospaces generated site; remove it or pass another output directory\n' "$FINAL_SITE_DIR" >&2
    exit 1
fi

rm -rf "$STAGE_DIR" "$BACKUP_DIR"
mkdir -p "$STAGE_DIR" "$SITE_TMP"
touch "$STAGE_DIR/.holospaces-site-build"

echo "build-site: generating browser fixtures"
cargo run -q -p holowhat-tools -- crates/holospaces-web/web

echo "build-site: building Platform Manager wasm"
wasm_bindgen_version=$(awk '/name = "wasm-bindgen"/ { getline; gsub(/"/, "", $3); print $3; exit }' crates/holospaces-web/Cargo.lock)
wasm_pack_args=()
if wasm_bindgen_dir="$(find_wasm_bindgen "$wasm_bindgen_version")"; then
    export PATH="$wasm_bindgen_dir:$PATH"
    wasm_pack_args=(--mode no-install --no-opt)
fi
TMPDIR="$SITE_TMP" wasm-pack build "${wasm_pack_args[@]}" crates/holospaces-web --release --target web --out-dir web/pkg

echo "build-site: assembling static site"
cp -L crates/holospaces-web/web/index.html "$STAGE_DIR/"
cp -L crates/holospaces-web/web/login.html "$STAGE_DIR/"
cp -L crates/holospaces-web/web/worlds.html "$STAGE_DIR/"
cp -L crates/holospaces-web/web/fixture.holo "$STAGE_DIR/"
cp -L crates/holospaces-web/web/fixture-userland.wasm "$STAGE_DIR/"
cp -rL crates/holospaces-web/web/assets "$STAGE_DIR/"
cp -rL crates/holospaces-web/web/blocks "$STAGE_DIR/"
cp -rL crates/holospaces-web/web/utils "$STAGE_DIR/"
cp -rL crates/holospaces-web/web/pkg "$STAGE_DIR/pkg"
rm -f "$STAGE_DIR"/pkg/*.d.ts "$STAGE_DIR/pkg/package.json" "$STAGE_DIR/pkg/.gitignore"

echo "build-site: patching static routing redirect paths in blocks"
sed -i 's|window.location.href = "/worlds"|window.location.href = "worlds.html"|g' "$STAGE_DIR/blocks/login-block.html"
sed -i 's|location.href = '\''/worlds/'\''|location.href = '\''./index.html?id='\''|g' "$STAGE_DIR/blocks/worlds-block.html"
sed -i 's|await this.getWorlds()|await new Promise(r => setTimeout(r, 500)); await this.getWorlds()|g' "$STAGE_DIR/blocks/worlds-block.html"

# Patch worlds-block.html to use explicit worldHandle.change for initial state mapping to ensure storage save is triggered
python3 -c '
path = "'"$STAGE_DIR"'/blocks/worlds-block.html"
with open(path, "r") as f:
    content = f.read()
target = """      const worldHandle = repo.create({
        packages: [],
        theme: "night",
        font: "Nanum Pen Script",
        world: [],
      })"""
replacement = """      const worldHandle = repo.create()
      worldHandle.change((doc) => {
        doc.packages = []
        doc.theme = "night"
        doc.font = "Nanum Pen Script"
        doc.world = []
      })"""
if target in content:
    content = content.replace(target, replacement)
    with open(path, "w") as f:
        f.write(content)
'

echo "build-site: patching absolute paths to relative in all HTML and JS files"
python3 -c '
import os, re
stage_dir = "'"$STAGE_DIR"'"
replacements = [
    (re.compile(r"\"/assets/"), "\"assets/"),
    (re.compile(r"'\''/assets/"), "'\''assets/"),
    (re.compile(r"url\(\"/assets/"), "url(\"assets/"),
    (re.compile(r"url\('\''/assets/"), "url('\''assets/"),
    (re.compile(r"\"/blocks/"), "\"blocks/"),
    (re.compile(r"'\''/blocks/"), "'\''blocks/"),
    (re.compile(r"\"/utils/"), "\"utils/"),
    (re.compile(r"'\''/utils/"), "'\''utils/"),
    (re.compile(r"\"/pkg/"), "\"pkg/"),
    (re.compile(r"'\''/pkg/"), "'\''pkg/"),
    (re.compile(r"\.\./\.\./\.\./pkg/"), "../../pkg/"),
]

for root, dirs, files in os.walk(stage_dir):
    for file in files:
        if file.endswith((".html", ".js")):
            path = os.path.join(root, file)
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            original = content
            for pattern, repl in replacements:
                content = pattern.sub(repl, content)
            if content != original:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                print(f"Patched paths in: {os.path.relpath(path, stage_dir)}")
'

if [ -e "$FINAL_SITE_DIR" ]; then
    mv "$FINAL_SITE_DIR" "$BACKUP_DIR"
fi
mv "$STAGE_DIR" "$FINAL_SITE_DIR"
rm -rf "$BACKUP_DIR"

echo "build-site: wrote $FINAL_SITE_DIR"
