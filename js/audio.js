/**
 * Десктоп: Tone.js (vendor/Tone.js).
 * Телефон / Safari: чистый Web Audio (Tone на iOS часто «running» без звука).
 */
const Tone = globalThis.Tone;

const SCALE = ["D3", "F3", "G3", "A3", "C4", "D4", "F4", "G4", "A4"];
const NOTE_FREQ = {
  D2: 73.42,
  D3: 146.83,
  F3: 174.61,
  G3: 196,
  A3: 220,
  C4: 261.63,
  D4: 293.66,
  F4: 349.23,
  G4: 392,
  A4: 440,
};

const isTouch = () =>
  matchMedia("(pointer: coarse)").matches
  || /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 0 && matchMedia("(max-width: 900px)").matches);

const useNative = () => isTouch();

let ready = false;
let muted = false;
let idleQuietUntil = 0;
let lastBurstAudioAt = -1;
let idleTimer = null;
let iosUnlockEl;
let htmlAmbience = null;
let htmlAmbienceUrl = null;

// --- Native (iOS / touch) ---
let nativeCtx = null;
let nativeMaster = null;
let nativeDrone = null;
let nativeDroneGain = null;
let nativeFilter = null;
let nativeGraphLive = false;

// --- Tone (desktop) ---
let masterDb = -10;
let master;
let reverb;
let drone;
let droneFilter;
let pad;
let idleTick;
let burstPool;
let burstSynthNext = [];
let burstTimeline = 0;
let pingSynth;
let chordSynth;
let idleLoop;
let contextWired = false;

function noteToFreq(note) {
  return NOTE_FREQ[note] ?? 220;
}

function hueToNote(hue) {
  const i = Math.floor(((hue % 360) / 360) * SCALE.length) % SCALE.length;
  return SCALE[i];
}

function getNativeCtx() {
  if (nativeCtx) return nativeCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  nativeCtx = new AC();
  nativeCtx.addEventListener("statechange", () => {
    if (nativeCtx?.state !== "running") ready = false;
  });
  return nativeCtx;
}

function contextRunning() {
  if (useNative()) return nativeCtx?.state === "running" || htmlAmbiencePlaying();
  const ctx = Tone?.getContext?.()?.rawContext;
  return ctx?.state === "running";
}

