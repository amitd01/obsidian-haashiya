// sound.js — typing sounds, synthesized with Web Audio (no sample files to ship or license).
// Each keystroke is a few short bursts of filtered noise plus, for some, a tone:
//   typewriter — type-bar strike + platen thud; Enter rings the bell and ratchets the carriage back.
//   keyboard   — a buckling-spring board (TVS Gold / Model M): crisp click, spring ping, bottom-out clack.
//   notes      — every key plays a note of the chosen scale and key, by its place on the keyboard.
// Small random variation per stroke keeps it from sounding like a machine gun.

let ctx, out, noise, volume = 0.8;

// Filtered clicks carry little energy, so the master gain is high; a limiter keeps loud strokes clean.
const BOOST = 3;
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, +v));
  if (out) out.gain.value = volume * BOOST;
}

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    out = ctx.createGain();
    out.gain.value = volume * BOOST;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -6;
    limit.ratio.value = 12;
    out.connect(limit).connect(ctx.destination);
    // Half a second of white noise, reused by every burst.
    noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const vary = (x, by = 0.08) => x * (1 + (Math.random() * 2 - 1) * by);

// Filtered noise with an instant attack and exponential decay — the basic "click".
function burst(t, { freq, q = 1, gain, decay, type = 'bandpass' }) {
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noise;
  f.type = type;
  f.frequency.value = vary(freq);
  f.Q.value = q;
  g.gain.setValueAtTime(vary(gain, 0.15), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.3);
  src.stop(t + decay + 0.02);
}

// A decaying tone — the bell, or a key spring's ring.
function tone(t, { freq, gain, decay, type = 'sine' }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.02);
}

// Scales as semitones above the tonic. Every note of the scale is used.
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
};
export const TONICS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let scale = SCALES.major, tonic = 0;
export function setMusic(name, key) {
  scale = SCALES[name] || SCALES.major;
  tonic = Math.max(0, TONICS.indexOf(key));
}

// A soft, piano-like note: fundamental + a quiet octave, quick attack, long fade.
function note(t, semis, { gain = 0.22, decay = 0.9 } = {}) {
  const freq = 130.81 * 2 ** ((semis + tonic) / 12); // semitones above the tonic, from the C3 octave
  for (const [mult, g, type] of [[1, gain, 'sine'], [2, gain * 0.25, 'triangle']]) {
    const o = ctx.createOscillator(), v = ctx.createGain();
    o.type = type;
    o.frequency.value = freq * mult;
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(g, t + 0.006);
    v.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(v).connect(out);
    o.start(t);
    o.stop(t + decay + 0.02);
  }
}

// Physical keys (e.code, so any layout works) → [row, position]. Along a row the notes climb the scale;
// each row starts about a fifth above the one below, so the whole keyboard stays in the scale.
const ROWS = ['ZXCVBNM,./', 'ASDFGHJKL;\'', 'QWERTYUIOP[]', '1234567890-='];
const CODE = { ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal' };
const KEYPOS = {};
ROWS.forEach((row, r) => [...row].forEach((c, p) => {
  KEYPOS[CODE[c] || (/\d/.test(c) ? 'Digit' + c : 'Key' + c)] = [r, p];
}));
// Semitones above the tonic for the d-th degree of the current scale (degrees past the top wrap up an octave).
const degree = d => scale[d % scale.length] + 12 * Math.floor(d / scale.length);
function pitch(code) {
  const pos = KEYPOS[code];
  if (!pos) return 12;                                   // keys off the map (accents, symbols): the tonic
  const fifth = Math.round(scale.length * 4 / 7);        // a fifth, counted in scale degrees
  return degree(pos[0] * fifth + pos[1]);
}

const PROFILES = {
  typewriter: {
    key(t) {
      burst(t, { freq: 2600, q: 1.4, gain: 0.55, decay: 0.03 });               // type bar hits the ribbon
      burst(t, { freq: 160, type: 'lowpass', gain: 0.6, decay: 0.06 });        // body thud
      burst(t + 0.012, { freq: 900, q: 2, gain: 0.18, decay: 0.07 });          // platen rings a little
    },
    space(t) {
      burst(t, { freq: 1200, q: 0.8, gain: 0.35, decay: 0.04 });               // no strike, just the escapement
      burst(t, { freq: 120, type: 'lowpass', gain: 0.45, decay: 0.07 });
    },
    back(t) { burst(t, { freq: 1800, q: 1, gain: 0.3, decay: 0.035 }); },
    enter(t) {
      tone(t, { freq: 2093, gain: 0.22, decay: 1.1 });                         // the bell
      tone(t, { freq: 4186, gain: 0.05, decay: 0.6 });
      for (let i = 0; i < 9; i++) burst(t + 0.08 + i * 0.022, { freq: 3000, q: 3, gain: 0.18, decay: 0.012 }); // ratchet
      burst(t + 0.3, { freq: 140, type: 'lowpass', gain: 0.7, decay: 0.12 });  // carriage slams home
    },
  },
  keyboard: {
    key(t) {
      burst(t, { freq: 4800, q: 2.5, gain: 0.5, decay: 0.012 });               // the buckling-spring click
      tone(t, { freq: vary(3300, 0.05), gain: 0.03, decay: 0.05, type: 'triangle' }); // spring ping
      burst(t + 0.022, { freq: 1100, q: 1.2, gain: 0.4, decay: 0.035 });       // bottom-out
      burst(t + 0.022, { freq: 220, type: 'lowpass', gain: 0.35, decay: 0.04 });
    },
    space(t) {
      burst(t, { freq: 3800, q: 2, gain: 0.35, decay: 0.014 });
      burst(t + 0.025, { freq: 600, q: 1, gain: 0.5, decay: 0.06 });           // long bar, deeper clack
      burst(t + 0.025, { freq: 150, type: 'lowpass', gain: 0.45, decay: 0.06 });
    },
    back(t) { PROFILES.keyboard.key(t); },
    enter(t) {
      burst(t, { freq: 4200, q: 2, gain: 0.5, decay: 0.014 });
      burst(t + 0.03, { freq: 800, q: 1, gain: 0.55, decay: 0.06 });
      burst(t + 0.03, { freq: 160, type: 'lowpass', gain: 0.5, decay: 0.06 });
    },
  },
  notes: {
    key(t, code) { note(t, pitch(code)); },
    space(t) { note(t, -12, { gain: 0.16, decay: 0.6 }); },
    back(t) { note(t, 5, { gain: 0.12, decay: 0.25 }); note(t + 0.05, 2, { gain: 0.1, decay: 0.3 }); },
    enter(t) { [0, 2, 4, 7].forEach((d, k) => note(t + k * 0.045, 12 + degree(d), { gain: 0.14, decay: 1.4 })); }, // arpeggio in the scale
  },
};
export const KINDS = Object.keys(PROFILES);

// Play the sound for a keydown. kind: 'typewriter' | 'keyboard' | 'notes' | anything else = silent.
// code is the physical key (KeyboardEvent.code) — only the notes profile uses it.
export function keystroke(kind, key, code = '') {
  const p = PROFILES[kind];
  if (!p) return;
  const which = key === 'Enter' ? 'enter' : key === ' ' ? 'space' : key === 'Backspace' || key === 'Delete' ? 'back' : key.length === 1 ? 'key' : null;
  if (!which) return; // arrows, Shift, Tab… stay silent
  try { audio(); p[which](ctx.currentTime + 0.001, code); } catch { /* no audio device: stay quiet */ }
}
