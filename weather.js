import * as THREE from 'three';

/* Azores weather: one looping "day" driven by a single number p in [0, 1).
     night with the house lit -> first light -> sunrise -> sunny morning with passing clouds ->
     the sky closes -> thunderstorm -> it opens up -> golden evening -> sunset -> dusk -> night
   The sky dome, the sun/moon light, the ambient light (re-captured from the sky itself), fog, rain,
   lightning and the house lamps all follow from p. */

export const CYCLE_SECONDS = 300;      // one full loop: 5 minutes

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const DEG = Math.PI / 180;

/** keys: [[x, v1, v2, ...]] where each v is a number or an [r, g, b]; returns the values at x, linearly interpolated */
function keyed(keys, x) {
  let i = 1;
  while (i < keys.length - 1 && x > keys[i][0]) i++;
  const a = keys[i - 1], b = keys[i], t = clamp((x - a[0]) / (b[0] - a[0]), 0, 1);
  return a.slice(1).map((v, k) => (Array.isArray(v) ? mix3(v, b[k + 1], t) : lerp(v, b[k + 1], t)));
}
const track = (keys) => (p) => keyed(keys, p)[0];

// ------------------------------------------------------------------ the day
// Sun height in degrees through the loop. It lingers near the horizon so sunrise and sunset last.
const sunElAt = track([[0, -20], [0.045, -13], [0.075, -6.5], [0.105, -1.5], [0.125, 2], [0.16, 8], [0.21, 20], [0.30, 44],
  [0.40, 57], [0.55, 60], [0.68, 42], [0.76, 20], [0.80, 9], [0.835, 2], [0.855, -1.5], [0.885, -6.5], [0.92, -13], [0.96, -18], [1, -20]]);
const RISE = 0.105, SET = 0.855;
// Sun bearing: 0 = straight out in front of the house, positive toward the right. It comes up behind the
// house on the right (so dawn glows in the sky behind the roofs) and sets front-left (so the last light hits the facade).
const sunAzAt = (p) => (p < RISE ? 150 + (RISE - p) * 80 : p > SET ? -72 - (p - SET) * 80 : lerp(150, -72, (p - RISE) / (SET - RISE)));
const cloudAt = track([[0, 0.20], [0.10, 0.30], [0.16, 0.34], [0.30, 0.26], [0.36, 0.42], [0.44, 1.0], [0.63, 1.0], [0.70, 0.5], [0.78, 0.36], [0.88, 0.32], [1, 0.20]]);
const rainAt = track([[0, 0], [0.465, 0], [0.505, 1], [0.60, 1], [0.645, 0], [1, 0]]);
const wetAt = track([[0, 0], [0.47, 0], [0.52, 1], [0.65, 1], [0.80, 0], [1, 0]]);
// The storm: where in the loop each lightning strike falls, how near it is (1 = on top of us) and which thunder recording follows.
const STRIKES = [{ p: 0.452, near: 0.25, clip: 2 }, { p: 0.512, near: 0.6, clip: 0 }, { p: 0.546, near: 1.0, clip: 3 },
  { p: 0.582, near: 0.7, clip: 1 }, { p: 0.627, near: 0.3, clip: 2 }];

