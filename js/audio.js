/**
 * Генеративный эмбиент в духе серии Noto × Sakamoto
 * (Vrioon / Insen / Revep / Summvs): сухие клики + длинные тихие ноты.
 * Tone.js — UMD (vendor/Tone.js) → globalThis.Tone.
 */
const Tone = globalThis.Tone;
if (!Tone) throw new Error("Load vendor/Tone.js before audio.js");

/** Минорная пентатоника в D — спокойнее мажора, ближе к Insen */
const SCALE = ["D3", "F3", "G3", "A3", "C4", "D4", "F4", "G4", "A4"];
const isTouch = () => matchMedia("(pointer: coarse)").matches;
let masterDb = -10;

let ready = false;
let muted = false;
let master;
let reverb;
let drone;
let droneFilter;
let pad;
let idleTick;   // редкий фоновый «ното»-тик — не тот же, что при релизе
let burstPool;  // по одному NoiseSynth на удар в россыпи (Tone: время на ноде только вперёд)
let burstSynthNext = [];
let burstTimeline = 0;
let pingSynth;
let chordSynth;
let idleLoop;
/** До этого времени idle не стучит — чтобы не наслаиваться на жест */
let idleQuietUntil = 0;
let lastBurstAudioAt = -1;
/** Минимальный WAV — «разблокировка» медиа-сессии iOS до Web Audio */
let iosUnlockEl;

function hueToNote(hue) {
  const i = Math.floor(((hue % 360) / 360) * SCALE.length) % SCALE.length;
  return SCALE[i];
}

function playIosMediaUnlock() {
  if (!isTouch()) return;
  try {
    iosUnlockEl ??= new Audio(
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
    );
    iosUnlockEl.setAttribute("playsinline", "true");
    iosUnlockEl.volume = 0.01;
    void iosUnlockEl.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Синхронно в обработчике tap/click — иначе iOS Safari не даст звук */
export function unlockAudioContext() {
  playIosMediaUnlock();
  if (!Tone) return;
  try {
    Tone.start();
    const ctx = Tone.getContext().rawContext;
    if (ctx?.state === "suspended" && ctx.resume) void ctx.resume();
  } catch (err) {
    console.warn("audio unlock failed", err);
  }
}

async function ensureContextRunning() {
  await Tone.start();
  const ctx = Tone.getContext().rawContext;
  if (ctx?.state === "suspended" && ctx.resume) await ctx.resume();
  return ctx?.state === "running";
}

async function createFxChain() {
  master = new Tone.Volume(masterDb).toDestination();
  if (isTouch()) {
    // Reverb.generate() часто ломает/вешает iOS — лёгкий delay вместо IR
    reverb = new Tone.FeedbackDelay({ delayTime: "4n", feedback: 0.22, wet: 0.32 }).connect(master);
    return;
  }
  reverb = new Tone.Reverb({ decay: 11, wet: 0.38 }).connect(master);
  try {
    await reverb.generate();
  } catch (err) {
    console.warn("reverb generate failed, shorter tail", err);
    reverb.decay = 4;
    await reverb.generate();
  }
}

export async function startAudio() {
  if (ready) return true;
  try {
  masterDb = isTouch() ? -2 : -10;
  playIosMediaUnlock();
  if (!(await ensureContextRunning())) return false;

  await createFxChain();

  // Низкий гул (Vrioon-слой)
  droneFilter = new Tone.Filter(220, "lowpass").connect(reverb);
  drone = new Tone.FMSynth({
    harmonicity: 1.02,
    modulationIndex: 0.6,
    oscillator: { type: "sine" },
    envelope: { attack: 4, decay: 0.2, sustain: 0.55, release: 10 },
    modulationEnvelope: { attack: 3, decay: 0, sustain: 1, release: 8 },
  }).connect(droneFilter);
  drone.volume.value = isTouch() ? -8 : -14;

  // Длинный «сакамото»-пад
  pad = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 3,
    oscillator: { type: "sine" },
    envelope: { attack: 2.5, decay: 1, sustain: 0.4, release: 6 },
  }).connect(reverb);
  pad.volume.value = isTouch() ? -12 : -18;

  // Фоновый тик: тише, розовый шум, длиннее хвост — «далеко в комнате»
  idleTick = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.04 },
  }).connect(reverb);
  idleTick.volume.value = -28;

  burstPool = Array.from({ length: 12 }, () => {
    const s = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.028, sustain: 0, release: 0.012 },
    }).connect(reverb);
    s.volume.value = -14;
    return s;
  });
  burstSynthNext = burstPool.map(() => 0);
  burstTimeline = 0;

  pingSynth = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.5, sustain: 0, release: 0.8 },
  }).connect(reverb);
  pingSynth.volume.value = -20;

  chordSynth = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 4,
    harmonicity: 0.5,
    modulationIndex: 1.1,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.9, decay: 0.4, sustain: 0.4, release: 5 },
  }).connect(reverb);
  chordSynth.volume.value = -16;

  drone.triggerAttack("D2");
  // Мягкий стартовый аккорд — сразу слышно, что звук живой
  const t0 = Tone.now() + 0.05;
  pad.triggerAttackRelease(["D3", "A3", "F4"], "2n", t0, isTouch() ? 0.45 : 0.25);
  // Короткий «чирп» — сразу слышно на динамике телефона
  pingSynth.triggerAttackRelease("A4", "8n", t0 + 0.08, isTouch() ? 0.35 : 0.2);

  // Idle редко: раз в ~4 такта, шанс ~30%, и пауза после жеста
  idleLoop = new Tone.Loop(time => {
    if (muted || time < idleQuietUntil) return;
    if (Math.random() < 0.3) {
      idleTick.triggerAttackRelease("32n", time, 0.2 + Math.random() * 0.25);
    } else if (Math.random() < 0.12) {
      const note = SCALE[(Math.random() * SCALE.length) | 0];
      pingSynth.triggerAttackRelease(note, "8n", time, 0.1);
    }
  }, "4m").start(0);
  Tone.Transport.start();

  const running = Tone.getContext().rawContext?.state === "running";
  ready = running;
  return running;
  } catch (err) {
    console.warn("startAudio failed", err);
    ready = false;
    return false;
  }
}

