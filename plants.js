import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* The forest and the grass. Models come from assets/plants.glb (built by tools/build_plants.py from
   CC BY 4.0 packs — see assets/CREDITS-3D.txt); positions come from assets/trees.json, laid out in
   Blender together with the house. Everything is drawn as instances: one draw call per model part.

   Leaves are most of what the graphics card has to do here, so three things keep them cheap:
     - a matte material (leaves are not shiny), lit by the sky the same way the house is;
     - what stands nearest the camera is drawn first, so that whatever it hides is skipped;
     - trees and grass outside the picture are not drawn at all (only their shadows, where they cast any). */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// heights (m) the tree positions were originally laid out for, by kind: five broadleaves, a tall one, undergrowth,
// and the wall of trees at the gate
const LAYOUT_H = [9, 7, 11.5, 6, 8, 14, 2, 6];
const HEDGE = 7;
const NEAR = 55, THIN_FROM = 90;                         // metres from the house
// The camera stays on the garden side of the house (see LIMIT in main.js). Measured along this line, a bigger number is nearer to it.
const HOUSE = { x: 2.5, z: -2 }, VIEW = { x: -0.30, z: 0.955 };
const toCamera = (x, z) => (x - HOUSE.x) * VIEW.x + (z - HOUSE.z) * VIEW.z;
const ROOM = 3;                                          // metres of margin around a tree when deciding whether it is in the picture
// Even a matte leaf sends back a little of the light whatever its colour (a faint sheen), and on something as dark as a leaf that shows.
// (Set by measuring: with this much, the picture matches the full "standard" material to within a percent at any hour.)
const GLOSS = { value: 0.018 };

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** which model stands at a given spot, and how tall it should be relative to the layout height */
function pick(kind, r, far) {
  switch (kind) {
    case 0: return [far ? (r < 0.5 ? 'oakMA' : 'oakMB') : (r < 0.5 ? 'oakLA' : 'oakLB'), 1.25];
    case 1: return [far ? 'oakMA' : (r < 0.5 ? 'oakBA' : 'oakBB'), 1.3];
    case 2: return [far ? 'oakMB' : (r < 0.5 ? 'oakLB' : 'oakLA'), 1.15];
    case 3: return [r < 0.5 ? 'oakMA' : 'oakMB', 1.35];
    case 4: return [far ? 'oakMB' : 'oakBB', 1.25];
    case 5: return [r < 0.5 ? 'slimA' : 'slimB', 1.0];
    default: return [r < 0.55 ? 'oakS' : r < 0.8 ? 'slimB' : 'oakMA', 1.7];
  }
}

/** The sky as the house's materials see it (their ambient light): the plants read the same picture, so both stay lit alike. */
function skyLight(scene) {
  const env = scene.environment;
  if (!env) return { uniforms: null, defines: {} };
  const h = env.image.height, maxMip = Math.log2(h) - 2;                  // the layout three.js gives its blurred sky textures
  return {
    uniforms: { uSkyEnv: { value: env }, uSkyAmount: { value: scene.environmentIntensity } },
    defines: { ENVMAP_TYPE_CUBE_UV: '', CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(2 ** maxMip, 112)), CUBEUV_TEXEL_HEIGHT: 1 / h, CUBEUV_MAX_MIP: maxMip.toFixed(1) },
  };
}

/** Bark, leaves and grass: matte, swaying in the wind (stronger the higher up; leaves also flutter), with the sky as ambient light.
    The full "standard" material gives the same picture for a leaf, at about twice the cost. */