// Sky colours by sun height: zenith, horizon on the sun's side, horizon on the far side,
// how tightly the horizon colour hugs the horizon, and the strength of the glow around the sun.
const SKY = [
  [-20, [0.008, 0.013, 0.036], [0.030, 0.046, 0.090], [0.030, 0.046, 0.090], 3.0, 0.0],
  [-12, [0.012, 0.020, 0.058], [0.060, 0.072, 0.135], [0.036, 0.052, 0.100], 3.2, 0.0],
  [-7, [0.035, 0.060, 0.150], [0.360, 0.220, 0.250], [0.075, 0.088, 0.175], 4.6, 0.25],
  [-3, [0.090, 0.150, 0.330], [0.940, 0.480, 0.230], [0.270, 0.225, 0.360], 5.6, 0.75],
  [0.5, [0.170, 0.290, 0.540], [1.000, 0.620, 0.270], [0.650, 0.470, 0.550], 5.0, 1.0],
  [5, [0.200, 0.380, 0.680], [1.000, 0.800, 0.500], [0.650, 0.650, 0.780], 4.2, 0.8],
  [12, [0.170, 0.380, 0.720], [0.860, 0.880, 0.900], [0.660, 0.770, 0.900], 3.4, 0.35],
  [30, [0.140, 0.340, 0.700], [0.640, 0.790, 0.930], [0.620, 0.780, 0.920], 3.0, 0.15],
  [90, [0.130, 0.320, 0.690], [0.620, 0.780, 0.920], [0.620, 0.780, 0.920], 3.0, 0.10],
];
// Direct sunlight: colour (reddened through the thick air near the horizon) and strength.
const SUNLIGHT = [[-2, [1.0, 0.34, 0.11], 0], [0, [1.0, 0.44, 0.15], 0.55], [3, [1.0, 0.61, 0.29], 1.5], [8, [1.0, 0.79, 0.54], 2.5],
  [16, [1.0, 0.91, 0.76], 3.2], [30, [1.0, 0.96, 0.88], 3.6], [90, [1.0, 0.97, 0.90], 3.7]];
// Clouds: sunlit side, shaded side, and the thin high cirrus (which still catches light after the sun is gone).
const CLOUD = [
  [-20, [0.060, 0.075, 0.110], [0.024, 0.031, 0.055], [0.050, 0.060, 0.100]],
  [-8, [0.130, 0.115, 0.175], [0.045, 0.050, 0.090], [0.220, 0.150, 0.210]],
  [-4, [0.820, 0.380, 0.320], [0.130, 0.120, 0.215], [0.960, 0.500, 0.420]],
  [0.5, [1.000, 0.600, 0.340], [0.300, 0.250, 0.365], [1.000, 0.700, 0.500]],
  [5, [1.000, 0.830, 0.620], [0.450, 0.440, 0.545], [1.000, 0.880, 0.740]],
  [14, [1.000, 0.960, 0.900], [0.560, 0.610, 0.705], [0.980, 0.970, 0.960]],
  [90, [0.990, 0.985, 0.980], [0.580, 0.640, 0.730], [0.970, 0.975, 0.980]],
];

function dirFrom(azDeg, elDeg, out) {
  const az = azDeg * DEG, el = elDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// ------------------------------------------------------------------ noise shared by the sky shader and this file
// (the same table on both sides, so the code below knows whether a cloud is in front of the sun)
const NN = 256;
function makeNoise() {
  const data = new Uint8Array(NN * NN * 4);
  let s = 1234567;
  for (let i = 0; i < data.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; data[i] = s >>> 24; }
  const tex = new THREE.DataTexture(data, NN, NN, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  const at = (x, y) => data[((((y % NN) + NN) % NN) * NN + (((x % NN) + NN) % NN)) * 4] / 255;
  const vn = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return lerp(lerp(at(ix, iy), at(ix + 1, iy), fx), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx), fy);
  };
  const fbm = (x, y, oct, norm) => { let a = 0.5, sum = 0; for (let i = 0; i < oct; i++) { sum += a * vn(x, y); x = x * 2.02 + 37; y = y * 2.02 + 11; a *= 0.5; } return sum / norm; };
  /** cloud density (0..1) at a point of the cloud layer; mirrors cloudD() in the shader */
  const density = (x, y, cover) => {
    const f = fbm(x, y, 5, 0.96875) * 0.78 + fbm(x * 3.1 + 9, y * 3.1 + 9, 3, 0.875) * 0.22, th = lerp(0.74, 0.30, cover);
    return sstep(th, th + 0.2, f);
  };
  return { tex, density };
}

