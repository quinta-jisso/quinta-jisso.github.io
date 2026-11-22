import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createWeather } from './weather.js';
import { createSound } from './audio.js';
import { createPlants } from './plants.js';
import { pickQuality, createGovernor, rememberLow, forgetLow } from './quality.js';

/* Quinta Jissô: exterior scene + guest book.
   Model coordinates come from Blender (Z up); glTF/three is Y up: (x, y, z) -> (x, z, -y).
   The view side of the house (fields, sea) is +Z here. */

let PAGES = 0;                 // how many pages the book has: from assets/book/book.json (written by tools/prepare_book.py)
const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ renderer
// (No logarithmic depth buffer: it writes the depth of every pixel by hand, so the graphics card can no longer skip
//  the leaves and walls hidden behind others, and in a forest that is most of the work. The near plane moves instead: see update.)
const quality = pickQuality();                // what this computer can take: see quality.js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance' });
const governor = createGovernor(renderer, quality);      // sets the resolution, and lowers it when frames come too slowly
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;        // redrawn from update(): on every frame, because the sun never stops and shadows that lag behind it jump
let shadowEvery = 1, frameNo = 0, struggles = 0;
governor.onStruggle = () => {                 // the lowest resolution is still too slow: redraw the shadows less often…
  shadowEvery = Math.min(shadowEvery + 1, 3);
  // …and if it goes on, with the page in front and in use (not a tab the browser is holding back), start low next time
  if (++struggles >= 2 && !quality.forced && document.hasFocus()) rememberLow();
};
governor.onComfortable = () => { if (!quality.forced) forgetLow(); };

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 30000);
scene.fog = new THREE.FogExp2('#0a1020', 0.00042);

// ------------------------------------------------------------------ sky, light and weather (see weather.js)
const weather = createWeather({ scene, renderer, reduceMotion, quality });
weather.buildEnvironment();
const sound = createSound($('sound'));
weather.onStrike = (s) => sound.strike(s);

// ------------------------------------------------------------------ far landscape
function fieldsTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#4c7a2c'; g.fillRect(0, 0, S, S);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const greens = ['#5f8f33', '#4f8030', '#6f9c3a', '#41702b', '#7da444', '#587f2e', '#8aa64a', '#3d6b2c'];
  const n = 9, cell = S / n, pts = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const edge = i === 0 || j === 0 || i === n || j === n;   // keep the tile seamless
    pts.push([i * cell + (edge ? 0 : (rnd() - .5) * cell * .55), j * cell + (edge ? 0 : (rnd() - .5) * cell * .55)]);
  }
  g.lineJoin = 'round';
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = [pts[j * (n + 1) + i], pts[j * (n + 1) + i + 1], pts[(j + 1) * (n + 1) + i + 1], pts[(j + 1) * (n + 1) + i]];
    g.beginPath(); q.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    g.fillStyle = greens[Math.floor(rnd() * greens.length)]; g.fill();
    g.strokeStyle = '#24401f'; g.lineWidth = 5; g.stroke();          // hedgerows / stone walls
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(24, 24); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
{
  // the fields stop at the shore (z = 2900): two planes 40 cm apart, kilometres away, would flicker through each other
  const texture = fieldsTexture(); texture.repeat.set(24, 24 * 5900 / 9000);
  const fields = new THREE.Mesh(new THREE.PlaneGeometry(9000, 5900), new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
  fields.rotation.x = -Math.PI / 2; fields.position.set(0, -10.9, -50);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(60000, 30000), new THREE.MeshStandardMaterial({ color: '#2f6f96', roughness: 0.35, metalness: 0.2 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(0, -10.5, 2900 + 15000);
  fields.renderOrder = sea.renderOrder = 3;      // drawn after everything that stands in front of them (the order is in plants.js)
  scene.add(fields, sea);
}

// ------------------------------------------------------------------ load the quinta
let DECK = 4.6, TABLE = new THREE.Vector3(7.9, 5.34, 1.2);
const dummy = new THREE.Object3D();

/** The land is rippled all over (bumps a few metres across, up to half a metre high) so that it does not look laid with a ruler.
    Lit as it stands, a sun low on the horizon picks out every ripple: bright and dark bands across the hillside. So away from
    the house the light is given the broad lie of the land instead: its heights averaged over some fifteen metres. */
function calmNormals(geometry) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, n = Math.round(Math.sqrt(pos.count));
  if (n * n !== pos.count) return;                             // not the square grid this expects: leave it as it came
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const dx = (x1 - x0) / (n - 1), dz = (z1 - z0) / (n - 1);
  const cell = (i) => Math.round((pos.getZ(i) - z0) / dz) * n + Math.round((pos.getX(i) - x0) / dx);
  let H = new Float32Array(n * n);
  for (let i = 0; i < pos.count; i++) H[cell(i)] = pos.getY(i);
  const R = 5, at = (A, i, j) => A[clamp(j, 0, n - 1) * n + clamp(i, 0, n - 1)];
  const blur = (A, sx, sz) => {
    const B = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0; for (let k = -R; k <= R; k++) s += at(A, i + k * sx, j + k * sz); B[j * n + i] = s / (2 * R + 1); }
    return B;
  };
  for (let pass = 0; pass < 2; pass++) H = blur(blur(H, 1, 0), 0, 1);
  const v = new THREE.Vector3(), broad = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const c = cell(i), ci = c % n, cj = (c - ci) / n, x = pos.getX(i), z = pos.getZ(i);
    broad.set(-(at(H, ci + 1, cj) - at(H, ci - 1, cj)) / (2 * dx), 1, -(at(H, ci, cj + 1) - at(H, ci, cj - 1)) / (2 * dz)).normalize();
    // round the house (the terrace, the lawn) the ground keeps its true shape
    const away = Math.hypot(Math.max(-10 - x, 0, x - 14), Math.max(-19 - z, 0, z - 5));
    v.fromBufferAttribute(nor, i).lerp(broad, smooth(clamp((away - 4) / 12, 0, 1))).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  nor.needsUpdate = true;
}

async function loadQuinta(onProgress) {
  // trees.json is small and always re-checked; its build number goes on the big files' addresses,
  // so the browser can keep them for as long as it likes and still never show an out-of-date house
  const info = await fetch('assets/trees.json', { cache: 'no-cache' }).then((r) => r.json());
  const version = '?v=' + (info.build || 0);
  const gltf = await new GLTFLoader().loadAsync('assets/quinta.glb' + version, (e) => e.total && onProgress(e.loaded / e.total));
  DECK = info.deck; TABLE.set(info.table[0], info.table[2], -info.table[1]);
  const root = gltf.scene;
  let ground = null;
  const banks = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const m = o.material;
    if (m.name.startsWith('ground')) { o.castShadow = false; ground = o; }
    if (m.name === 'bank') { o.castShadow = false; banks.push(o); }
    if (m.name === 'glass') { m.envMapIntensity = 1.6; }
    if (['glow', 'glass', 'roof', 'deck'].includes(m.name)) weather.materials[m.name] = m;
    if (m.map) m.map.anisotropy = 8;
    if (m.name === 'roof' || m.name === 'wall' || m.name === 'stone') { m.bumpMap = m.map; m.bumpScale = 1.5; }
  });
  // The terrain is meant to arrive as one smooth sheet, one point per crossing of its grid: plants.js reads the heights back
  // from it that way. Should a build ever export it with flat faces again (each with its own copies of its corner points,
  // which left the grass metres above or below the ground), this welds it back; on a smooth sheet it changes nothing.
  if (ground) {
    const flat = ground.geometry;
    flat.deleteAttribute('normal'); flat.deleteAttribute('uv');
    ground.geometry = mergeVertices(flat); ground.geometry.computeVertexNormals(); flat.dispose();
    calmNormals(ground.geometry);
  }
  // the stand-in trees that came with the house model give way to the real ones
  root.children.slice().forEach((node) => { if (/^tree\d/.test(node.name)) root.remove(node); });
  scene.add(root);
  plants = await createPlants({ scene, renderer, trees: info.trees, ground, version, quality });
  // The strips of earth behind the walls of the drive are land too: they take the grass that createPlants has just given the ground.
  for (const o of banks) {
    const p = o.geometry.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 4; uv[i * 2 + 1] = p.getZ(i) / 4; }
    o.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (ground) o.material = ground.material;
  }
}
let plants = null;

