import { FilesetResolver, HandLandmarker } from "./vendor/vision_bundle.mjs";

// Пути от модуля, не от URL страницы — иначе на GitHub Pages (/repo/) WASM уезжает в корень сайта
const ASSET_ROOT = new URL(".", import.meta.url);
const WASM_DIR = new URL("vendor/wasm", ASSET_ROOT).href;
const MODEL_URL = new URL("vendor/hand_landmarker.task", ASSET_ROOT).href;

const PALM = [0, 5, 9, 13, 17];        // запястье и основания пальцев: центр ладони
const FIST = 1.35;                     // кулак: средний вылет кончиков / размер ладони ниже этого
const OPEN = 1.65;                     // ладонь: выше этого
const LOST_MS = 500;                   // рука (особенно кулак) может выпасть из кадра: состояние не сбрасываем сразу
const MATCH_PX = 300;                  // дальше этого рука считается новой, а не прежней
const MIN_CUTOFF = 1.5;                // One Euro: меньше = плавнее в покое
const BETA = 0.015;                    // One Euro: больше = меньше лага при быстром движении

// Фильтр One Euro: гасит дрожь в покое и не отстаёт при быстром движении
class OneEuro {
  t = null;
  filter(x, t) {
    if (this.t === null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max((t - this.t) / 1000, 1 / 120);
    const alpha = c => { const r = 2 * Math.PI * c * dt; return r / (r + 1); };
    this.dx += alpha(1) * ((x - this.x) / dt - this.dx);
    this.x += alpha(MIN_CUTOFF + BETA * Math.abs(this.dx)) * (x - this.x);
    this.t = t;
    return this.x;
  }
}

// video: <video>-элемент; toScene(nx, ny) -> [x, y] в координатах сцены
// onClose(p) вызывается, когда рука сжалась, onOpen(p) когда раскрылась
const LANDMARKER_OPTS = {
  runningMode: "VIDEO",
  numHands: 2,
  minHandDetectionConfidence: 0.4,
  minHandPresenceConfidence: 0.4,
  minTrackingConfidence: 0.4,
};

async function createLandmarker(vision) {
  try {
    return await HandLandmarker.createFromOptions(vision, {
      ...LANDMARKER_OPTS,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    });
  } catch {
    return await HandLandmarker.createFromOptions(vision, {
      ...LANDMARKER_OPTS,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    });
  }
}

export async function startHands(video, { toScene, onClose, onOpen }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera needs HTTPS or localhost");
  }
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
  });
  await video.play();

  const vision = await FilesetResolver.forVisionTasks(WASM_DIR);
  const landmarker = await createLandmarker(vision);

  // По одному указателю на руку: невидимый круг в центре ладони. Тянет слова, пока рука открыта
  const pointers = Array.from({ length: 2 }, (_, i) => ({
    id: `hand${i}`, hand: true, pull: true, closed: false, x: 0, y: 0, radius: 230, active: false, fade: 0, seen: false, lastSeen: -Infinity, ratio: 0,
    fx: new OneEuro(), fy: new OneEuro(),
  }));
  let lastTime = -1;

  function apply(hands, now) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const dist = (a, b) => Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh);
    const palms = hands.map(lm => toScene(
      PALM.reduce((s, i) => s + lm[i].x, 0) / PALM.length,
      PALM.reduce((s, i) => s + lm[i].y, 0) / PALM.length,
    ));

    // Рука привязывается к указателю по близости к прошлой позиции: порядок рук в списке нестабилен
    const pairs = [];
    pointers.forEach((p, pi) => {
      if (p.seen) palms.forEach(([x, y], hi) => pairs.push({ pi, hi, d: Math.hypot(x - p.x, y - p.y) }));
    });
    pairs.sort((a, b) => a.d - b.d);
    const slotOf = new Map(), used = new Set();
    for (const { pi, hi, d } of pairs) {
      if (d < MATCH_PX && !slotOf.has(hi) && !used.has(pi)) { slotOf.set(hi, pi); used.add(pi); }
    }
    hands.forEach((_, hi) => { // новые руки занимают свободные указатели
      if (slotOf.has(hi)) return;
      const pi = pointers.findIndex((p, i) => !used.has(i));
      if (pi >= 0) { slotOf.set(hi, pi); used.add(pi); }
    });

    hands.forEach((lm, hi) => {
      const p = pointers[slotOf.get(hi)];
      if (!p) return;
      if (p.fade < 0.05) { p.fx = new OneEuro(); p.fy = new OneEuro(); } // рука появилась заново: без прыжка
      p.x = p.fx.filter(palms[hi][0], now);
      p.y = p.fy.filter(palms[hi][1], now);
      p.lastSeen = now;

      // Открыта или сжата (с гистерезисом, чтобы не дребезжало)
      const size = dist(lm[0], lm[9]);
      p.ratio = [8, 12, 16, 20].reduce((s, i) => s + dist(lm[0], lm[i]), 0) / 4 / size;
      if (!p.closed && p.ratio < FIST) { p.closed = true; p.pull = false; onClose(p); }
      else if (p.closed && p.ratio > OPEN) { p.closed = false; p.pull = true; onOpen(p); }
    });
  }

  return {
    pointers,
    get info() {
      return "hands " + pointers.map(p => (p.seen ? p.ratio.toFixed(2) + (p.closed ? " fist" : "") : "—")).join(" | ");
    },
    update(now) {
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        apply(landmarker.detectForVideo(video, now).landmarks, now);
      }
      // плавное появление и затухание указателей; рука пропала надолго: сбрасываем состояние
      for (const p of pointers) {
        p.seen = now - p.lastSeen < LOST_MS;
        if (!p.seen) { p.closed = false; p.pull = true; }
        p.fade += ((p.seen ? 1 : 0) - p.fade) * 0.2;
        p.active = p.fade > 0.05;
      }
    },
  };
}
