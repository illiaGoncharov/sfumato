# sfumato

**Interactive browser artwork (2026)** — blurred webcam, hand-tracked words, fleeting lines of meaning.

[**Live demo**](https://illiaGoncharov.github.io/sfumato/) · Chrome or Arc on desktop · camera permission required

## About

*sfumato* applies the Renaissance soft-focus idea to attention itself: the figure dissolves into a dim haze while peripheral sensations—architecture, texture, light, sound—float as words in [OKLCH](https://oklch.com/) color space. An open hand lets them drift; a closed fist holds three nearby words in balance; release triggers a brief burst when color and motion align. The moment a line “forms” is accidental, not authored—closer to memory than manifesto.

All vision runs **on your device**. The camera stream is not uploaded; MediaPipe Hand Landmarker executes locally via WebAssembly.

## Controls

| Input | Action |
|--------|--------|
| **C** | Toggle webcam |
| **V** | Toggle 9:16 / 16:9 canvas |
| **H** | Hide UI (clean view) |
| **E** | Edit word list (saved in `localStorage`) |
| **Mouse** | Hold / release mimics fist gesture (sandbox without camera) |

On macOS, turn off **Portrait** and **Background** in the camera menu—they break hand tracking.

**Arc stuck on an old build?** Fully quit Arc (Cmd+Q), reopen the demo URL, or open it in a **New Incognito Window**. Site data: lock icon → site settings → clear data, or `arc://settings/content/siteDetails?site=https%3A%2F%2FilliaGoncharov.github.io`. Camera: `arc://settings/content/camera` → allow `illiaGoncharov.github.io`.

## Stack

Vanilla JS · Canvas 2D · [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) · culori · d3-delaunay · static hosting on GitHub Pages

## Run locally

```bash
git clone https://github.com/illiaGoncharov/sfumato.git
cd sfumato
python3 -m http.server 8000
# open http://localhost:8000
```

Dependencies ship in `vendor/`. After a fresh clone, run `./setup.sh` only if files are missing.

## Author

[Illia Goncharov](https://github.com/illiaGoncharov) — creative technologist