// ------------------------------------------------------------------ the guest book
const book = new THREE.Group();
const PW = 0.27, PH = PW * 1570 / 1500, SEG = 26;
let TH = 0.0011;               // from one sheet to the next (less when the book has many: see buildBook)
const sheets = [], cards = [];
const texLoader = new THREE.TextureLoader();
let turned = 0, pendingTurn = null;
let bookInfo = { build: 0, pages: 0, cards: [] };
const bookFile = (name) => `assets/book/${name}?v=${bookInfo.build}`;
const pageFile = (p) => bookFile(`p${String(p).padStart(2, '0')}.jpg`);
const cardOn = (p) => bookInfo.cards.find((c) => c.page === p);

function paperTexture(draw) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 * PH / PW);
  const g = c.getContext('2d'); draw(g, c.width, c.height);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const blankPage = (spiralLeft) => paperTexture((g, w, h) => {
  g.fillStyle = '#f3efe6'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(120,130,170,.35)'; g.lineWidth = 1.5;
  for (let y = h * 0.07; y < h * 0.97; y += h / 31) { g.beginPath(); g.moveTo(w * 0.04, y); g.lineTo(w * 0.96, y); g.stroke(); }
  g.fillStyle = '#d8d2c4';
  for (let i = 0; i < 26; i++) g.fillRect(spiralLeft ? w * 0.012 : w * 0.968, h * (0.03 + i * 0.0365), w * 0.02, h * 0.012);
});
const coverTexture = (title) => paperTexture((g, w, h) => {
  const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, '#5b1f3a'); grd.addColorStop(1, '#3d1226');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 5000; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  if (!title) return;
  g.strokeStyle = '#e7c98b'; g.lineWidth = 3; g.strokeRect(w * 0.09, h * 0.08, w * 0.82, h * 0.84);
  g.lineWidth = 1; g.strokeRect(w * 0.105, h * 0.093, w * 0.79, h * 0.814);
  g.fillStyle = '#efd9a6'; g.textAlign = 'center';
  g.font = `italic 500 ${w * 0.15}px "Cormorant Garamond", Georgia, serif`; g.fillText('Quinta Jissô', w / 2, h * 0.44);
  g.font = `${w * 0.045}px "Cormorant Garamond", Georgia, serif`;
  g.fillText('L I V R O   D E   V I S I T A S', w / 2, h * 0.54);
  g.beginPath(); g.moveTo(w * 0.38, h * 0.59); g.lineTo(w * 0.62, h * 0.59); g.lineWidth = 2; g.stroke();
});

