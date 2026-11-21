/* How much this computer is asked to draw.

   Two levels, chosen before anything is drawn:
     high — a dedicated graphics card: the whole forest, the big trees, smoothed edges
     low  — the graphics built into an ordinary office PC, or a phone: a lighter forest, no edge smoothing
   Then, while the site runs, the governor below watches the real frame rate and draws the picture with
   fewer pixels whenever the computer cannot keep up (and with more again once it can).

   Add ?q=low or ?q=high to the address to force a level. */

const KEY = 'quinta-quality';

const LEVELS = {
  high: {
    antialias: true,
    pixelRatio: [0.6, 1.5, 2],      // lowest allowed, where to start, highest allowed (never above the screen's own)
    shadowSize: 2048,               // the sun's shadow map, in pixels
    shadowReach: 42,                // trees this close to the house (m) cast shadows
    forest: 'full', bigTrees: true, grass: 12000,
    farShadows: true,               // the far forest is shaded by the near one
    envSize: 256,                   // the sky, as seen by reflections and ambient light
  },
  low: {
    antialias: false,
    pixelRatio: [0.5, 1, 1.25],
    shadowSize: 1024,
    shadowReach: 32,
    forest: 'thin', bigTrees: false, grass: 3500,
    farShadows: false,
    envSize: 64,
  },
};

// names of graphics cards that can take the high level; anything else (Intel UHD/Iris, the Radeon inside a Ryzen, unknown) starts low
const STRONG = /nvidia|geforce|quadro|radeon(\(tm\))?\s*(rx|pro|r9)|arc\(tm\)\s*[ab]\d|apple\s*m\d/i;

function graphicsCard() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    return name;
  } catch (e) { return ''; }
}
// What is remembered between visits: nothing; 'low' (it struggled once); 'healed' (and then ran with room to spare);
// 'low!' (it struggled again after that: settled).
const remembered = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const remember = (note) => { try { if (note) localStorage.setItem(KEY, note); else localStorage.removeItem(KEY); } catch (e) { /* private window: nothing to remember */ } };

export function pickQuality() {
  const phone = matchMedia('(pointer: coarse)').matches;
  const asked = new URLSearchParams(location.search).get('q');
  if (asked === 'auto') remember(null);                  // ?q=auto: forget what earlier visits concluded
  const card = graphicsCard(), note = remembered();
  const forced = asked === 'high' || asked === 'low';
  const level = forced ? asked
    : note === 'low' || note === 'low!' ? 'low'           // this computer struggled before (see rememberLow)
    : !phone && STRONG.test(card) ? 'high' : 'low';
  const quality = { level, forced, phone, card, ...LEVELS[level] };
  // phones: small sharp screens, so more pixels per point than an office monitor, and the forest stops sooner
  if (phone) Object.assign(quality, { forest: 'short', pixelRatio: [0.75, 1.5, 2] });
  return quality;
}

/** This computer could not keep up even at the lowest resolution: start low on the next visit.
    Once may be bad luck (something else was keeping the machine busy), so a later visit that runs with room to spare
    drops the note (forgetLow) and the level is chosen afresh. If it then struggles again, the note stays for good. */
let noted = false;
export function rememberLow() {
  if (noted) return; noted = true;
  remember(remembered() === null ? 'low' : remembered() === 'low' ? 'low' : 'low!');
}
export function forgetLow() { if (remembered() === 'low') remember('healed'); }

// average time per frame (ms), judged one second at a time
const SLOW = 23, CRAWL = 45, FAST = 18;

/** Keeps the frame rate up by changing how many pixels are drawn. Call frame(seconds since the last frame) on every frame. */
export function createGovernor(renderer, quality) {
  const screen = window.devicePixelRatio || 1;
  const [floor, start, ceiling] = quality.pixelRatio.map((v) => Math.min(v, screen));
  const steps = [];
  for (let s = ceiling; s > floor * 1.08; s *= 0.85) steps.push(s);
  steps.push(floor);
  let at = Math.max(0, steps.findIndex((s) => s <= start * 1.001));
  let time = 0, frames = 0, worst = 0, warm = 3, calm = 0, patience = 8, trying = 0, stuck = 0;
  let before = 0, from = at, held = false;     // the slowest it got on the way down, and the step it started from; held: fewer pixels do not help
  let ease = 0;                                // seconds in a row at the sharpest picture with time to spare
  const set = (i) => { at = Math.min(steps.length - 1, Math.max(0, i)); renderer.setPixelRatio(steps[at]); };
  set(at);

  const api = {
    steps,
    get pixelRatio() { return steps[at]; },
    /** called when the lowest resolution is still too slow, so that something else can give (again every few seconds while it lasts) */
    onStruggle: null,
    /** called once, after twenty seconds in a row at the sharpest picture with time to spare */
    onComfortable: null,
    frame(dt) {
      if (dt > 0.5 || document.hidden) { time = frames = worst = 0; return; }   // the tab was away or held back: says nothing about this computer
      if (warm > 0) { warm -= dt; return; }                                // the first seconds go to compiling and uploading
      time += dt; frames++; worst = Math.max(worst, dt);
      if (time < 1 || frames < 3) return;
      const ms = 1000 * (time - worst) / (frames - 1);                     // the average, leaving out the one longest frame (a hiccup is not slowness)
      time = frames = worst = 0;
      if (ms > SLOW) {
        calm = ease = 0;
        if (held) { if (ms > CRAWL && ++stuck >= 3) { stuck = 0; if (api.onStruggle) api.onStruggle(); } return; }
        if (trying > 0) { trying = 0; patience = Math.min(patience * 2, 120); }   // the step up was too much: wait longer before trying again
        if (at < steps.length - 1) { if (!before) from = at; before = Math.max(before, ms); stuck = 0; set(at + (ms > CRAWL ? 2 : 1)); }
        else if (before && ms > before * 0.85) {
          // A fraction of the pixels and no faster: the pace is set by something else (a 30 Hz screen, a power-saving mode,
          // or the forest itself on a very slow computer). Give the pixels back and leave the resolution alone.
          held = true; set(from);
          if (ms > CRAWL && api.onStruggle) api.onStruggle();
        } else if (++stuck >= 3) { stuck = 0; if (api.onStruggle) api.onStruggle(); }
      } else {
        stuck = 0; before = 0;
        if (ms < FAST) held = false;
        if (ms < FAST && at === 0) { if (++ease === 20 && api.onComfortable) api.onComfortable(); } else ease = 0;
        if (trying > 0) trying--;
        if (ms > FAST) calm = 0;
        else if (at > 0 && ++calm >= patience) { calm = 0; trying = 3; set(at - 1); }   // smooth for a while: try a sharper picture
      }
    },
  };
  return api;
}
