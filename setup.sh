#!/bin/sh
# Скачивает MediaPipe, модель, culori и d3-delaunay в vendor/, чтобы не зависеть от CDN.
set -e
cd "$(dirname "$0")"
mkdir -p vendor/wasm
tmp=$(mktemp -d)

# 1. MediaPipe tasks vision
(cd "$tmp" && npm pack @mediapipe/tasks-vision --silent && tar xzf mediapipe-tasks-vision-*.tgz)
cp "$tmp/package/vision_bundle.mjs" vendor/
cp "$tmp"/package/wasm/vision_wasm_internal.* "$tmp"/package/wasm/vision_wasm_nosimd_internal.* vendor/wasm/

# 2. Модель рук (только если ещё нет)
if [ ! -f vendor/hand_landmarker.task ]; then
  curl -fsSL -o vendor/hand_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
fi

# 3. culori (OKLCH цвет) и d3-delaunay (полигоны)
(cd "$tmp" && rm -rf package* && npm pack culori --silent && tar xzf culori-*.tgz)
cp "$tmp/package/bundled/culori.min.mjs" vendor/

(cd "$tmp" && rm -rf package* && npm pack d3-delaunay --silent && tar xzf d3-delaunay-*.tgz)
cp "$tmp/package/dist/d3-delaunay.min.js" vendor/

# 4. Tone.js — UMD-бандл (без ESM-цепочки standardized-audio-context в браузере)
(cd "$tmp" && rm -rf package* && npm pack tone --silent && tar xzf tone-*.tgz)
cp "$tmp/package/build/Tone.js" vendor/Tone.js
cp "$tmp/package/build/Tone.js.LICENSE.txt" vendor/Tone.js.LICENSE.txt
rm -rf vendor/tone vendor/tslib.es6.mjs vendor/automation-events vendor/standardized-audio-context

rm -rf "$tmp"
echo "ok: vendor/ готов (MediaPipe, culori, d3-delaunay, Tone.js)"