function makeSheet(index, frontMap, backMap, isCover) {
  const n = (SEG + 1) * 2;
  const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const uvF = new Float32Array(n * 2), uvB = new Float32Array(n * 2), idx = [];
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    uvF.set([u, 1, u, 0], i * 4); uvB.set([1 - u, 1, 1 - u, 0], i * 4);
    if (i < SEG) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  }
  const gF = new THREE.BufferGeometry(), gB = new THREE.BufferGeometry();
  gF.setAttribute('position', pos); gB.setAttribute('position', pos);
  gF.setAttribute('uv', new THREE.BufferAttribute(uvF, 2)); gB.setAttribute('uv', new THREE.BufferAttribute(uvB, 2));
  gF.setIndex(idx); gB.setIndex(idx);
  const mk = (map, side) => isCover ? new THREE.MeshStandardMaterial({ map, side, roughness: 0.6, metalness: 0, envMapIntensity: 0.3 }) : paperMaterial(map, side);
  const front = new THREE.Mesh(gF, mk(frontMap, THREE.FrontSide)), back = new THREE.Mesh(gB, mk(backMap, THREE.BackSide));
  front.receiveShadow = back.receiveShadow = true; front.frustumCulled = back.frustumCulled = false;
  book.add(front, back);
  const s = { index, pos, gF, gB, front, back, t: 0, target: 0, w: isCover ? PW * 1.02 : PW, h: isCover ? PH * 1.02 : PH, aS: 0, aE: 0, laid: 0 };
  sheets.push(s); return s;
}
// Pages (and the cards taped to them) are half self-lit: whatever the sky and the lamps are doing (blue noon, orange lamplight), the writing stays readable.
function paperMaterial(map, side) {
  const m = new THREE.MeshStandardMaterial({ map, side, roughness: 0.92, metalness: 0, color: '#8d8880', emissive: '#ffffff', emissiveMap: map, emissiveIntensity: 0.5, envMapIntensity: 0.1 });
  m.onBeforeCompile = finerPaper; return m;
}
// A page on screen is two to three times smaller than its scan, and the size of scan the graphics card would pick for it is
// too blurred for pen strokes: it is told to read half a step finer (the edge smoothing and the slanted-view filter keep it calm).
function finerPaper(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, -0.5 )'))
    .replace('#include <emissivemap_fragment>', THREE.ShaderChunk.emissivemap_fragment.replace('texture2D( emissiveMap, vEmissiveMapUv )', 'texture2D( emissiveMap, vEmissiveMapUv, -0.5 )'));
}
/* The smaller copies of a scan, which is what the page is drawn from when it is smaller on screen than the scan. Left to
   the graphics card they are averaged as light, and a dark pen stroke one pixel wide comes out of two halvings as a pale
   grey thread: the writing looks rubbed out. Made here instead: each copy half the one before, averaged the way a browser
   shrinks a picture (which keeps thin dark lines darker), and what did turn grey deepened a little more with every step
   (the copy multiplied by itself: paper, nearly white, hardly moves). The scan itself, the first level, is untouched. */
function inkMips(t) {
  const levels = [t.image];
  for (let w = t.image.width, h = t.image.height; w > 1 || h > 1;) {
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(levels[levels.length - 1], 0, 0, w, h);
    levels.push(c);
  }
  levels.forEach((c, i) => {
    if (!i) return;
    const g = c.getContext('2d'); g.globalCompositeOperation = 'multiply'; g.globalAlpha = Math.min(1, 0.35 * i); g.drawImage(c, 0, 0);
  });
  t.mipmaps = levels;
  // once they are on the graphics card the canvases are let go (should the card ever need the texture again, it makes its own copies as before)
  t.onUpdate = () => { levels.forEach((c, i) => { if (i) c.width = c.height = 0; }); t.mipmaps = []; t.generateMipmaps = true; t.onUpdate = null; };
  return t;
}

function layoutSheet(s) {
  const N = sheets.length, t = s.t, a = s.pos.array;
  // the outer edge leads, the spine follows: the sheet curls as it turns
  const aE = Math.PI * smooth(clamp(t * 1.3, 0, 1)), aS = Math.PI * smooth(clamp((t - 0.23) / 0.77, 0, 1));
  const yR = (N - 1 - s.index) * TH, yL = s.index * TH;
  let x = 0.004 * Math.cos(aS), y = yR + (yL - yR) * smooth(t) + 0.004 * Math.sin(aS);
  const ds = s.w / SEG;
  for (let i = 0; i <= SEG; i++) {
    if (i > 0) { const ang = aS + (aE - aS) * ((i - 0.5) / SEG); x += Math.cos(ang) * ds; y += Math.sin(ang) * ds; }
    a.set([x, y, -s.h / 2, x, y, s.h / 2], i * 6);
  }
  s.pos.needsUpdate = true;
  s.gF.computeVertexNormals(); s.gB.setAttribute('normal', s.gF.getAttribute('normal'));
  s.aS = aS; s.aE = aE; s.laid++;             // (the cards on this sheet go by these: see layoutCard)
}
/** Where a sheet is at distance d from the spine, and which way it runs there. Before the spine and past the
    outer edge the sheet is carried on straight: a card turned over across the spiral lies on that. */
function sheetPoint(s, d, out) {
  const i = clamp(Math.floor(d / s.w * SEG), 0, SEG - 1), a = s.pos.array;
  const ang = s.aS + (s.aE - s.aS) * ((i + 0.5) / SEG), rest = d - i * s.w / SEG;
  out.tx = Math.cos(ang); out.ty = Math.sin(ang);
  out.x = a[i * 6] + out.tx * rest; out.y = a[i * 6 + 1] + out.ty * rest;
  return out;
}

// ------------------------------------------------------------------ cards taped into the book
/* A few visitors left a card, taped to the page by one edge. It can be turned over on its tape to read what was
   written under it (and to see its back). book.json says where each one is: the page, the four corners of the
   card on it (in page widths, from the top left of the page) and which edge is taped.
   A card is a small sheet of its own: it lies on its page, follows it when the page turns, and swings round its
   taped edge by 'angle'. */
const CARD = { across: 8, along: 10, lift: 0.00028, halo: 0.012, peek: 0.2 };
const cardRay = new THREE.Raycaster(), cardSpot = { x: 0, y: 0, tx: 1, ty: 0 };