// ------------------------------------------------------------------ sky dome
const SKY_VERT = `varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
  varying vec3 d;
  uniform sampler2D uNoise;
  uniform vec3 uSun, uMoon, uZenith, uHorSun, uHorAnti, uGround, uSunCol, uCloudLit, uCloudShade, uCirrusCol, uFlashDir;
  uniform float uBand, uGlow, uCover, uCirrus, uOvercast, uTime, uStars, uSunDisc, uMoonDisc, uEnv, uFlash, uBolt, uBoltAz, uBoltSeed;

  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return texture2D(uNoise, (i + f + 0.5) / 256.0).r; }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.02 + vec2(37.0, 11.0); a *= 0.5; } return s / 0.96875; }
  float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * vn(p); p = p * 2.02 + vec2(37.0, 11.0); a *= 0.5; } return s / 0.875; }
  float cover(float f){ float th = mix(0.74, 0.30, uCover); return smoothstep(th, th + 0.2, f); }
  float cloudD(vec2 uv){ return cover(fbm(uv) * 0.78 + fbm3(uv * 3.1 + 9.0) * 0.22); }
  float cloudL(vec2 uv){ return cover(fbm3(uv)); }
  float zig(float x, float row){ return texture2D(uNoise, vec2(x + 0.5, row + 0.5) / 256.0).r - 0.5; }   // straight-line noise: kinks, like a bolt

  void main(){
    vec3 n = normalize(d);
    float h = n.y, hp = max(h, 0.0);

    // --- air: the horizon is warm on the sun's side and cool (pink at twilight) on the far side
    vec2 sh = uSun.xz / max(length(uSun.xz), 1e-4), nh = n.xz / max(length(n.xz), 1e-4);
    float side = pow(clamp(dot(nh, sh) * 0.5 + 0.5, 0.0, 1.0), 1.6);
    vec3 hor = mix(uHorAnti, uHorSun, side);
    vec3 c = mix(hor, uZenith, 1.0 - exp(-hp * uBand));
    float mu = max(dot(n, uSun), 0.0);
    c += uSunCol * uGlow * (pow(mu, 4.0) * 0.35 * exp(-hp * 8.0) + pow(mu, 28.0) * 0.4);
    c += uSunCol * uSunDisc * (pow(mu, 220.0) * 0.45 + pow(mu, 2500.0) * 0.6 + smoothstep(0.99990, 0.99996, mu) * 3.0);
    float mm = max(dot(n, uMoon), 0.0);
    c += vec3(0.86, 0.90, 1.0) * uMoonDisc * (smoothstep(0.99992, 0.99997, mm) * 1.2 + pow(mm, 400.0) * 0.12 + pow(mm, 30.0) * 0.03);

    // --- stars
    vec3 sc = n * 420.0, cell = floor(sc);
    float rnd = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = step(0.9965, rnd) * smoothstep(0.5, 0.05, length(sc - cell - 0.5)) * (0.65 + 0.35 * sin(uTime * 1.7 + rnd * 60.0));
    float starMask = uStars * smoothstep(0.02, 0.22, h);

    float dn = 0.0;
    if (h > 0.0) {
      // --- high, thin cirrus
      vec2 cu = n.xz / (h + 0.3) + uTime * vec2(0.0035, 0.0012);
      float ci = smoothstep(0.50, 0.78, fbm(cu * vec2(0.55, 2.3) + 40.0)) * uCirrus * smoothstep(0.0, 0.18, h);
      c = mix(c, uCirrusCol, ci * 0.5);
      starMask *= 1.0 - ci * 0.6;
      // --- cumulus: a layer drifting in from the sea, lit from the sun's side and darker where it is thick
      vec2 uv = n.xz / (h + 0.16) * 1.5 + uTime * vec2(0.011, 0.0045);
      dn = cloudD(uv);
      if (dn > 0.002) {
        vec2 ls = uSun.xz * 0.42 + sh * 0.06;                              // a step toward the sun
        float occ = cloudL(uv + ls) * 0.6 + cloudL(uv + ls * 2.3) * 0.4;   // cloud standing between here and the sun
        float lit = exp(-occ * 2.4) * (1.0 - 0.5 * smoothstep(0.35, 1.0, dn));
        lit = mix(lit, 0.45, uOvercast);
        vec3 cc = mix(uCloudShade, uCloudLit, lit);
        cc *= mix(1.0, 0.78 + 0.34 * fbm3(uv * 0.45 + 3.0), uOvercast);    // heavy patches in an overcast sky
        cc += uSunCol * uSunDisc * pow(mu, 12.0) * 0.45 * (1.0 - smoothstep(0.1, 0.9, dn));   // bright rims near the sun
        float far = smoothstep(0.0, 0.16, h);                              // melt into the haze at the horizon
        c = mix(c, mix(hor, cc, 0.3 + 0.7 * far), dn * (0.35 + 0.65 * far));
      }
      starMask *= 1.0 - dn;
    }
    c += vec3(0.9, 0.95, 1.0) * star * starMask;

    // --- lightning: the clouds light up from inside, and a near strike shows its bolt
    if (uFlash > 0.001) {
      float fl = pow(max(dot(n, uFlashDir), 0.0), 5.0);
      c += vec3(0.62, 0.72, 1.0) * uFlash * (0.16 + 0.9 * fl) * (0.4 + 0.6 * dn);
    }
    if (uBolt > 0.001) {
      float a = atan(n.x, n.z) - uBoltAz; a = atan(sin(a), cos(a));
      float e = asin(clamp(h, -1.0, 1.0));
      // a leaning, kinked main channel, plus one fainter branch that forks off part-way down
      float path = zig(e * 9.0, uBoltSeed) * 0.10 + zig(e * 60.0, uBoltSeed + 3.0) * 0.034 + zig(e * 230.0, uBoltSeed + 9.0) * 0.012;
      float dd = abs(a - path) * cos(e);
      float span = smoothstep(0.50, 0.40, e) * step(0.0, e);
      float core = smoothstep(0.0022, 0.0004, dd) * 1.7 + 0.00003 / (dd * dd + 0.00008);
      float e0 = 0.20 + 0.12 * fract(uBoltSeed * 0.37), dir = fract(uBoltSeed * 7.13) > 0.5 ? 1.0 : -1.0;
      float db = abs(a - path - (e0 - e) * 0.55 * dir - zig(e * 140.0, uBoltSeed + 21.0) * 0.02 * step(e, e0)) * cos(e);
      float branch = (smoothstep(0.0016, 0.0003, db) + 0.000012 / (db * db + 0.00006)) * step(e, e0) * smoothstep(e0 - 0.17, e0 - 0.05, e) * 0.6;
      c += vec3(0.86, 0.90, 1.0) * uBolt * span * (core + branch);
    }

    c = max(mix(c, uGround, smoothstep(0.015, -0.07, h)), vec3(0.0));
    if (uEnv < 0.5) c += (texture2D(uNoise, gl_FragCoord.xy / 256.0).g - 0.5) / 200.0;    // hides banding in the dark gradients
    gl_FragColor = vec4(c, 1.0);
  }`;

