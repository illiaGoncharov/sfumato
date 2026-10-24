/**
 * Генеративный эмбиент в духе серии Noto × Sakamoto
 * Tone.js — UMD (vendor/Tone.js) → globalThis.Tone.
 */
const Tone = globalThis.Tone;
if (!Tone) throw new Error("Load vendor/Tone.js before audio.js");

const SCALE = ["D3", "F3", "G3", "A3", "C4", "D4", "F4", "G4", "A4"];
const isTouch = () =>
  matchMedia("(pointer: coarse)").matches
  || /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 0 && matchMedia("(max-width: 900px)").matches);

let masterDb = -10;
let ready = false;
let muted = false;
let master;
/** На десктопе — reverb/delay; на телефоне — заглушка для playBurst */
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
let idleTimer = null;
let idleQuietUntil = 0;
let lastBurstAudioAt = -1;
let iosUnlockEl;
let contextWired = false;

function hueToNote(hue) {
  const i = Math.floor(((hue % 360) / 360) * SCALE.length) % SCALE.length;
  return SCALE[i];
}

function contextRunning() {
  const ctx = Tone?.getContext?.()?.rawContext;
  return ctx?.state === "running";
}

function wireContextWatch() {
  if (contextWired) return;
  const ctx = Tone.getContext().rawContext;
  if (!ctx) return;
  contextWired = true;
  ctx.addEventListener("statechange", () => {
    if (ctx.state !== "running") ready = false;
  });
}

function playIosMediaUnlock() {
  if (!isTouch()) return;
  try {
    iosUnlockEl ??= new Audio(
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
    );
    iosUnlockEl.setAttribute("playsinline", "true");
    iosUnlockEl.volume = 0.08;
    void iosUnlockEl.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Сырой бип — сразу в tap, даже если Tone ещё «suspended» */
function fireRawPing(ctx) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  osc.frequency.value = 440;
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.12);
}

function playGesturePing() {
  try {
    const ctx = Tone.getContext().rawContext;
    if (!ctx) return;
    if (ctx.state === "running") fireRawPing(ctx);
    else void ctx.resume().then(() => fireRawPing(ctx)).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Синхронно в tap/click — до любого await */
export function unlockAudioContext() {
  playIosMediaUnlock();
  if (!Tone) return;
  try {
    Tone.start();
    const ctx = Tone.getContext().rawContext;
    if (ctx?.state === "suspended" && ctx.resume) void ctx.resume();
    wireContextWatch();
    playGesturePing();
  } catch (err) {
    console.warn("audio unlock failed", err);
  }
}

export const primeAudioGesture = unlockAudioContext;

async function ensureContextRunning() {
  await Tone.start();
  const ctx = Tone.getContext().rawContext;
  if (ctx?.state === "suspended" && ctx.resume) await ctx.resume();
  wireContextWatch();
  return ctx?.state === "running";
}

function noopFx() {
  return { wet: { cancelScheduledValues() {}, rampTo() {} } };
}

async function createFxChainDesktop() {
  master = new Tone.Volume(masterDb).toDestination();
  reverb = new Tone.Reverb({ decay: 11, wet: 0.38 }).connect(master);
  try {
    await reverb.generate();
  } catch (err) {
    console.warn("reverb generate failed, shorter tail", err);
    reverb.decay = 4;
    await reverb.generate();
  }
}

function createFxChainMobile() {
  masterDb = 0;
  master = new Tone.Volume(masterDb).toDestination();
  reverb = noopFx();
}

function markReady(fromGesture) {
  const running = contextRunning();
  if (isTouch()) ready = fromGesture && running;
  else ready = running;
  return ready;
}

function startMobileIdle() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!ready || muted) return;
    const now = Tone.now();
    if (now < idleQuietUntil) return;
    if (Math.random() < 0.35) {
      idleTick?.triggerAttackRelease("32n", now, 0.35 + Math.random() * 0.3);
    } else if (Math.random() < 0.15) {
      const note = SCALE[(Math.random() * SCALE.length) | 0];
      pingSynth?.triggerAttackRelease(note, "8n", now, 0.22);
    }
  }, 2800);
}

