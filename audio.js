/* Sound for the quinta, all of it quiet background:
     rain.mp3     loops while it rains
     birds.mp3    dawn chorus: starts in the dark before sunrise, fades through the morning
     rooster.mp3  once, at sunrise
     hens.mp3     soft clucking, looping through the day and stopping at dusk
     crickets.mp3 one cricket, chirp after chirp; at night it is played as several crickets around the garden,
                  now a few together, now just one or another
     thunder1-4   single claps; the weather calls strike() at each lightning flash and the thunder follows
   Files live in assets/audio/ (sources and licences in CREDITS.txt); a missing file is simply skipped.
   Browsers only allow sound after a click or key press, so everything starts on the first gesture. */

const FILES = { rain: 'rain.mp3', birds: 'birds.mp3', rooster: 'rooster.mp3', hens: 'hens.mp3', crickets: 'crickets.mp3',
  thunder1: 'thunder1.mp3', thunder2: 'thunder2.mp3', thunder3: 'thunder3.mp3', thunder4: 'thunder4.mp3' };
const LEVEL = { master: 0.85, rain: 0.6, birds: 0.45, hens: 0.42, rooster: 0.18, crickets: 0.06, thunder: 0.95 };
// The crickets of the garden: each is the same recording at its own pitch (rate), side (pan: -1 left .. 1 right) and distance (gain).
const CRICKETS = [{ rate: 1, pan: -0.5, gain: 1 }, { rate: 0.9, pan: 0.6, gain: 0.7 }, { rate: 1.07, pan: 0.15, gain: 0.45 },
  { rate: 0.95, pan: -0.9, gain: 0.35 }, { rate: 1.13, pan: 0.9, gain: 0.3 }];
// How many may sing at once. One is drawn every few seconds, so most of the time it is a lone cricket and now and then a small chorus.
const CROWDS = [1, 1, 1, 2, 2, 3, 4];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ramp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
const between = (a, b) => a + Math.random() * (b - a);