function haloTexture(w, h, m) {
  // black, clear at the rim and darkest where the card's edge is: the soft shadow a card has on the paper
  const W = 96, H = Math.max(8, Math.round(96 * (h + 2 * m) / (w + 2 * m))), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), rim = m / (w + 2 * m) * W;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.min(x + 0.5, W - x - 0.5, y + 0.5, H - y - 0.5) / rim;
    img.data[(y * W + x) * 4 + 3] = 255 * smooth(clamp(d, 0, 1));
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function makeCard(def) {
  const sheet = sheets[Math.ceil(def.page / 2)], odd = def.page % 2 === 1;
  const [TL, TR, , BL] = def.corners.map(([x, y]) => new THREE.Vector2(x, y));
  // the taped edge runs from 'from' along 'axis'; 'out' goes across the card, away from the tape
  const left = def.hinge === 'left';
  const axis = (left ? BL : TR).clone().sub(TL), out = (left ? TR : BL).clone().sub(TL);
  const la = axis.length(), lo = out.length(); axis.normalize(); out.normalize();
  const nA = CARD.along, nO = CARD.across, n = (nA + 1) * (nO + 1);
  const grid = (a0, a1, o0, o1) => {            // the same net of points for the card and, a little larger, for its shadow
    const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3), uvF = new Float32Array(n * 2), uvB = new Float32Array(n * 2), idx = [];
    for (let i = 0; i <= nA; i++) for (let j = 0; j <= nO; j++) {
      const k = i * (nO + 1) + j, a = i / nA, o = j / nO;
      // front: as the card lies on the page. back: as it shows once turned over on its tape.
      uvF.set(left ? [o, 1 - a] : [a, 1 - o], k * 2); uvB.set(left ? [1 - o, 1 - a] : [a, o], k * 2);
      if (i < nA && j < nO) idx.push(k, k + nO + 1, k + 1, k + 1, k + nO + 1, k + nO + 2);
    }
    const gF = new THREE.BufferGeometry(), gB = new THREE.BufferGeometry();
    gF.setAttribute('position', pos); gB.setAttribute('position', pos);
    gF.setAttribute('uv', new THREE.BufferAttribute(uvF, 2)); gB.setAttribute('uv', new THREE.BufferAttribute(uvB, 2));
    gF.setIndex(idx); gB.setIndex(idx);
    return { pos, gF, gB, a0, a1, o0, o1 };
  };
  const tex = (name) => { const t = texLoader.load(bookFile(name), inkMips); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
  const body = grid(0, la, 0, lo), halo = grid(-CARD.halo, la + CARD.halo, -CARD.halo, lo + CARD.halo);
  // Which way the net faces follows from the taped edge (tape-edge direction x across-the-card direction): with the
  // tape on the left it faces away from the paper, with the tape on top towards it. The printed side goes on the side
  // that looks away from the paper.
  const faceUp = left;
  const front = new THREE.Mesh(body.gF, paperMaterial(tex(def.front), faceUp ? THREE.FrontSide : THREE.BackSide));
  const back = new THREE.Mesh(body.gB, paperMaterial(tex(def.back), faceUp ? THREE.BackSide : THREE.FrontSide));
  const shade = new THREE.Mesh(halo.gF, new THREE.MeshBasicMaterial({ color: '#000000', map: haloTexture(left ? lo : la, left ? la : lo, CARD.halo), transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
  front.receiveShadow = back.receiveShadow = true;
  [front, back, shade].forEach((m) => { m.frustumCulled = false; book.add(m); });
  shade.renderOrder = 1;
  const c = { def, page: def.page, sheet, odd, from: TL, axis, out, la, lo, body, halo, front, back, shade,
    opens: Math.PI, over: 0, open: false, t: 0, hover: false, peek: 0, wink: -1, pace: 1, angle: 0, bend: 0, shown: null, laid: -1 };
  // A card taped next to the spiral turns over across it. It does not go through the rings: it comes to rest propped
  // on them, its far edge down on the facing page. So it turns a little further than half a turn, lifted off its tape.
  const along = (odd ? 1 : -1) * out.x, tapeAt = 0.004 + (odd ? TL.x : 1 - TL.x) * PW;      // metres from the spiral's axis
  if (along > 0.7 && lo * PW > tapeAt + 0.02) {
    const N = sheets.length, j = sheet.index, own = (odd ? N - 1 - j : j) * TH, facing = (odd ? j - 1 : N - 2 - j) * TH;
    const ringTop = 0.008 + 0.0105 + 0.0011 + 0.0006, slope = (ringTop - facing - CARD.lift) / (lo * PW - tapeAt);
    c.opens = Math.PI + Math.atan(slope); c.over = Math.max(0, ringTop + tapeAt * slope - own);
  }
  cards.push(c); layoutCard(c);
  return c;
}

/** Puts every point of a card (and of its shadow) where it belongs: on its page, swung round the tape by c.angle. */
function layoutCard(c) {
  const s = c.sheet, side = c.odd ? 1 : -1, phi = c.angle;
  // across the card the swing grows a little towards the free edge (c.bend): card bends when it is turned, it is not sheet metal
  const bend = c.bend, nO = CARD.across, nA = CARD.along;
  const raised = c.over * smooth(clamp(phi - 1.5, 0, 1));      // on its way down over the spiral (see makeCard)
  for (const g of [c.body, c.halo]) {
    const a = g.pos.array;
    let on = Math.min(0, g.o0), off = 0, o = g.o0;   // how far this row has got along the page, and off it
    for (let j = 0; j <= nO; j++) {
      const o1 = g.o0 + (g.o1 - g.o0) * j / nO;
      if (j > 0) {
        // (the strip of shadow before the tape stays flat on the paper)
        const flat = Math.max(0, Math.min(0, o1) - Math.min(0, o)), turn = (o1 - o) - flat;
        const ang = phi + bend * clamp(((o + o1) / 2) / c.lo, 0, 1);
        on += flat + Math.cos(ang) * turn; off += Math.sin(ang) * turn;
      }
      o = o1;
      for (let i = 0; i <= nA; i++) {
        const al = g.a0 + (g.a1 - g.a0) * i / nA;
        const X = c.from.x + c.axis.x * al + c.out.x * on, Y = c.from.y + c.axis.y * al + c.out.y * on;
        const p = sheetPoint(s, (c.odd ? X : 1 - X) * PW, cardSpot);
        const up = (g === c.body ? CARD.lift : CARD.lift * 0.5) + off * PW + raised;
        a.set([p.x - p.ty * side * up, p.y + p.tx * side * up, Y * PW - PH / 2], (i * (nO + 1) + j) * 3);
      }
    }
    g.pos.needsUpdate = true;
    g.gF.computeVertexNormals(); g.gB.setAttribute('normal', g.gF.getAttribute('normal'));
    g.gF.computeBoundingSphere(); g.gB.boundingSphere = g.gF.boundingSphere;
  }
  // the shadow belongs to a card lying flat (on its page, or turned right over): it goes while the card is in the air
  c.shade.material.opacity = 0.3 * Math.cos(phi) ** 2;
  c.laid = s.laid; c.shown = phi;
}

function updateCards(dt) {
  const shown = pagesShown();
  for (const c of cards) {
    const live = mode === 'book' && shown.includes(c.page);
    if (!live && c.open && c.sheet.t === c.sheet.target) c.open = false;       // (left open on a page no longer in view)
    const goal = c.open ? 1 : 0;
    if (c.t !== goal) {
      const step = dt / (reduceMotion ? 0.05 : 0.85 / c.pace);
      c.t = c.t < goal ? Math.min(1, c.t + step) : Math.max(0, c.t - step);
      if (c.t === goal) c.pace = 1;
    }
    // under the pointer a closed card lifts its free edge a little; so it does once, by itself, when its page is opened
    const want = live && !c.open && c.hover ? 1 : 0;
    c.peek += clamp(want - c.peek, -dt / 0.2, dt / 0.2);
    let lift = c.peek;
    if (c.wink >= 0) { c.wink += dt; lift = Math.max(lift, Math.sin(Math.PI * clamp((c.wink - 1.3) / 1.1, 0, 1)) ** 2); if (c.wink > 2.4 || c.open || !live) c.wink = -1; }
    const k = smooth(c.t);
    c.angle = c.opens * k + CARD.peek * lift * (1 - k);
    c.bend = 0.34 * Math.sin(Math.PI * k) + 0.9 * CARD.peek * lift * (1 - k);
    if (c.angle !== c.shown || c.laid !== c.sheet.laid) layoutCard(c);
  }
  if (pendingTurn !== null && cards.every((c) => c.t === 0)) { const k = pendingTurn; pendingTurn = null; setTurned(k, pendingSide); }
}
/** Lays every card back on its page, briskly: a page is about to turn. True if there was one to lay back. */
function closeCards() {
  let any = false;
  for (const c of cards) if (c.open || c.t > 0) { c.open = false; c.pace = 2.6; any = true; }
  return any;
}
function cardAt(e) {
  if (mode !== 'book' || fly.t < 1) return null;
  const shown = pagesShown(), live = cards.filter((c) => shown.includes(c.page) && c.sheet.t === c.sheet.target);
  if (!live.length) return null;
  cardRay.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  return live.find((c) => cardRay.intersectObject(c.front).length || cardRay.intersectObject(c.back).length) || null;
}
function flipCard(c) { c.open = !c.open; c.pace = 1; c.wink = -1; }

// ------------------------------------------------------------------ the pages
// The scans are loaded for the sheets round the open pages only: all fifty at once is more graphics memory than an
// office PC should be asked for. The other sheets wear a blank ruled page meanwhile.
const KEEP = { near: [3, 2], far: [6, 5] };   // sheets before / after the open one that are loaded, and beyond which they are let go
const arriving = [];                          // loaded scans waiting to go on their page: one per frame, so that no frame carries them all
function wantPages() {
  for (const s of sheets) for (const pg of s.pages || []) {
    if (!pg.url) continue;
    const before = turned - s.index, after = s.index - turned;
    if (before <= KEEP.near[0] && after <= KEEP.near[1] && !pg.asked) {
      pg.asked = true;
      texLoader.load(pg.url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); arriving.push([pg, t]); });
    } else if ((before > KEEP.far[0] || after > KEEP.far[1]) && pg.asked) {
      pg.asked = false;
      if (pg.tex) { pg.material.map = pg.material.emissiveMap = pg.blank; pg.tex.dispose(); pg.tex = null; }
    }
  }
}
function putPage() {
  if (!arriving.length) return;
  const [pg, t] = arriving.shift();
  if (!pg.asked) { t.dispose(); return; }      // (turned far away again before it arrived)
  if (pg.tex) pg.tex.dispose();
  pg.tex = inkMips(t); pg.material.map = pg.material.emissiveMap = t;
}

function buildBook() {
  PAGES = bookInfo.pages;
  const inner = Math.ceil(PAGES / 2);
  TH = Math.min(0.0011, 0.0187 / (inner + 1));     // however many sheets, the stack stays as tall as the spiral that holds it
  const cream = paperTexture((g, w, h) => { g.fillStyle = '#efe7d6'; g.fillRect(0, 0, w, h); });
  makeSheet(0, coverTexture(true), cream, true);
  const blankR = blankPage(true), blankL = blankPage(false);
  for (let j = 1; j <= inner; j++) {
    const s = makeSheet(j, blankR, blankL, false);
    // a page with a card is shown as it is under the card: the card itself is laid on it (makeCard)
    s.pages = [2 * j - 1, 2 * j].map((p, k) => ({
      url: p <= PAGES ? (cardOn(p) ? bookFile(cardOn(p).base) : pageFile(p)) : null,
      material: (k ? s.back : s.front).material, blank: k ? blankL : blankR, asked: false, tex: null,
    }));
  }
  makeSheet(sheets.length, cream, coverTexture(false), true);
  // spiral binding
  const ring = new THREE.TorusGeometry(0.0105, 0.0011, 6, 20);
  const metal = new THREE.MeshStandardMaterial({ color: '#c9c9c9', metalness: 0.9, roughness: 0.3 });
  const rings = new THREE.InstancedMesh(ring, metal, 24);
  for (let i = 0; i < 24; i++) { dummy.position.set(0, 0.008, -PH * 0.47 + i * PH * 0.94 / 23); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); rings.setMatrixAt(i, dummy.matrix); }
  book.add(rings);
  sheets.forEach(layoutSheet);
  bookInfo.cards.forEach(makeCard);
  book.position.copy(TABLE).add(new THREE.Vector3(0, 0.004, 0));
  // the book reads the same way you arrive: flying in from the garden, the house stays ahead (top of the screen)
  scene.add(book);
  // a worn wooden top under the book
  const wood = texLoader.load('assets/tex/ceiling.jpg'); wood.colorSpace = THREE.SRGBColorSpace; wood.wrapS = wood.wrapT = THREE.RepeatWrapping; wood.repeat.set(1, 0.7); wood.anisotropy = 8;
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.012, 0.76), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.7, color: '#c9a27c' }));
  top.position.copy(TABLE).add(new THREE.Vector3(0, -0.003, 0)); top.receiveShadow = true; top.castShadow = true; scene.add(top);
  const lamp = new THREE.PointLight('#fff1dc', 0.5, 5, 1.2); lamp.position.copy(TABLE).add(new THREE.Vector3(0, 1.6, 0)); scene.add(lamp); weather.bookLamp = lamp;
}

