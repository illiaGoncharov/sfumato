/**
 * Генеративный эмбиент: сухие импульсы (Alva Noto) + длинные ноты (Sakamoto).
 * Запуск только после жеста пользователя (Tone.start).
 */
import * as Tone from "../vendor/tone/index.js";

const SCALE = ["D3", "F3", "A3", "C4", "D4", "F4", "A4", "C5"];
const MASTER_DB = -20;

let ready = false;
let muted = false;
let master;
let reverb;
let drone;
let droneFilter;
let clickSynth;
let pingSynth;
let chordSynth;

function hueToNote(hue) {
  const i = Math.floor(((hue % 360) / 360) * SCALE.length) % SCALE.length;
  return SCALE[i];
}

export async function startAudio() {
  if (ready) return;
  await Tone.start();

  master = new Tone.Volume(MASTER_DB).toDestination();
  reverb = new Tone.Reverb({ decay: 9, wet: 0.42 }).connect(master);
  await reverb.generate();

  droneFilter = new Tone.Filter(280, "lowpass").connect(reverb);
  drone = new Tone.FMSynth({
    harmonicity: 1.01,
    modulationIndex: 0.8,
    oscillator: { type: "sine" },
    envelope: { attack: 3, decay: 0.2, sustain: 0.35, release: 8 },
    modulationEnvelope: { attack: 2, decay: 0, sustain: 1, release: 6 },
  }).connect(droneFilter);
  drone.volume.value = -22;

  clickSynth = new Tone.MembraneSynth({
    pitchDecay: 0.008,
    octaves: 1.2,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.04 },
  }).connect(reverb);
  clickSynth.volume.value = -28;

  pingSynth = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 0.35, sustain: 0, release: 0.6 },
  }).connect(reverb);
  pingSynth.volume.value = -32;

  chordSynth = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 4,
    volume: -24,
    options: {
      harmonicity: 0.5,
      modulationIndex: 1.2,
      oscillator: { type: "triangle" },
      envelope: { attack: 0.8, decay: 0.3, sustain: 0.45, release: 5 },
    },
  }).connect(reverb);

  drone.triggerAttack("D2");
  ready = true;
}

export function isAudioReady() {
  return ready;
}

export function setMuted(value) {
  muted = value;
  if (!master) return;
  master.volume.rampTo(muted ? -100 : MASTER_DB, 0.25);
}

export function isMuted() {
  return muted;
}

/** Фон: плотность слов у руки и высота ладони */
export function updateAmbient({ nearCount = 0, handYNorm = 0.5 } = {}) {
  if (!ready || muted) return;
  const density = Math.min(1, nearCount / 8);
  droneFilter.frequency.rampTo(180 + density * 420 + (1 - handYNorm) * 120, 0.15);
  drone.volume.rampTo(-26 + density * 6, 0.2);
}

/** Цвет слова → редкий «пинг» */
export function pingFromHue(hue) {
  if (!ready || muted) return;
  if (Math.random() > 0.08) return;
  pingSynth.triggerAttackRelease(hueToNote(hue), "8n", Tone.now(), 0.15);
}

/** Кулак: три ноты «сложилось» */
export function playChord(hues = []) {
  if (!ready || muted || !hues.length) return;
  const notes = hues.slice(0, 3).map(h => hueToNote(h));
  chordSynth.triggerAttackRelease(notes, "2n", Tone.now(), 0.35);
}

/** Раскрытие: сухой клик + reverb swell */
export function playBurst() {
  if (!ready || muted) return;
  clickSynth.triggerAttackRelease("C2", "32n", Tone.now(), 0.4);
  reverb.wet.rampTo(0.55, 0.08);
  reverb.wet.rampTo(0.42, 1.2);
}

export function disposeAudio() {
  if (!ready) return;
  drone?.triggerRelease();
  drone?.dispose();
  droneFilter?.dispose();
  clickSynth?.dispose();
  pingSynth?.dispose();
  chordSynth?.dispose();
  reverb?.dispose();
  master?.dispose();
  ready = false;
}