export function isAudioReady() {
  return ready;
}

/** Повтор после Start, если контекст не поднялся */
export async function retryAudio() {
  unlockAudioContext();
  return startAudio();
}

export function getAudioDebugState() {
  const ctx = Tone?.getContext?.()?.rawContext;
  return ctx ? ctx.state : "no-tone";
}

export function setMuted(value) {
  muted = value;
  if (!master) return;
  master.volume.rampTo(muted ? -100 : masterDb, 0.25);
}

export function isMuted() {
  return muted;
}

/** Фон: плотность слов у руки и высота ладони */
export function updateAmbient({ nearCount = 0, handYNorm = 0.5 } = {}) {
  if (!ready || muted) return;
  const density = Math.min(1, nearCount / 8);
  droneFilter.frequency.rampTo(160 + density * 380 + (1 - handYNorm) * 100, 0.2);
  drone.volume.rampTo(-16 + density * 5, 0.25);
}

/** Цвет слова → редкий «пинг» */
export function pingFromHue(hue) {
  if (!ready || muted) return;
  if (Math.random() > 0.12) return;
  pingSynth.triggerAttackRelease(hueToNote(hue), "8n", Tone.now(), 0.18);
}

/** Кулак: три ноты «сложилось» */
export function playChord(hues = []) {
  if (!ready || muted || !hues.length) return;
  const now = Tone.now();
  idleQuietUntil = now + 2.5;
  const notes = hues.slice(0, 3).map(h => hueToNote(h));
  chordSynth.triggerAttackRelease(notes, "2n", now, 0.4);
}

/** Раскрытие: россыпь ударов (как смыслы разлетаются) + reverb swell */
export function playBurst() {
  if (!ready || muted) return;
  const now = Tone.now();
  if (lastBurstAudioAt >= 0 && now - lastBurstAudioAt < 0.42) return;
  lastBurstAudioAt = now;
  idleQuietUntil = now + 3.2;
  const hits = 8 + ((Math.random() * 4) | 0); // 8–11
  const t0 = Math.max(now + 0.02, burstTimeline + 0.02);
  for (let i = 0; i < hits; i++) {
    const si = i % burstPool.length;
    const synth = burstPool[si];
    const t = Math.max(t0 + i * 0.026 + Math.random() * 0.006, burstSynthNext[si] + 0.001);
    burstSynthNext[si] = t + 0.045;
    const vel = 0.35 + Math.random() * 0.55;
    synth.triggerAttackRelease("32n", t, vel);
  }
  burstTimeline = t0 + hits * 0.026 + 0.08;
  if (reverb?.wet?.cancelScheduledValues) {
    reverb.wet.cancelScheduledValues(now);
    reverb.wet.rampTo(isTouch() ? 0.45 : 0.58, 0.06);
    reverb.wet.rampTo(isTouch() ? 0.32 : 0.38, 1.5);
  }
}

export function disposeAudio() {
  if (!ready) return;
  idleLoop?.stop();
  idleLoop?.dispose();
  Tone.Transport.stop();
  drone?.triggerRelease();
  drone?.dispose();
  droneFilter?.dispose();
  pad?.dispose();
  idleTick?.dispose();
  burstPool?.forEach(s => s.dispose());
  pingSynth?.dispose();
  chordSynth?.dispose();
  reverb?.dispose();
  master?.dispose();
  ready = false;
}