function pagesShown(t = turned) {
  // sheet k: front = page 2k-1, back = page 2k; sheet 0 and the last one are the covers
  const left = t >= 2 ? 2 * (t - 1) : null, right = t >= 1 && t <= sheets.length - 2 ? 2 * t - 1 : null;
  return [left && left <= PAGES ? left : null, right && right <= PAGES ? right : null];
}
/* On an upright phone two pages side by side are too small to read, so the book is shown one page at a time (oneUp, set in
   fitBook): `side` says which half of the open book is in view, 0 the left page and 1 the right one. */
let oneUp = false, side = 1, pendingSide = 1;
function inView() { const [l, r] = pagesShown(); return oneUp ? (side ? [null, r] : [l, null]) : [l, r]; }
// is there something to see on that half of the book, with t sheets turned? (the closed covers, or a written page)
const stop = (t, s) => (t === 0 ? s === 1 : t === sheets.length ? s === 0 : !!pagesShown(t)[s]);
/** One step on in the book (dir 1) or back (-1): a whole spread, or a single page when one page is shown at a time. */
function step(dir) {
  if (!oneUp) { setTurned(turned + dir); return; }
  let t = turned, s = side;
  do {
    if (dir > 0) { if (s) { t++; s = 0; } else s = 1; } else if (s) s = 0; else { t--; s = 1; }
  } while (t >= 0 && t <= sheets.length && !stop(t, s));
  if (t >= 0 && t <= sheets.length) setTurned(t, s);
}
function setTurned(k, s = side) {
  k = clamp(k, 0, sheets.length);
  // a card that is turned over is laid back on its page first; the page turns once it is down (updateCards)
  if (k !== turned && closeCards()) { pendingTurn = k; pendingSide = s; return; }
  const was = inView();
  turned = k; side = s;
  if (oneUp && !stop(turned, side)) side = 1 - side;
  sheets.forEach((sh) => { sh.target = sh.index < turned ? 1 : 0; });
  const [l, r] = inView();
  $('label').textContent = turned === 0 ? 'Livro de visitas' : turned >= sheets.length - 1 && !l && !r ? 'Fim' :
    (l && r ? `páginas ${l}–${r} de ${PAGES}` : `página ${l || r} de ${PAGES}`);
  $('prev').disabled = turned === 0; $('next').disabled = turned === sheets.length;
  $('read').style.visibility = l || r ? 'visible' : 'hidden';
  // a page with a card on it: say so, and let the card lift its edge once
  const withCard = cards.filter((c) => c.page === l || c.page === r);
  if ($('cardhint')) $('cardhint').classList.toggle('hidden', !withCard.length);   // (guarded: a stale cached page without the hint must still work)
  withCard.forEach((c) => { if (!was.includes(c.page)) c.wink = 0; });
  wantPages();
}