function plantMaterial(src, { wind, sky, leaf, coverage }) {
  const m = new THREE.MeshLambertMaterial({ map: src.map, side: THREE.DoubleSide, name: src.name });
  if (m.map) m.map.anisotropy = 4;
  // cut-out foliage instead of blended: no sorting problems, and it can write depth and cast shadows
  if (leaf) { m.alphaTest = 0.38; m.alphaToCoverage = coverage; }
  m.defines = { ...sky.defines, ...(leaf ? { LEAF_FLUTTER: 1 } : {}) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = wind.uTime; shader.uniforms.uWind = wind.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime, uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wRoot = instanceMatrix[3].xyz;
        #else
          vec3 wRoot = vec3(0.0);
        #endif
        float wPhase = wRoot.x * 0.35 + wRoot.z * 0.27;
        float wLift = max(position.y, 0.0);
        float wSway = (sin(uWindTime * 1.1 + wPhase) + 0.5 * sin(uWindTime * 2.3 + wPhase * 1.7)) * uWind * 0.010 * wLift;
        transformed.x += wSway; transformed.z += wSway * 0.6;
        #ifdef LEAF_FLUTTER
          float wFl = sin(uWindTime * 4.6 + position.x * 2.1 + position.z * 1.7 + position.y * 3.1 + wPhase) * uWind * 0.012 * min(wLift, 3.0);
          transformed.x += wFl; transformed.y += wFl * 0.5;
        #endif`);
    shader.uniforms.uGloss = GLOSS;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGloss;')
      .replace('#include <lights_lambert_fragment>', 'diffuseColor.rgb += uGloss;\n#include <lights_lambert_fragment>');
    if (!sky.uniforms) return;
    Object.assign(shader.uniforms, sky.uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uSkyEnv; uniform float uSkyAmount;\n#include <cube_uv_reflection_fragment>')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        irradiance += PI * textureCubeUV(uSkyEnv, inverseTransformDirection(normal, viewMatrix), 1.0).rgb * uSkyAmount;`);
  };
  return m;
}

function groundTexture(renderer) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), rnd = rng(11);
  g.fillStyle = '#34521f'; g.fillRect(0, 0, S, S);
  const wrap = (draw) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) draw(ox, oy); };
  for (let i = 0; i < 140; i++) {                      // soft patches: lusher, drier, bare
    const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 60, col = ['#3f6424', '#2c4619', '#4a6a2a', '#3a4a22', '#2a3f18'][Math.floor(rnd() * 5)];
    wrap((ox, oy) => { const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.globalAlpha = 0.55; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2); });
  }
  g.globalAlpha = 1; g.lineCap = 'round';
  for (let i = 0; i < 9000; i++) {                     // blades
    const x = rnd() * S, y = rnd() * S, a = rnd() * 6.283, l = 2 + rnd() * 5;
    g.strokeStyle = ['#507a2c', '#3b5d22', '#628a35', '#2b4418', '#6f8f3c', '#44682a'][Math.floor(rnd() * 6)]; g.globalAlpha = 0.5 + rnd() * 0.4; g.lineWidth = 0.8 + rnd();
    wrap((ox, oy) => { g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l); g.stroke(); });
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

