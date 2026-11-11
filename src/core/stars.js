// Shared star-field: crisp, energy-conserving point stars with black-body colours, used as the backdrop of every realm.
import * as THREE from 'three';
import { GLSL } from './glsl.js';
import { RNG } from './rng.js';
import { blackbody } from './color.js';

/**
 * @param {object} o
 *  count, seed, radius (shell radius; stars sit on a sphere around the origin),
 *  band: { normal:[x,y,z], strength } optional "milky way" concentration toward a plane,
 *  brightness (overall multiplier)
 * @returns THREE.Points with .material.uniforms (uPixelRatio, uSizeScale, uBrightness, uTime, uTwinkle) and .tick(app)
 */
export function createStarfield({ count = 6000, seed = 'stars', radius = 900, band = null, brightness = 1, twinkle = 0 } = {}) {
  const rng = new RNG(seed);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), mag = new Float32Array(count), size = new Float32Array(count);
  const n = band ? new THREE.Vector3(...band.normal).normalize() : null;
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    let tries = 0;
    do {
      const d = rng.onSphere(); v.set(d[0], d[1], d[2]);
      if (!n) break;
      const lat = Math.abs(v.dot(n)); // 0 on the band plane
      if (rng.next() < Math.exp(-lat * lat * 9 * band.strength) + 0.22) break;
    } while (++tries < 8);
    pos[i * 3] = v.x * radius; pos[i * 3 + 1] = v.y * radius; pos[i * 3 + 2] = v.z * radius;
    // luminosity function: many faint, few brilliant
    const m = rng.power(0.02, 1, 2.1);
    // temperature mix skewed like naked-eye stars (bright ones are often hot or giant)
    const T = rng.weighted([3300, 4200, 5200, 5900, 7200, 9500, 14000, 24000], [2.2, 2.4, 2.0, 1.6, 1.5, 1.3, 0.7, 0.3]) * rng.float(0.92, 1.08);
    const c = blackbody(T);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    mag[i] = m * 2.2;
    size[i] = 1.1 + Math.pow(m, 0.6) * 5.2 + (m > 0.82 ? (m - 0.82) * 60 : 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: GLSL.starVertex, fragmentShader: GLSL.starFragment,
    uniforms: { uPixelRatio: { value: 1 }, uSizeScale: { value: 1 }, uBrightness: { value: brightness }, uTime: { value: 0 }, uTwinkle: { value: twinkle } },
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; pts.renderOrder = -10;
  pts.tick = (app) => { mat.uniforms.uPixelRatio.value = app.viewport.pixelRatio; mat.uniforms.uTime.value = app.time; };
  return pts;
}