// ------------------------------------------------------------------ camera
let mode = 'exterior';
const orbit = { az: -0.46, el: 0.25, r: 46, target: new THREE.Vector3(2.5, DECK + 1.0, -2.0) };
// Only the front is known from photos, so the view stays on the garden side and never climbs high enough to look over the ridges.
const LIMIT = { azMin: -1.0, azMax: 0.55, elMin: 0.07, elMax: 0.46, rMin: 18, rMax: 80, lookUp: 2.6 };
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const fly = { t: 1, from: new THREE.Vector3(), fromQ: new THREE.Quaternion(), dur: 3.6 };
const aim = new THREE.PerspectiveCamera();      // carries the orientation we are heading for
const pointer = { x: 0, y: 0 };
let lastInput = -10, clock = 0;

// An upright screen shows a narrow slice of the garden: the camera stands further back there, so the whole house still fits.
let stepBack = 1;
function exteriorPose(out, look) {
  const sway = reduceMotion ? 0 : Math.sin(clock * 0.06) * 0.22 * clamp((clock - lastInput - 4) / 6, 0, 1);
  const az = clamp(orbit.az + sway, LIMIT.azMin, LIMIT.azMax);
  const el = clamp(orbit.el, LIMIT.elMin, LIMIT.elMax);
  out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(orbit.r * stepBack).add(orbit.target);
  look.copy(orbit.target); look.y += LIMIT.lookUp;          // aim a little high: the sky is half the weather
}
// Frame the open spread so that all of it sits inside the area the buttons leave free.
let bookFit = { lz: 0, d: 1.2, half: 0.34 };
// Over the book two fingers bring the page closer (zoom, 1 = the whole page or spread) and one finger then moves it about (x, z: metres).
const view = { zoom: 1, x: 0, z: 0 }, ZOOM_MAX = 4;
const metresPerPixel = (zoom = view.zoom) => (2 * bookFit.d * bookFit.half) / (zoom * innerHeight);
function clampView() {
  view.zoom = clamp(view.zoom, 1, ZOOM_MAX);
  const reach = bookFit.d * bookFit.half * (1 - 1 / view.zoom);          // never further than what is in the picture when not zoomed
  view.x = clamp(view.x, -reach * camera.aspect, reach * camera.aspect); view.z = clamp(view.z, -reach, reach);
}
const UP_Y = new THREE.Vector3(0, 1, 0), UP_BOOK = new THREE.Vector3(0, 0, -1);   // over the book, 'up' on screen is the house side
function fitBook() {
  if (!innerWidth || !innerHeight) return;     // (no window size yet: see resize)
  // Straight down, so the spread is an undistorted rectangle: size it to the free area and centre it there.
  const low = innerHeight < 520;                                                // a phone on its side: every pixel of height counts
  const top = ((low ? 60 : 78) / innerHeight) * 2, bottom = ((low ? 78 : 104) / innerHeight) * 2;   // NDC kept clear for the buttons
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), aspect = innerWidth / innerHeight;
  const was = oneUp; oneUp = aspect < 0.8;
  const dW = (PW * (oneUp ? 0.55 : 1.07)) / (0.95 * half * aspect);
  const dH = (PH * 0.54) / (half * (1 - (top + bottom) / 2));
  const d = Math.max(dW, dH, 0.3);
  bookFit = { d, half, lz: ((bottom - top) / 2) * d * half };
  clampView();
  if (was !== oneUp && sheets.length) setTurned(turned);       // the label and the hints follow what is in view
}
function bookPose(out, look) {
  const { lz, d } = bookFit;
  look.set(TABLE.x + (oneUp ? (side ? 0.51 : -0.51) * PW : 0) + view.x, TABLE.y, TABLE.z + lz + view.z);
  out.set(look.x, look.y + d / view.zoom, look.z);
}
function goto(next) {
  if (mode === next) return;
  fly.from.copy(camPos); fly.fromQ.copy(camera.quaternion); fly.t = 0; mode = next;
  canvas.classList.toggle('book', next === 'book');
  $('intro').classList.toggle('hidden', next === 'book');
  $('bookui').classList.toggle('hidden', next !== 'book');
  if (next !== 'book') closeCards();
  view.zoom = 1; view.x = view.z = 0;
  if (next === 'book') setTimeout(() => { if (mode === 'book' && turned === 0) setTurned(1); }, reduceMotion ? 300 : 3300);
}