/** height of the terrain at (x, z), read back from the regular grid of the ground mesh */
function heightField(ground) {
  const pos = ground.geometry.attributes.position, n = Math.round(Math.sqrt(pos.count));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const dx = (x1 - x0) / (n - 1), dz = (z1 - z0) / (n - 1), H = new Float32Array(n * n);
  for (let i = 0; i < pos.count; i++) H[Math.round((pos.getZ(i) - z0) / dz) * n + Math.round((pos.getX(i) - x0) / dx)] = pos.getY(i);
  return (x, z) => {
    const fx = clamp((x - x0) / dx, 0, n - 1.001), fz = clamp((z - z0) / dz, 0, n - 1.001), ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = H[iz * n + ix], b = H[iz * n + ix + 1], c = H[(iz + 1) * n + ix], d = H[(iz + 1) * n + ix + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

/** quality: what this computer can take (see quality.js) — how much forest and grass, which trees, who casts and takes shadows */
export async function createPlants({ scene, renderer, trees, ground, version = '', quality }) {
  const wind = { uTime: { value: 0 }, uWind: { value: 1 } }, sky = skyLight(scene);
  const gltf = await new GLTFLoader().loadAsync('assets/plants.glb' + version);
  const model = {};
  gltf.scene.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); model[o.name] = o; } });

  // one material per texture, and per "takes shadows or not" (two different programs on the graphics card)
  const mats = new Map();
  const prepared = (mesh, receive) => {
    const src = mesh.material, key = src.uuid + receive;
    if (!mats.has(key)) mats.set(key, plantMaterial(src, { wind, sky, leaf: src.name !== 'Bark_Mat', coverage: quality.antialias }));
    return mats.get(key);
  };

  /** list: [{ m: matrix, c: colour, s: scale, d: how near the camera's side }] — drawn nearest first.
      order: when the whole lot is drawn (lower = earlier) */
  const lots = [], centre = new THREE.Vector3();
  const add = (name, list, { tint = false, shadow = false, receive = true, order = 0 } = {}) => {
    const src = model[name]; if (!src || !list.length) return 0;
    list.sort((a, b) => b.d - a.d);
    const im = new THREE.InstancedMesh(src.geometry, prepared(src, receive), list.length);
    list.forEach((it, i) => { im.setMatrixAt(i, it.m); if (tint) im.setColorAt(i, it.c); });
    im.castShadow = shadow; im.receiveShadow = receive; im.frustumCulled = false; im.renderOrder = order;
    scene.add(im);
    // the ball each one fits in, and a copy of the full list: on every look, the ones in the picture are put first (see inPicture)
    const ball = src.geometry.boundingBox.getBoundingSphere(new THREE.Sphere()), balls = new Float32Array(list.length * 4);
    list.forEach((it, i) => { centre.copy(ball.center).applyMatrix4(it.m); balls.set([centre.x, centre.y, centre.z, ball.radius * it.s * 1.3 + ROOM], i * 4); });
    const lot = { im, balls, all: im.instanceMatrix.array.slice(), tints: tint ? im.instanceColor.array.slice() : null, seen: new Uint8Array(list.length), shown: list.length, casts: shadow };
    // a tree outside the picture can still throw its shadow into it: the shadow pass draws them all
    if (shadow) { im.onBeforeShadow = () => { im.count = list.length; }; im.onAfterShadow = () => { im.count = lot.shown; }; }
    lots.push(lot);
    return (src.geometry.index ? src.geometry.index.count : src.geometry.attributes.position.count) / 3 * list.length;
  };
  const partsOf = (name) => (model[name] ? [name] : [name + '_bark', name + '_leaf']);
  const heightOf = (name) => Math.max(...partsOf(name).map((p) => model[p].geometry.boundingBox.max.y));
  const bareTrunk = (name) => (model[name + '_leaf'] ? model[name + '_leaf'].geometry.boundingBox.min.y : 0);   // how high up the leaves start

  // ---- trees
  const rnd = rng(5), dummy = new THREE.Object3D(), groups = {};
  let count = 0, tris = 0;
  trees.forEach((t, i) => {
    const [kind, x, yb, z, rot, s] = t, dist = Math.hypot(x - 2, yb - 3), r = rnd(), r2 = rnd(), r3 = rnd();
    if (quality.forest === 'short' && dist > 62) return;              // phones: the forest stops sooner
    if (quality.forest === 'thin' && kind === 6 && dist > 62) return; // modest computers: no undergrowth out where the big trees hide it
    const sparse = dist > (quality.forest === 'thin' ? 62 : THIN_FROM);
    if (sparse && i % 2) return;                                      // far away, half as many, each a little bigger
    // The wall of trees at the gate: small and medium oaks standing close together, planted deep enough for the
    // leaves to start at the ground (their height is then counted from the lowest leaves, not from the foot).
    const hedge = kind === HEDGE;
    const [name, k] = hedge ? [s < 0.7 ? 'oakS' : r < 0.6 ? 'oakMB' : 'oakMA', 1] : pick(kind, r, dist > NEAR || !quality.bigTrees);
    const trunk = hedge ? bareTrunk(name) : 0;
    const target = LAYOUT_H[kind] * s * k * (sparse ? 1.25 : 1), scale = target / (heightOf(name) - trunk);
    dummy.position.set(x, z - 0.15 - trunk * scale, -yb); dummy.rotation.set(0, rot, 0); dummy.scale.setScalar(scale); dummy.updateMatrix();
    const v = 0.82 + r2 * 0.36;
    const c = kind === 4 ? new THREE.Color(1.5 * v, 1.25 * v, 0.5 * v) : new THREE.Color(v * (0.94 + r3 * 0.14), v, v * (0.86 + r3 * 0.2));
    // round the house: these cast shadows. Further out: on the camera's side of the house, or beyond it
    const d = toCamera(x, -yb), zone = dist < quality.shadowReach ? 'near' : d > 0 ? 'front' : 'back';
    (groups[name + '|' + zone] ||= []).push({ m: dummy.matrix.clone(), c, s: scale, d }); count++;
  });
  // Drawing order, nearest first: far trees on the camera's side (-2), trees round the house (-1), the house (0),
  // grass (1), the forest behind (2), fields and sea (3), sky (4).
  const ZONE = {
    near: { shadow: true, order: -1 },
    front: { receive: quality.farShadows, order: -2 },
    back: { receive: quality.farShadows, order: 2 },
  };
  for (const [key, list] of Object.entries(groups)) {
    const [name, zone] = key.split('|');
    for (const part of partsOf(name)) tris += add(part, list, { ...ZONE[zone], tint: !part.endsWith('_bark') });
  }

  // ---- ground: a grass texture, and tufts of grass standing on it
  const h = heightField(ground);
  const gp = ground.geometry.attributes.position, uv = new Float32Array(gp.count * 2);
  for (let i = 0; i < gp.count; i++) { uv[i * 2] = gp.getX(i) / 4; uv[i * 2 + 1] = gp.getZ(i) / 4; }
  ground.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  ground.material.map = groundTexture(renderer); ground.material.color.set('#b9c9a8'); ground.material.roughness = 1; ground.material.needsUpdate = true;

  // where grass must not grow (x, depth behind the front edge): the house, the stone walls, the drive (with the walls of its
  // cut and the road outside the gate), the asphalt on the terrace
  const blocked = (x, yb) => (x > -7.6 && x < 12.8 && yb > -2.5 && yb < 13.6) || (x > 1.7 && x < 10.3 && yb >= 13.2 && yb < 34) || (x > 9.7 && x < 13.8 && yb > 14.6 && yb < 18.1)
    || (x > -12.8 && x < 14.8 && yb > 12.9 && yb < 15.2);        // (the last: the terrace wall behind the house, as long as the model makes it)
  const lawn = (x, yb) => x > -11.5 && x < 15.5 && yb > -6.5 && yb < 17.5;
  const tufts = { grassA: [], grassB: [], grassC: [], grassD: [], grassE: [], tallA: [], tallB: [], tallC: [] };
  const short = ['grassA', 'grassB', 'grassC', 'grassD', 'grassE'], tall = ['tallA', 'tallB', 'tallC'];
  const put = (name, x, yb, scale) => {
    dummy.position.set(x, h(x, -yb) - 0.02, -yb); dummy.rotation.set(0, rnd() * 6.283, 0); dummy.scale.set(scale, scale * (0.8 + rnd() * 0.5), scale); dummy.updateMatrix();
    const v = 0.42 + rnd() * 0.22;
    tufts[name].push({ m: dummy.matrix.clone(), c: new THREE.Color(v * 0.8, v * (1.0 + rnd() * 0.12), v * 0.62), s: scale, d: toCamera(x, -yb) });
  };
  const want = quality.grass;
  for (let i = 0, tries = 0; i < want && tries < want * 6; tries++) {
    const onLawn = rnd() < 0.62;
    const x = onLawn ? -11.5 + rnd() * 27 : -46 + rnd() * 96, yb = onLawn ? -6.5 + rnd() * 24 : -42 + rnd() * 84;
    if (blocked(x, yb) || (!onLawn && lawn(x, yb))) continue;
    const isTall = rnd() < (onLawn ? 0.04 : 0.16);
    put(isTall ? tall[Math.floor(rnd() * 3)] : short[Math.floor(rnd() * 5)], x, yb, isTall ? 0.7 + rnd() * 0.5 : (onLawn ? 1.0 : 1.9) + rnd() * 1.0);
    i++;
  }
  for (const [name, list] of Object.entries(tufts)) tris += add(name, list, { tint: true, order: 1 });

  // ---- only what is in the picture
  const frustum = new THREE.Frustum(), wide = new THREE.PerspectiveCamera(), matrix = new THREE.Matrix4(), ball = new THREE.Sphere();
  const seen = { from: new THREE.Vector3(Infinity, 0, 0), turn: new THREE.Quaternion(), aspect: 0 };
  const place = (lot, i, n) => {             // instance i of the full list goes to slot n of what is drawn
    const to = lot.im.instanceMatrix.array;
    for (let k = 0; k < 16; k++) to[n * 16 + k] = lot.all[i * 16 + k];
    if (lot.tints) { const tint = lot.im.instanceColor.array; for (let k = 0; k < 3; k++) tint[n * 3 + k] = lot.tints[i * 3 + k]; }
  };
  function inPicture(camera) {
    // looked at again only once the camera has moved or turned a little; until then the margins below cover it
    if (camera.position.distanceTo(seen.from) < 1.5 && camera.quaternion.angleTo(seen.turn) < 0.06 && camera.aspect === seen.aspect) return;
    seen.from.copy(camera.position); seen.turn.copy(camera.quaternion); seen.aspect = camera.aspect;
    wide.fov = camera.fov + 16; wide.aspect = camera.aspect; wide.near = 0.1; wide.far = 5000; wide.updateProjectionMatrix();
    wide.position.copy(camera.position); wide.quaternion.copy(camera.quaternion); wide.updateMatrixWorld();
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(wide.projectionMatrix, wide.matrixWorldInverse));
    for (const lot of lots) {
      const { im, balls, seen: here } = lot, total = here.length;
      let n = 0;
      for (let i = 0; i < total; i++) {
        ball.center.set(balls[i * 4], balls[i * 4 + 1], balls[i * 4 + 2]); ball.radius = balls[i * 4 + 3];
        here[i] = frustum.intersectsSphere(ball) ? 1 : 0;
        if (here[i]) place(lot, i, n++);
      }
      lot.shown = im.count = n;
      if (lot.casts) for (let i = 0; i < total; i++) if (!here[i]) place(lot, i, n++);     // the rest, at the end: for the shadow pass only
      im.instanceMatrix.needsUpdate = true; if (lot.tints) im.instanceColor.needsUpdate = true;
    }
  }

  return {
    wind, count, triangles: Math.round(tris), gloss: GLOSS,
    /** breeze: 1 on a calm day, more in the storm; camera: where the picture is taken from */
    update(time, strength, camera) {
      wind.uTime.value = time; wind.uWind.value = strength;
      if (sky.uniforms) { sky.uniforms.uSkyEnv.value = scene.environment; sky.uniforms.uSkyAmount.value = scene.environmentIntensity; }
      if (camera) inPicture(camera);
    },
  };
}