// ------------------------------------------------------------------ rain
// Camera-facing streaks in a box that travels with the camera, so it rains everywhere you look.
// (The scene uses a logarithmic depth buffer; these shaders must too, or the drops hide behind everything.)
const RAIN_VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 seed;
  uniform vec3 uCam, uBox, uWind; uniform float uTime, uPx;
  varying float vA;
  void main(){
    float sp = 0.8 + seed.x * 0.4;
    vec3 fall = vec3(uWind.x, -1.0, uWind.z);
    vec3 q = fract(seed + fall * (uTime * sp * 10.0) / uBox - uCam / uBox);
    vec3 top = uCam + (q - 0.5) * uBox;
    vec3 dir = normalize(fall);
    vec3 base = top + dir * (0.7 + seed.y * 0.9) * position.y;
    vec3 toCam = cameraPosition - base;
    float dist = length(toCam);
    vec3 side = normalize(cross(dir, toCam));
    float w = max(0.010, dist * uPx * 1.2);                 // never thinner than about a pixel
    vA = (1.0 - position.y * 0.55) * smoothstep(58.0, 26.0, dist) * smoothstep(0.5, 2.5, dist) * (0.5 + seed.z * 0.5);
    gl_Position = projectionMatrix * viewMatrix * vec4(base + side * position.x * w, 1.0);
    #include <logdepthbuf_vertex>
  }`;
const RAIN_FRAG = `
  #include <logdepthbuf_pars_fragment>
  uniform float uAlpha; uniform vec3 uTint; varying float vA;
  void main(){
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(uTint, vA * uAlpha);
  }`;

export function createWeather({ scene, renderer, reduceMotion = false, quality = { shadowSize: 2048, envSize: 256 } }) {
  const noise = makeNoise();
  const V3 = () => ({ value: new THREE.Vector3() });
  const U = {
    uNoise: { value: noise.tex }, uSun: V3(), uMoon: V3(), uZenith: V3(), uHorSun: V3(), uHorAnti: V3(), uGround: V3(), uSunCol: V3(),
    uCloudLit: V3(), uCloudShade: V3(), uCirrusCol: V3(), uFlashDir: V3(),
    uBand: { value: 3 }, uGlow: { value: 0 }, uCover: { value: 0.2 }, uCirrus: { value: 0.3 }, uOvercast: { value: 0 }, uTime: { value: 0 },
    uStars: { value: 0 }, uSunDisc: { value: 1 }, uMoonDisc: { value: 0 }, uEnv: { value: 0 },
    uFlash: { value: 0 }, uBolt: { value: 0 }, uBoltAz: { value: 0 }, uBoltSeed: { value: 0 },
  };
  const skyMat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: U, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG });
  const skyGeo = new THREE.SphereGeometry(20000, 64, 32);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = 4;                                 // last: only the sky that shows between the trees gets worked out
  scene.add(sky);

  // the sun (or, at night, the moon): the one light that casts shadows
  const sun = new THREE.DirectionalLight('#ffdcb0', 3.4);
  sun.target.position.set(2, 4, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  Object.assign(sun.shadow.camera, { left: -36, right: 36, top: 34, bottom: -34, near: 10, far: 280 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
  const hemi = new THREE.HemisphereLight('#bcd4f0', '#3b3a22', 0.4);
  const boltLight = new THREE.DirectionalLight('#cfdcff', 0);       // a lightning strike lights the land for an instant
  boltLight.target.position.set(2, 4, 0);
  scene.add(sun, sun.target, hemi, boltLight, boltLight.target);

  const lamps = [];
  const state = { p: 0, time: 0, day: 0, rain: 0, cloud: 0, lights: 1, sunEl: -20, flash: 0 };

  // ambient light and reflections are captured from the sky itself, again and again as it changes
  const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(skyGeo, skyMat));
  // On a modest computer the sky is first drawn into a small cube: a sixteenth of the work, about once a second,
  // for ambient light that looks the same and reflections that are only a little softer.
  const small = quality.envSize < 256 ? new THREE.WebGLCubeRenderTarget(quality.envSize, { type: THREE.HalfFloatType }) : null;
  const smallCam = small ? new THREE.CubeCamera(1, 25000, small) : null;
  let envRT = null, envP = -1, envCover = -1;
  function refreshEnv() {
    const keep = [U.uSunDisc.value, U.uStars.value, U.uFlash.value, U.uBolt.value];
    U.uEnv.value = 1; U.uSunDisc.value = 0; U.uStars.value = 0; U.uFlash.value = 0; U.uBolt.value = 0;
    if (small) smallCam.update(renderer, envScene);
    const rt = small ? pmrem.fromCubemap(small.texture) : pmrem.fromScene(envScene, 0, 1, 25000);
    U.uEnv.value = 0; [U.uSunDisc.value, U.uStars.value, U.uFlash.value, U.uBolt.value] = keep;
    scene.environment = rt.texture; scene.environmentIntensity = 0.85;
    if (envRT) envRT.dispose();
    envRT = rt; envP = state.p; envCover = U.uCover.value;
  }

  // rain
  const N = 9000, seed = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
  rainGeo.setIndex([0, 1, 2, 0, 2, 3]);
  rainGeo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 3));
  rainGeo.instanceCount = N;
  const rainU = { uCam: V3(), uBox: { value: new THREE.Vector3(64, 40, 64) }, uWind: { value: new THREE.Vector3(0.24, 0, -0.08) },
    uTime: { value: 0 }, uAlpha: { value: 0 }, uPx: { value: 0.001 }, uTint: { value: new THREE.Vector3(0.8, 0.85, 0.9) } };
  const rain = new THREE.Mesh(rainGeo, new THREE.ShaderMaterial({ uniforms: rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  rain.frustumCulled = false; rain.visible = false; rain.renderOrder = 5;
  scene.add(rain);

  let sunOcc = -1, prevP = null, viewAz = Math.PI;
  const flashes = [];                                   // lightning in progress
  const tmp = new THREE.Vector3(), sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), cA = new THREE.Color(), cB = new THREE.Color();
  const GREY = { zen: [0.47, 0.51, 0.55], hor: [0.64, 0.67, 0.69] };

  const api = {
    state, materials: {}, bookLamp: null, paused: false,
    /** called for every lightning strike: { near, clip, delay }: the thunder follows `delay` seconds later */
    onStrike: null,
    /** warm lamps under the veranda roofs; they come on at dusk and when the weather closes in */
    addHouseLights(deck) {
      for (const [x, z] of [[3.0, 1.1], [9.4, 1.1], [-2.3, -1.3], [-5.8, -5.3]]) {
        const l = new THREE.PointLight('#ffb673', 0, 11, 1.7); l.position.set(x, deck + 2.25, z); scene.add(l); lamps.push(l);
      }
    },
    buildEnvironment() { apply(0); refreshEnv(); },
    setCycle(p) { state.p = ((p % 1) + 1) % 1; prevP = null; flashes.length = 0; sunOcc = -1; apply(0); refreshEnv(); },
    /** fire a lightning strike now (near: 0 far .. 1 overhead) */
    strike(near = 1, clip = 3) { strike({ near, clip }); },
    update(dt, { camera, shelter = 0 }) {
      state.time += dt;
      if (!api.paused) state.p = (state.p + dt / CYCLE_SECONDS) % 1;
      const f = camera.getWorldDirection(tmp); viewAz = Math.atan2(f.x, f.z);
      if (prevP !== null && state.p > prevP && state.p - prevP < 0.02) for (const s of STRIKES) if (prevP < s.p && state.p >= s.p) strike(s);
      prevP = state.p;
      apply(dt, shelter);
      if (Math.abs(state.p - envP) > 0.0035 || Math.abs(U.uCover.value - envCover) > 0.03) refreshEnv();
      rainU.uCam.value.copy(camera.position);
      rainU.uPx.value = (2 * Math.tan(camera.fov * DEG / 2)) / Math.max(1, renderer.domElement.clientHeight);
    },
  };

  function strike(s) {
    const delay = lerp(4.5, 0.5, s.near);
    // somewhere in the sky the camera is looking at, so the flash is seen
    flashes.push({ t: 0, near: s.near, az: viewAz + (Math.random() - 0.5) * 0.5, seed: Math.random() * 200, bolt: s.near >= 0.6 });
    if (api.onStrike) api.onStrike({ near: s.near, clip: s.clip, delay });
  }
  // a strike is a few quick flickers, not one blink
  const PULSES = [[0, 1], [0.09, 0.5], [0.2, 0.85], [0.43, 0.3]];
  const flicker = (t) => PULSES.reduce((sum, [at, amp]) => sum + (t >= at ? amp * Math.exp(-(t - at) / 0.055) : 0), 0);

  function apply(dt, shelter = 0) {
    const p = state.p, time = state.time;
    const el = sunElAt(p), rainNow = rainAt(p), wet = wetAt(p);
    // clouds come and go on their own inside the fair-weather parts of the loop
    const drift = 0.11 * Math.sin(time * 0.021 + 1.3) + 0.07 * Math.sin(time * 0.047 + 0.4);
    const base = cloudAt(p);
    const cloud = base > 0.6 ? base : clamp(base + drift * (1 - sstep(0.45, 0.6, base)), 0.1, 0.6);
    const ov = sstep(0.6, 1.0, cloud);                              // overcast
    const light = sstep(-8, 6, el);                                 // 0 night .. 1 day
    const dim = (0.2 + 0.8 * light) * (1 - 0.3 * rainNow);

    dirFrom(sunAzAt(p), el, sunDir);
    const q = clamp((((p - SET) % 1 + 1) % 1) / (1 - SET + RISE), 0, 1);        // how far through the night
    dirFrom(lerp(200, 122, q), 4.5 + 2.5 * Math.sin(Math.PI * q), moonDir);      // the moon crosses low behind the house, just over the trees

    let [zen, horSun, horAnti, band, glow] = keyed(SKY, el);
    const [sunCol, sunPower] = keyed(SUNLIGHT, el);
    let [cLit, cShade, cirrus] = keyed(CLOUD, el);
    zen = mix3(zen, scale3(GREY.zen, dim), ov); horSun = mix3(horSun, scale3(GREY.hor, dim), ov); horAnti = mix3(horAnti, scale3(GREY.hor, dim), ov);
    cLit = mix3(cLit, scale3([0.72, 0.74, 0.76], dim), ov); cShade = mix3(cShade, scale3([0.36, 0.39, 0.43], dim), ov);
    glow *= 1 - ov;
    const horMid = mix3(horAnti, horSun, 0.4);
    const ground = mix3(scale3(horMid, 0.45), scale3([0.15, 0.19, 0.11], 0.1 + 0.9 * light), 0.5);

    U.uSun.value.copy(sunDir); U.uMoon.value.copy(moonDir);
    U.uZenith.value.fromArray(zen); U.uHorSun.value.fromArray(horSun); U.uHorAnti.value.fromArray(horAnti); U.uGround.value.fromArray(ground);
    U.uSunCol.value.fromArray(sunCol); U.uCloudLit.value.fromArray(cLit); U.uCloudShade.value.fromArray(cShade); U.uCirrusCol.value.fromArray(cirrus);
    U.uBand.value = band; U.uGlow.value = glow; U.uCover.value = cloud; U.uOvercast.value = ov; U.uTime.value = time;
    U.uCirrus.value = (0.4 + 0.35 * Math.sin(time * 0.013 + 2.0)) * (1 - ov);
    U.uStars.value = (1 - sstep(-12, -5, el)) * (1 - ov);
    U.uSunDisc.value = sstep(-1.2, 0.3, el) * (1 - ov);
    U.uMoonDisc.value = (1 - sstep(-9, -5, el)) * (1 - ov);

    // is a cloud passing in front of the sun? (same noise as the sky, so the light dims when you see it happen)
    const sh = Math.max(sunDir.y, 0) + 0.16;
    const occNow = noise.density(sunDir.x / sh * 1.5 + time * 0.011, sunDir.z / sh * 1.5 + time * 0.0045, cloud);
    sunOcc = sunOcc < 0 ? occNow : sunOcc + (occNow - sunOcc) * (1 - Math.exp(-dt * 1.2));

    if (el > -3) {
      sun.position.copy(sunDir).multiplyScalar(130).add(sun.target.position);
      sun.color.setRGB(sunCol[0], sunCol[1], sunCol[2], THREE.SRGBColorSpace);
      sun.intensity = sunPower * (1 - 0.93 * ov) * (1 - 0.62 * sunOcc * (1 - ov));
    } else {
      sun.position.copy(moonDir).multiplyScalar(130).add(sun.target.position);
      sun.color.set('#8fa9e0'); sun.intensity = 0.75 * (1 - sstep(-11, -5, el)) * (1 - 0.6 * ov);
    }
    hemi.color.copy(cA.set('#1d2a47')).lerp(cB.set('#bcd4f0'), light);
    hemi.groundColor.copy(cA.set('#06090b')).lerp(cB.set('#3b3a22'), light);
    hemi.intensity = 0.2 + 0.18 * light + 0.3 * light * ov;
    renderer.toneMappingExposure = lerp(1.3, 0.95, sstep(-8, 8, el));
    if (scene.fog) {
      const toSun = Math.pow(clamp(0.5 + 0.5 * Math.cos(viewAz - sunAzAt(p) * DEG), 0, 1), 1.6);
      const haze = mix3(horAnti, horSun, toSun);
      scene.fog.color.setRGB(haze[0] * 0.97, haze[1] * 0.97, haze[2] * 0.97, THREE.SRGBColorSpace);
      const mist = p < 0.3 ? sstep(-9, -2, el) * (1 - sstep(8, 24, el)) : 0;          // a little morning mist
      scene.fog.density = 0.00042 + 0.0015 * mist + 0.0006 * ov + 0.0026 * rainNow;
    }

    // lightning
    let flash = 0, bolt = 0;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]; f.t += dt;
      if (f.t > 0.9) { flashes.splice(i, 1); continue; }
      const k = flicker(f.t) * (0.3 + 0.7 * f.near);
      if (k > flash) { flash = k; dirFrom(f.az / DEG, 15, U.uFlashDir.value); U.uBoltAz.value = f.az; U.uBoltSeed.value = f.seed; bolt = f.bolt ? k : 0; }
    }
    if (reduceMotion) { flash = 0; bolt = 0; }                      // no flashing for people who asked for less motion
    U.uFlash.value = flash; U.uBolt.value = bolt;
    boltLight.intensity = 5.5 * flash;
    if (flash > 0) { boltLight.position.copy(U.uFlashDir.value).multiplyScalar(130).add(boltLight.target.position); hemi.intensity += 1.1 * flash; }

    // the house: lamps and windows glow at night and when the weather closes in
    const on = Math.max(1 - sstep(-4, 3, el), 0.6 * sstep(0.8, 1.0, cloud));
    for (const l of lamps) l.intensity = 14 * on;
    const M = api.materials;
    if (M.glow) M.glow.emissiveIntensity = 0.25 + 2.8 * on;
    if (M.glass) { M.glass.emissive.set('#ffae5c'); M.glass.emissiveIntensity = 0.75 * on; }
    if (api.bookLamp) api.bookLamp.intensity = 1.7 + 0.9 * on;
    // wet roofs and boards while it rains, drying off afterwards
    if (M.roof) M.roof.roughness = lerp(0.75, 0.3, wet);
    if (M.deck) M.deck.roughness = lerp(0.8, 0.35, wet);

    rainU.uTime.value = time;
    rainU.uAlpha.value = 0.62 * rainNow * (1 - shelter) * (1 + 0.8 * flash);
    rainU.uTint.value.set(0.8, 0.85, 0.9).multiplyScalar(0.55 + 0.45 * light);
    rain.visible = rainU.uAlpha.value > 0.003;

    Object.assign(state, { day: sstep(-5, 6, el), rain: rainNow, cloud, lights: on, sunEl: el, flash });
  }

  apply(0);
  return api;
}