export function createSound(button) {
  let ctx = null, master = null, started = false, loading = false;
  let enabled = true;
  try { enabled = localStorage.getItem('jisso-som') !== 'off'; } catch { /* private window: keep the default */ }
  const buf = {}, layer = {};
  let prevP = null, night = 0;

  const paint = () => {
    const on = enabled && started;
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Desligar o som' : 'Ligar o som';
    button.classList.toggle('off', !on);
  };

  // a seamless loop: each pass fades in over the tail of the one before (equal-power, so the level holds)
  function loop(buffer, wanted = 1.6) {
    const out = ctx.createGain(); out.gain.value = 0; out.connect(master);
    const dur = buffer.duration, overlap = Math.min(wanted, dur * 0.3);      // the two fades of one pass must never meet
    const n = 64, up = new Float32Array(n), down = new Float32Array(n);
    for (let i = 0; i < n; i++) { up[i] = Math.sin((i / (n - 1)) * Math.PI / 2); down[i] = Math.cos((i / (n - 1)) * Math.PI / 2); }
    let next = ctx.currentTime + 0.1;
    const schedule = () => {
      while (next < ctx.currentTime + 3) {
        const src = ctx.createBufferSource(), env = ctx.createGain();
        src.buffer = buffer; src.connect(env); env.connect(out);
        env.gain.setValueAtTime(0, next); env.gain.setValueCurveAtTime(up, next, overlap);
        env.gain.setValueCurveAtTime(down, next + dur - overlap, overlap * 0.98);
        src.start(next); src.stop(next + dur + 0.05);
        next += dur - overlap;
      }
      setTimeout(schedule, 1000);
    };
    if (dur > 1) schedule();
    return out;
  }
  // a single play with a soft start and a fade at the end, so a recording that stops dead is not heard as a cut
  function shot(buffer, gain, { pan = 0, delay = 0, tail = null, lowpass = 0 } = {}) {
    if (!buffer) return;
    const src = ctx.createBufferSource(), g = ctx.createGain(), t = ctx.currentTime + 0.05 + delay, d = buffer.duration;
    const fade = tail === null ? Math.min(1.8, d * 0.4) : tail;
    src.buffer = buffer;
    let node = src;
    if (lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.4; node.connect(f); node = f; }
    node.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.08);
    g.gain.setValueAtTime(gain, t + d - fade - 0.03); g.gain.linearRampToValueAtTime(0, t + d - 0.02);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(master); } else g.connect(master);
    src.start(t);
  }

  // Crickets. The recording is chirps with silence between them, so a cricket can start and stop in a silence and
  // sing any run of chirps. Each cricket sings a few, rests, and waits its turn while enough of the others are singing.
  function crickets(buffer) {
    const out = ctx.createGain(); out.gain.value = 0; out.connect(master);
    // the silences: middle of every stretch of 50 ms or more that stays under 4% of the loudest chirp
    const data = buffer.getChannelData(0), hop = Math.round(buffer.sampleRate / 100), cuts = [];
    let peak = 0, quietFrom = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    for (let i = 0; i <= data.length; i += hop) {
      let loud = false;
      for (let k = i; k < Math.min(i + hop, data.length) && !loud; k++) loud = Math.abs(data[k]) > peak * 0.04;
      if (!loud && i + hop <= data.length) { if (quietFrom < 0) quietFrom = i; continue; }
      if (quietFrom >= 0 && i - quietFrom >= 5 * hop) cuts.push((quietFrom + Math.min(i, data.length)) / 2 / buffer.sampleRate);
      quietFrom = -1;
    }
    if (cuts.length < 2) { cuts.length = 0; cuts.push(0, buffer.duration); }      // no silences found: sing the whole recording
    const voices = CRICKETS.map((c) => {
      const input = ctx.createGain(); input.gain.value = c.gain;
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = c.pan; input.connect(p); p.connect(out); } else input.connect(out);
      return { input, rate: c.rate, until: 0, ready: 0 };
    });
    let crowd = 1, crowdUntil = 0, nextEntry = 0;
    const tick = () => {
      const t = ctx.currentTime;
      if (night > 0.02 && enabled && ctx.state === 'running') {
        if (t >= crowdUntil) { crowd = CROWDS[Math.floor(Math.random() * CROWDS.length)]; crowdUntil = t + between(7, 15); }
        const singing = voices.filter((v) => v.until > t).length;
        const rested = voices.filter((v) => v.ready <= t);
        if (singing < crowd && rested.length && t >= nextEntry) {
          const v = rested[Math.floor(Math.random() * rested.length)];
          const chirps = Math.min(cuts.length - 1, Math.round(between(3, 11)));
          const first = Math.floor(Math.random() * (cuts.length - chirps));
          const rate = v.rate * between(0.985, 1.015), from = cuts[first], length = cuts[first + chirps] - from, dur = length / rate;
          const src = ctx.createBufferSource(), env = ctx.createGain(), at = t + 0.05, loud = between(0.75, 1);
          src.buffer = buffer; src.playbackRate.value = rate; src.connect(env); env.connect(v.input);
          env.gain.setValueAtTime(0, at); env.gain.linearRampToValueAtTime(loud, at + 0.03);
          env.gain.setValueAtTime(loud, at + dur - 0.04); env.gain.linearRampToValueAtTime(0, at + dur);
          src.start(at, from, length);
          v.until = at + dur; v.ready = v.until + between(1.5, 6);
          // alone, the next cricket waits for this one to finish and for a moment of quiet; in a chorus they come in one by one
          nextEntry = crowd === 1 ? v.until + between(0.4, 3) : t + between(0.4, 1.6);
        }
      }
      setTimeout(tick, 300);
    };
    tick();
    return out;
  }

  async function start() {
    if (started || loading) return;
    loading = true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      await Promise.all(Object.entries(FILES).map(async ([key, file]) => {
        try {
          const data = await (await fetch('assets/audio/' + file)).arrayBuffer();
          buf[key] = await ctx.decodeAudioData(data);
        } catch (e) { console.warn('som em falta:', file); }
      }));
      if (buf.rain) layer.rain = loop(buf.rain);
      if (buf.birds) layer.birds = loop(buf.birds, 2.2);
      if (buf.hens) layer.hens = loop(buf.hens, Math.min(2.2, buf.hens.duration * 0.25));
      if (buf.crickets) layer.crickets = crickets(buf.crickets);
      started = true;
      master.gain.setTargetAtTime(enabled ? LEVEL.master : 0, ctx.currentTime, 0.6);
    } catch (e) { console.warn('sem som', e); }
    loading = false; paint();
  }

  // first click or key anywhere wakes the sound, unless it was switched off before
  const wake = (e) => {
    if (button.contains(e.target)) return;
    if (enabled) start();
    removeEventListener('pointerdown', wake, true); removeEventListener('keydown', wake, true);
  };
  addEventListener('pointerdown', wake, true); addEventListener('keydown', wake, true);
  button.addEventListener('click', () => {
    if (!started) { enabled = true; start(); }
    else {
      enabled = !enabled;
      if (ctx.state === 'suspended') ctx.resume();
      master.gain.setTargetAtTime(enabled ? LEVEL.master : 0, ctx.currentTime, 0.25);
    }
    try { localStorage.setItem('jisso-som', enabled ? 'on' : 'off'); } catch { /* ignore */ }
    paint();
  });
  paint();

  return {
    get started() { return started; },
    /** names of the recordings that were found and decoded */
    get loaded() { return Object.keys(buf); },
    /** thunder for a lightning strike: far strikes arrive later, quieter and muffled (only the low rumble carries) */
    strike({ near, clip, delay }) {
      if (!started) return;
      const b = buf['thunder' + (clip + 1)] || buf.thunder1;
      shot(b, LEVEL.thunder * (0.3 + 0.7 * near), { delay, tail: 0.05, pan: Math.random() * 0.8 - 0.4, lowpass: near > 0.9 ? 0 : 350 + 5200 * near * near });
    },
    /** follow the weather: p is the place in the day loop, rain and day run 0..1 */
    update({ p, rain, day }) {
      if (!started) return;
      const t = ctx.currentTime;
      // dawn chorus: starts in the dark before sunrise, fades through the morning; a quieter return after the rain
      const dawn = Math.min(ramp(0.05, 0.105, p), 1 - ramp(0.30, 0.42, p));
      const evening = Math.min(ramp(0.655, 0.72, p), 1 - ramp(0.80, 0.89, p)) * 0.55;
      const birds = Math.max(dawn, evening, 0) * (1 - rain);
      if (layer.rain) layer.rain.gain.setTargetAtTime(LEVEL.rain * rain, t, 0.8);
      if (layer.birds) layer.birds.gain.setTargetAtTime(LEVEL.birds * birds, t, 0.8);
      // hens: quiet clucking once the sun is up, gone by dusk, and under cover while it rains
      const hens = Math.min(ramp(0.13, 0.19, p), 1 - ramp(0.79, 0.855, p)) * (1 - rain);
      if (layer.hens) layer.hens.gain.setTargetAtTime(LEVEL.hens * Math.max(hens, 0), t, 1.5);
      // crickets: they start up as the light goes after sunset and hand over to the birds before sunrise
      night = (p > 0.5 ? ramp(0.845, 0.9, p) : 1 - ramp(0.05, 0.1, p)) * (1 - rain);
      if (layer.crickets) layer.crickets.gain.setTargetAtTime(LEVEL.crickets * night, t, 0.8);
      // the rooster greets the sun, once
      if (prevP !== null && prevP < 0.118 && p >= 0.118 && p - prevP < 0.05) shot(buf.rooster, LEVEL.rooster, { pan: -0.3 });
      prevP = p;
    },
  };
}