// ------------------------------------------------------------------ input
let drag = null, pinch = null, lastTap = -1;
const fingers = new Map();     // every finger (or the mouse button) that is down on the picture
const zoomed = () => view.zoom > 1.02;
function startDrag(e, afterPinch) {
  // (afterPinch: the finger left on the glass when a pinch ends may move the page about, but it is not a tap and turns no page)
  drag = { x: e.clientX, y: e.clientY, az: orbit.az, el: orbit.el, vx: view.x, vz: view.z, moved: afterPinch ? 99 : 0, afterPinch };
}
function pinchNow() {
  const [a, b] = [...fingers.values()];
  return { d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2 - innerWidth / 2, y: (a.y + b.y) / 2 - innerHeight / 2 };
}
canvas.addEventListener('pointerdown', (e) => {
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* (a pointer that is already gone) */ }
  if (fingers.size === 1) startDrag(e, false);
  else if (fingers.size === 2) {
    if (drag && drag.sheet) setTurned(turned);      // a page that was being dragged across goes back where it was
    drag = null; pinch = pinchNow();
  }
});
canvas.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1; pointer.y = (e.clientY / innerHeight) * 2 - 1;
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && fingers.size >= 2) {
    // two fingers: apart to come closer, together to step back
    const now = pinchNow();
    if (mode === 'exterior') { orbit.r = clamp(orbit.r * pinch.d / now.d, LIMIT.rMin, LIMIT.rMax); lastInput = clock; }
    else if (fly.t >= 1) {
      const before = metresPerPixel();
      view.zoom = clamp(view.zoom * now.d / pinch.d, 1, ZOOM_MAX);
      const after = metresPerPixel();
      // the spot of the page under the fingers stays under them
      view.x += pinch.x * before - now.x * after; view.z += pinch.y * before - now.y * after;
      clampView();
    }
    pinch = now;
    return;
  }
  if (cards.length && e.pointerType === 'mouse' && (!drag || drag.moved <= 8)) {
    // a card under the pointer lifts its edge: it can be turned over
    const over = cardAt(e); cards.forEach((c) => { c.hover = c === over; });
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
  if (mode === 'exterior') {
    orbit.az = clamp(drag.az - dx * 0.005, LIMIT.azMin, LIMIT.azMax); orbit.el = clamp(drag.el + dy * 0.004, LIMIT.elMin, LIMIT.elMax); lastInput = clock;
  } else if (zoomed()) {
    // close to the page: the finger moves the page about
    view.x = drag.vx - dx * metresPerPixel(); view.z = drag.vz - dy * metresPerPixel(); clampView();
  } else if (drag.moved > 8 && !oneUp && !drag.afterPinch) {
    cards.forEach((c) => { c.hover = false; });
    // drag a page across: the sheet follows the finger (once a card that was turned over is back on its page)
    if (!drag.sheet && (closeCards() || pendingTurn !== null)) return;
    if (!drag.sheet) {
      const forward = dx < 0; const i = forward ? turned : turned - 1;
      if (i >= 0 && i < sheets.length) drag.sheet = { s: sheets[i], forward };
    }
    if (drag.sheet) {
      const p = clamp(Math.abs(dx) / (innerWidth * 0.38), 0, 1), ok = (dx < 0) === drag.sheet.forward;
      drag.sheet.s.target = drag.sheet.s.t = drag.sheet.forward ? (ok ? p : 0) : (ok ? 1 - p : 1);
      drag.sheet.p = ok ? p : 0;
    }
  }
});
function release(e, cancelled) {
  const was = fingers.delete(e.pointerId);
  if (pinch) {
    pinch = null;
    if (view.zoom < 1.08) { view.zoom = 1; view.x = view.z = 0; }      // nearly all the way back: settle on the whole page
    if (fingers.size === 1) { const [f] = fingers.values(); startDrag({ clientX: f.x, clientY: f.y }, true); }
    return;
  }
  if (!drag || !was) return;
  if (mode === 'book' && cancelled) { if (drag.sheet) setTurned(turned); }
  else if (mode === 'book') {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    const tap = drag.moved < 8, card = !drag.sheet && tap ? cardAt(e) : null;
    if (card) flipCard(card);                    // a click on a card turns the card, not the page
    else if (drag.sheet) setTurned(turned + (drag.sheet.p > 0.28 ? (drag.sheet.forward ? 1 : -1) : 0));
    else if (zoomed()) {
      // close to the page a tap turns nothing; two quick taps go back to the whole page
      if (tap && clock - lastTap < 0.4) { view.zoom = 1; view.x = view.z = 0; lastTap = -1; } else if (tap) lastTap = clock;
    }
    else if (tap) step(e.clientX > innerWidth / 2 ? 1 : -1);
    else if (oneUp && !drag.afterPinch && Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);   // one page at a time: a swipe turns it
  }
  drag = null;
}
canvas.addEventListener('pointerup', (e) => release(e, false));
canvas.addEventListener('pointercancel', (e) => release(e, true));
canvas.addEventListener('pointerleave', () => { cards.forEach((c) => { c.hover = false; }); });
canvas.addEventListener('wheel', (e) => { if (mode === 'exterior') { orbit.r = clamp(orbit.r * (1 + e.deltaY * 0.001), LIMIT.rMin, LIMIT.rMax); lastInput = clock; } e.preventDefault(); }, { passive: false });
addEventListener('keydown', (e) => {
  if (!$('lightbox').classList.contains('hidden')) { if (e.key === 'Escape') $('lightbox').classList.add('hidden'); return; }
  if (mode !== 'book') return;
  if (e.key === 'ArrowRight' || e.key === ' ') step(1);
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'Escape') goto('exterior');
});
$('open').onclick = () => goto('book');
$('back').onclick = () => goto('exterior');
$('next').onclick = () => step(1);
$('prev').onclick = () => step(-1);
$('read').onclick = () => {
  const box = $('lbpages'); box.replaceChildren(); setBig(false);
  inView().filter(Boolean).forEach((p) => {
    const img = new Image(), card = cards.find((c) => c.page === p);
    img.alt = `Página ${p} do livro de visitas`;
    if (card) {
      // the page was scanned twice, with the card as it is taped and with the card turned over: a click changes between them
      const show = () => { img.src = card.open ? bookFile(card.def.open) : pageFile(p); };
      img.className = 'flips'; img.title = 'Clique para virar o cartão';
      img.onclick = () => { flipCard(card); show(); };
      show(); new Image().src = bookFile(card.def.open);
    } else img.src = pageFile(p);
    box.append(img);
  });
  $('lightbox').classList.remove('hidden');
};
// on a small screen the scan can be shown at more than twice the width of the screen, and moved about with a finger
function setBig(on) { $('lbpages').classList.toggle('big', on); $('zoomlb').textContent = on ? 'Reduzir −' : 'Ampliar +'; $('zoomlb').setAttribute('aria-pressed', on); }
$('zoomlb').onclick = () => setBig(!$('lbpages').classList.contains('big'));
$('closelb').onclick = () => $('lightbox').classList.add('hidden');
$('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lbpages' || e.target.id === 'lightbox') $('lightbox').classList.add('hidden'); });