function playIosMediaUnlock() {
  if (!useNative()) return;
  try {
    iosUnlockEl ??= new Audio(
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
    );
    iosUnlockEl.setAttribute("playsinline", "true");
    iosUnlockEl.volume = 0.35;
    void iosUnlockEl.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Короткий loop-WAV — запасной путь через <audio> (Safari/Chrome iOS) */
function buildLoopedWav(freq, sec = 2.2, sr = 22050) {
  const samples = (sr * sec) | 0;
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, dataSize, true);
  const out = new Int16Array(buf, 44);
  const fade = sr * 0.08;
  for (let i = 0; i < samples; i++) {
    const t = i / sr;
    let env = 1;
    if (i < fade) env = i / fade;
    else if (i > samples - fade) env = (samples - i) / fade;
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * 11000;
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function htmlAmbiencePlaying() {
  return Boolean(htmlAmbience && !htmlAmbience.paused);
}

async function playHtmlAmbience() {
  if (!useNative()) return false;
  try {
    htmlAmbienceUrl ??= buildLoopedWav(NOTE_FREQ.D2);
    htmlAmbience ??= new Audio();
    htmlAmbience.src = htmlAmbienceUrl;
    htmlAmbience.loop = true;
    htmlAmbience.volume = muted ? 0 : 0.5;
    htmlAmbience.setAttribute("playsinline", "true");
    await htmlAmbience.play();
    return true;
  } catch (err) {
    console.warn("html ambience failed", err);
    return false;
  }
}

function stopHtmlAmbience() {
  try {
    htmlAmbience?.pause();
    if (htmlAmbience) htmlAmbience.currentTime = 0;
  } catch {
    /* ignore */
  }
}

function fireRawPing(ctx) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  osc.frequency.value = 440;
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.15);
}

/** Синхронно в tap: контекст + дрон + бип (Safari) */
function primeNativeGraphSync() {
  const ctx = getNativeCtx();
  if (!ctx) return;
  if (ctx.state === "suspended" && ctx.resume) void ctx.resume();
  if (!nativeMaster) {
    nativeMaster = ctx.createGain();
    nativeMaster.gain.value = muted ? 0 : 0.5;
    nativeMaster.connect(ctx.destination);
  }
  if (!nativeDrone) {
    nativeFilter = ctx.createBiquadFilter();
    nativeFilter.type = "lowpass";
    nativeFilter.frequency.value = 520;
    nativeFilter.Q.value = 0.7;
    nativeDroneGain = ctx.createGain();
    nativeDroneGain.gain.value = 0.14;
    nativeDrone = ctx.createOscillator();
    nativeDrone.type = "sine";
    nativeDrone.frequency.value = NOTE_FREQ.D2;
    nativeDrone.connect(nativeFilter).connect(nativeDroneGain).connect(nativeMaster);
    nativeDrone.start();
    nativeGraphLive = true;
  }
  fireRawPing(ctx);
}

function nativePlayTone(freq, offsetSec, duration, volume = 0.25) {
  const ctx = nativeCtx;
  if (!ctx || !nativeMaster || muted) return;
  const when = ctx.currentTime + offsetSec;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(volume, when + 0.025);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.type = "triangle";
  osc.frequency.value = freq;
  osc.connect(g).connect(nativeMaster);
  osc.start(when);
  osc.stop(when + duration + 0.05);
}

function nativePlayNoise(offsetSec, volume = 0.35, duration = 0.04) {
  const ctx = nativeCtx;
  if (!ctx || !nativeMaster || muted) return;
  const when = ctx.currentTime + offsetSec;
  const len = Math.max(1, (ctx.sampleRate * duration) | 0);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(volume, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  src.connect(g).connect(nativeMaster);
  src.start(when);
  src.stop(when + duration + 0.02);
}

function startNativeIdle() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!ready || muted || !nativeCtx) return;
    const now = nativeCtx.currentTime;
    if (now < idleQuietUntil) return;
    if (Math.random() < 0.4) nativePlayNoise(0, 0.12 + Math.random() * 0.15, 0.035);
    else if (Math.random() < 0.2) {
      const note = SCALE[(Math.random() * SCALE.length) | 0];
      nativePlayTone(noteToFreq(note), 0, 0.22, 0.15);
    }
  }, 2600);
}

function disposeNative() {
  clearInterval(idleTimer);
  idleTimer = null;
  stopHtmlAmbience();
  try {
    nativeDrone?.stop();
  } catch {
    /* ignore */
  }
  nativeDrone = null;
  nativeDroneGain = null;
  nativeFilter = null;
  nativeMaster = null;
  nativeGraphLive = false;
  if (nativeCtx?.state !== "closed") void nativeCtx?.close?.();
  nativeCtx = null;
  ready = false;
}

async function startNativeAudio(fromGesture) {
  playIosMediaUnlock();
  if (!nativeGraphLive) primeNativeGraphSync();
  const htmlOk = await playHtmlAmbience();
  const ctx = getNativeCtx();
  if (!ctx) {
    ready = htmlOk && fromGesture;
    return ready;
  }
  if (ctx.state === "suspended") await ctx.resume();
  const webOk = ctx.state === "running";
  if (webOk) {
    nativePlayTone(NOTE_FREQ.D3, 0.03, 0.9, 0.28);
    nativePlayTone(NOTE_FREQ.A3, 0.05, 0.85, 0.22);
    nativePlayTone(NOTE_FREQ.F4, 0.07, 0.8, 0.2);
    nativePlayTone(NOTE_FREQ.A4, 0.1, 0.35, 0.35);
    startNativeIdle();
  }
  ready = fromGesture && (webOk || htmlOk);
  return ready;
}

/** Синхронно в tap/click — до await */
export function unlockAudioContext() {
  if (useNative()) {
    playIosMediaUnlock();
    primeNativeGraphSync();
    return;
  }
  if (!Tone) return;
  try {
    Tone.start();
    const ctx = Tone.getContext().rawContext;
    if (ctx?.state === "suspended" && ctx.resume) void ctx.resume();
    wireContextWatch();
    fireRawPing(ctx);
  } catch (err) {
    console.warn("audio unlock failed", err);
  }
}