/** Safari/iOS: без Transport и Reverb — проще и громче */
async function startAudioMobile(fromGesture) {
  playIosMediaUnlock();
  if (!(await ensureContextRunning())) {
    ready = false;
    return false;
  }
  createFxChainMobile();

  drone = new Tone.Oscillator({ frequency: "D2", type: "sine" }).connect(master);
  drone.volume.value = -10;
  drone.start();

  pad = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 3,
    oscillator: { type: "sine" },
    envelope: { attack: 0.4, decay: 0.3, sustain: 0.5, release: 4 },
  }).connect(master);
  pad.volume.value = -8;

  idleTick = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.03 },
  }).connect(master);
  idleTick.volume.value = -18;

  burstPool = Array.from({ length: 8 }, () => {
    const s = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.01 },
    }).connect(master);
    s.volume.value = -8;
    return s;
  });
  burstSynthNext = burstPool.map(() => 0);
  burstTimeline = 0;

  pingSynth = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.35, sustain: 0, release: 0.5 },
  }).connect(master);
  pingSynth.volume.value = -10;

  chordSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 4,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.15, decay: 0.3, sustain: 0.35, release: 3 },
  }).connect(master);
  chordSynth.volume.value = -10;

  droneFilter = { frequency: { rampTo() {} } };

  const now = Tone.now();
  pad.triggerAttackRelease(["D3", "A3", "F4"], "2n", now + 0.02, 0.65);
  pingSynth.triggerAttackRelease("A4", "8n", now + 0.06, 0.7);
  startMobileIdle();

  return markReady(fromGesture);
}

async function startAudioDesktop(fromGesture) {
  masterDb = -10;
  if (!(await ensureContextRunning())) {
    ready = false;
    return false;
  }
  await createFxChainDesktop();

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

  return markReady(fromGesture);
}

export async function startAudio(options = {}) {
  const fromGesture = Boolean(options.fromGesture);

  if (ready && contextRunning()) return true;
  if (ready && !contextRunning()) ready = false;
  if (master && !ready) disposeAudio();

  try {
    unlockAudioContext();
    if (isTouch()) return startAudioMobile(fromGesture);
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
  if (master) disposeAudio();
  return startAudio({ fromGesture: true });
}

export function getAudioDebugState() {
  const ctx = Tone?.getContext?.()?.rawContext;
  if (!ctx) return "no-tone";
  return ready ? ctx.state : `init·${ctx.state}`;
}

export function setMuted(value) {
  muted = value;
  if (!master) return;
  master.volume.rampTo(muted ? -100 : masterDb, 0.25);
}

export function isMuted() {
  return muted;
}

export function nudgeAudio() {
  unlockAudioContext();
  if (!pingSynth || muted) return;
  pingSynth.triggerAttackRelease("A4", "8n", Tone.now() + 0.01, 0.75);
}

export function updateAmbient({ nearCount = 0, handYNorm = 0.5 } = {}) {
  if (!isAudioReady() || muted || !drone?.volume) return;
  const density = Math.min(1, nearCount / 8);
  if (droneFilter?.frequency?.rampTo) {
    droneFilter.frequency.rampTo(160 + density * 380 + (1 - handYNorm) * 100, 0.2);
  }
  drone.volume.rampTo(isTouch() ? -8 + density * 4 : -16 + density * 5, 0.25);
}

export function pingFromHue(hue) {
  if (!isAudioReady() || muted) return;
  if (Math.random() > 0.12) return;
  pingSynth.triggerAttackRelease(hueToNote(hue), "8n", Tone.now(), 0.18);
}

export function playChord(hues = []) {
  if (!isAudioReady() || muted || !hues.length) return;
  const now = Tone.now();
  idleQuietUntil = now + 2.5;
  const notes = hues.slice(0, 3).map(h => hueToNote(h));
  chordSynth.triggerAttackRelease(notes, "2n", now, isTouch() ? 0.55 : 0.4);
}

export function playBurst() {
  if (!isAudioReady() || muted) return;
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
  if (!master && !ready) return;
  clearInterval(idleTimer);
  idleTimer = null;
  idleLoop?.stop();
  idleLoop?.dispose();
  idleLoop = null;
  Tone.Transport.stop();
  if (drone instanceof Tone.Oscillator) {
    drone.stop();
    drone.dispose();
  } else {
    drone?.triggerRelease();
    drone?.dispose();
  }
  droneFilter?.dispose?.();
  pad?.dispose();
  idleTick?.dispose();
  burstPool?.forEach(s => s.dispose());
  pingSynth?.dispose();
  chordSynth?.dispose();
  reverb?.dispose?.();
  master?.dispose();
  drone = droneFilter = pad = idleTick = burstPool = pingSynth = chordSynth = reverb = master = null;
  burstSynthNext = [];
  ready = false;
}