// ------------------------------------------------------------------ loop
function resize() {
  if (!innerWidth || !innerHeight) return;     // a window with no size yet (a pane still closed): wait for its real one
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  stepBack = clamp(0.87 / camera.aspect, 1, 2.1);
  fitBook();
}
addEventListener('resize', resize); resize();

const tmpP = new THREE.Vector3(), tmpL = new THREE.Vector3();
let last = performance.now();
function update(dt) {
  clock += dt;
  (mode === 'book' ? bookPose : exteriorPose)(tmpP, tmpL);
  aim.position.copy(tmpP); aim.up.copy(mode === 'book' ? UP_BOOK : UP_Y); aim.lookAt(tmpL);
  if (fly.t < 1) {
    // one continuous move: the position glides in an arc while the view tilts over by the shortest rotation
    fly.t = Math.min(1, fly.t + dt / (reduceMotion ? 0.01 : fly.dur));
    const k = smooth(smooth(fly.t));
    camPos.lerpVectors(fly.from, tmpP, k);
    camPos.y += Math.sin(Math.PI * k) * 1.6;
    camera.quaternion.slerpQuaternions(fly.fromQ, aim.quaternion, smooth(fly.t));
  } else {
    const e = 1 - Math.exp(-dt * 6);
    camPos.lerp(tmpP, e); camera.quaternion.slerp(aim.quaternion, e);
  }
  camLook.copy(tmpL);
  camera.position.copy(camPos);
  // depth precision goes where the camera is: fine over the book, coarser out in the garden where nothing is that close
  const near = clamp(camPos.distanceTo(TABLE) * 0.08, 0.05, 1);
  if (Math.abs(near - camera.near) > 1e-4) { camera.near = near; camera.updateProjectionMatrix(); }
  weather.update(dt, { camera, shelter: mode === 'book' ? smooth(fly.t) : 1 - smooth(fly.t) });
  sound.update(weather.state);
  // Which trees are in the picture is looked at again only on the frames that also redraw the shadows (every frame, unless the
  // computer is struggling): three.js sends the new list of the trees that cast shadows while it draws the shadows, and on a
  // frame in between they would be drawn from the old list, a few of them missing. The margins in plants.js cover the wait.
  const shadows = ++frameNo % shadowEvery === 0;
  if (plants) plants.update(clock, reduceMotion ? 0 : 0.8 + 2.6 * weather.state.rain + 0.5 * weather.state.cloud, shadows ? camera : null);
  if (shadows) renderer.shadowMap.needsUpdate = true;
  for (const s of sheets) {
    if (s.t === s.target) continue;
    const step = dt / (reduceMotion ? 0.05 : 0.95);
    s.t = s.t < s.target ? Math.min(s.target, s.t + step) : Math.max(s.target, s.t - step);
    layoutSheet(s);
  }
  updateCards(dt);
  putPage();
}
function frame(now) {
  const elapsed = (now - last) / 1000, dt = Math.min(0.05, elapsed); last = now;
  governor.frame(elapsed);
  update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

(async function start() {
  try {
    await loadQuinta((p) => { $('bar').style.width = `${Math.round(p * 90)}%`; });
    await document.fonts.load('italic 500 40px "Cormorant Garamond"').catch(() => {});
    bookInfo = await fetch('assets/book/book.json', { cache: 'no-cache' }).then((r) => r.json());   // small and always re-checked, like trees.json
    orbit.target.set(2.5, DECK + 1.0, -2.0);
    buildBook(); setTurned(0); fitBook(); weather.addHouseLights(DECK);
    exteriorPose(camPos, camLook); camera.position.copy(camPos); camera.lookAt(camLook);
    $('bar').style.width = '100%';
    requestAnimationFrame(frame);
    setTimeout(() => { $('loader').classList.add('hidden'); $('intro').classList.remove('hidden'); }, 350);
    const advance = (sec) => { for (let t = 0; t < sec; t += 1 / 30) update(1 / 30); renderer.render(scene, camera); };   // for scripted checks
    window.__quinta = { goto, setTurned, step, view, get oneUp() { return oneUp; }, get side() { return side; }, sheets, layoutSheet, advance, cards, flipCard, book, camera, weather, sound, plants, get turned() { return turned; }, orbit, renderer, scene, quality, governor };
  } catch (err) {
    console.error(err);
    $('loadnote').textContent = 'não foi possível carregar a quinta: abra através de um servidor local';
  }
})();