export const primeAudioGesture = unlockAudioContext;

function wireContextWatch() {
  if (contextWired || !Tone) return;
  const ctx = Tone.getContext().rawContext;
  if (!ctx) return;
  contextWired = true;
  ctx.addEventListener("statechange", () => {
    if (ctx.state !== "running") ready = false;
  });
}

async function ensureToneRunning() {
  await Tone.start();
  const ctx = Tone.getContext().rawContext;
  if (ctx?.state === "suspended" && ctx.resume) await ctx.resume();
  wireContextWatch();
  return ctx?.state === "running";
}

async function startAudioDesktop(fromGesture) {
  if (!Tone) throw new Error("Load vendor/Tone.js before audio.js");
  masterDb = -10;
  if (!(await ensureToneRunning())) {
    ready = false;
    return false;
  }
  master = new Tone.Volume(masterDb).toDestination();
  reverb = new Tone.Reverb({ decay: 11, wet: 0.38 }).connect(master);
  try {
    await reverb.generate();
  } catch (err) {
    console.warn("reverb generate failed, shorter tail", err);
    reverb.decay = 4;
    await reverb.generate();
  }

  droneFilter = new Tone.Filter(220, "lowpass").connect(reverb);
  drone = new Tone.FMSynth({
    harmonicity: 1.02,
    modulationIndex: 0.6,
    oscillator: { type: "sine" },
    envelope: { attack: 4, decay: 0.2, sustain: 0.55, release: 10 },
    modulationEnvelope: { attack: 3, decay: 0, sustain: 1, release: 8 },
  }).connect(droneFilter);
  drone.volume.value = -14;

  pad = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 3,
    oscillator: { type: "sine" },
    envelope: { attack: 2.5, decay: 1, sustain: 0.4, release: 6 },
  }).connect(reverb);
  pad.volume.value = -18;

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
  const t0 = Tone.now() + 0.05;
  pad.triggerAttackRelease(["D3", "A3", "F4"], "2n", t0, 0.25);
  pingSynth.triggerAttackRelease("A4", "8n", t0 + 0.08, 0.2);

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

  ready = contextRunning();
  return ready;
}

export async function startAudio(options = {}) {
  const fromGesture = Boolean(options.fromGesture);
  const restart = Boolean(options.restart);
  if (ready && contextRunning()) return true;
  if (ready && !contextRunning()) ready = false;

  // Не убивать контекст, созданный в том же tap (prime → startAudio)
  if (restart) disposeAudio();
  else if (!useNative() && master) disposeAudio();

  try {
    if (!useNative() || restart || !nativeGraphLive) unlockAudioContext();
    if (useNative()) return startNativeAudio(fromGesture);
    return startAudioDesktop(fromGesture);
  } catch (err) {
    console.warn("startAudio failed", err);
    ready = false;
    return false;
  }
}

export function isAudioReady() {
  if (!ready) return false;
  return contextRunning();
}

export async function retryAudio() {
  unlockAudioContext();
  return startAudio({ fromGesture: true, restart: true });
}

export function getAudioDebugState() {
  if (useNative()) return nativeCtx ? (ready ? nativeCtx.state : `init·${nativeCtx.state}`) : "no-ctx";
  const ctx = Tone?.getContext?.()?.rawContext;
  if (!ctx) return "no-tone";
  return ready ? ctx.state : `init·${ctx.state}`;
}

export function setMuted(value) {
  muted = value;
  if (htmlAmbience) htmlAmbience.volume = muted ? 0 : 0.5;
  if (useNative() && nativeMaster && nativeCtx) {
    nativeMaster.gain.setTargetAtTime(muted ? 0 : 0.5, nativeCtx.currentTime, 0.06);
    return;
  }
  if (!master) return;
  master.volume.rampTo(muted ? -100 : masterDb, 0.25);
}

export function isMuted() {
  return muted;
}

export function nudgeAudio() {
  unlockAudioContext();
  if (muted) return;
  if (useNative()) {
    nativePlayTone(NOTE_FREQ.A4, 0.01, 0.3, 0.4);
    return;
  }
  pingSynth?.triggerAttackRelease("A4", "8n", Tone.now() + 0.01, 0.75);
}

export function updateAmbient({ nearCount = 0, handYNorm = 0.5 } = {}) {
  if (!isAudioReady() || muted) return;
  const density = Math.min(1, nearCount / 8);
  if (useNative() && nativeFilter && nativeDroneGain && nativeCtx) {
    const t = nativeCtx.currentTime;
    nativeFilter.frequency.setTargetAtTime(180 + density * 520 + (1 - handYNorm) * 120, t, 0.15);
    nativeDroneGain.gain.setTargetAtTime(0.08 + density * 0.12, t, 0.2);
    return;
  }
  if (!drone?.volume) return;
  droneFilter?.frequency?.rampTo(160 + density * 380 + (1 - handYNorm) * 100, 0.2);
  drone.volume.rampTo(-16 + density * 5, 0.25);
}

export function pingFromHue(hue) {
  if (!isAudioReady() || muted) return;
  if (Math.random() > 0.12) return;
  const f = noteToFreq(hueToNote(hue));
  if (useNative()) nativePlayTone(f, 0, 0.2, 0.16);
  else pingSynth.triggerAttackRelease(hueToNote(hue), "8n", Tone.now(), 0.18);
}

export function playChord(hues = []) {
  if (!isAudioReady() || muted || !hues.length) return;
  const notes = hues.slice(0, 3).map(h => hueToNote(h));
  if (useNative()) {
    idleQuietUntil = (nativeCtx?.currentTime ?? 0) + 2.5;
    notes.forEach((n, i) => nativePlayTone(noteToFreq(n), i * 0.04, 0.75, 0.22));
    return;
  }
  const now = Tone.now();
  idleQuietUntil = now + 2.5;
  chordSynth.triggerAttackRelease(notes, "2n", now, 0.4);
}

export function playBurst() {
  if (!isAudioReady() || muted) return;
  if (useNative()) {
    const now = nativeCtx?.currentTime ?? 0;
    if (lastBurstAudioAt >= 0 && now - lastBurstAudioAt < 0.42) return;
    lastBurstAudioAt = now;
    idleQuietUntil = now + 3.2;
    const hits = 8 + ((Math.random() * 4) | 0);
    for (let i = 0; i < hits; i++) {
      nativePlayNoise(i * 0.028 + Math.random() * 0.008, 0.2 + Math.random() * 0.35, 0.03 + Math.random() * 0.02);
    }
    return;
  }
  const now = Tone.now();
  if (lastBurstAudioAt >= 0 && now - lastBurstAudioAt < 0.42) return;
  lastBurstAudioAt = now;
  idleQuietUntil = now + 3.2;
  const hits = 8 + ((Math.random() * 4) | 0);
  const t0 = Math.max(now + 0.02, burstTimeline + 0.02);
  for (let i = 0; i < hits; i++) {
    const si = i % burstPool.length;
    const synth = burstPool[si];
    const t = Math.max(t0 + i * 0.026 + Math.random() * 0.006, burstSynthNext[si] + 0.001);
    burstSynthNext[si] = t + 0.045;
    synth.triggerAttackRelease("32n", t, 0.45 + Math.random() * 0.45);
  }
  burstTimeline = t0 + hits * 0.026 + 0.08;
}

export function disposeAudio() {
  if (useNative() || nativeCtx) {
    disposeNative();
    return;
  }
  clearInterval(idleTimer);
  idleTimer = null;
  idleLoop?.stop();
  idleLoop?.dispose();
  idleLoop = null;
  Tone.Transport.stop();
  drone?.triggerRelease?.();
  drone?.dispose?.();
  droneFilter?.dispose?.();
  pad?.dispose?.();
  idleTick?.dispose?.();
  burstPool?.forEach(s => s.dispose());
  pingSynth?.dispose?.();
  chordSynth?.dispose?.();
  reverb?.dispose?.();
  master?.dispose?.();
  drone = droneFilter = pad = idleTick = burstPool = pingSynth = chordSynth = reverb = master = null;
  burstSynthNext = [];
  ready = false;
}
