// The traveller: a cloaked wanderer with a long scarf, seen in third person (or through their eyes), and the
// hover-skiff they ride. Movement is built to feel like flow: soft acceleration, a jump that becomes a glide if you
// hold it, a skiff that banks, coasts and climbs — all the way back to orbit if you keep rising.

import * as THREE from 'three';
import { LIGHT_GLSL, paint, merge } from './terrain.js';
import { clamp, damp, smoothstep } from '../../core/rng.js';

const BODY_VERT = /* glsl */ `
uniform float uTime, uSway; uniform vec3 uVelLocal;
attribute vec3 color;
varying vec3 vW, vN, vC;
void main(){
  vec3 p = position; float k = smoothstep(1.4, 0.0, p.y) * uSway;                 // the hem trails and flutters
  p.xz -= uVelLocal.xz * 0.055 * k * k;
  p.x += sin(uTime * 5.0 + p.y * 4.0) * 0.028 * k; p.z += cos(uTime * 4.1 + p.y * 3.0) * 0.028 * k;
  vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vC = color;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const BODY_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec3 vW, vN, vC;
void main(){
  vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
  vec3 albedo = min(vC, vec3(1.0)), emis = max(vC - 1.0, 0.0);
  vec3 lit = shade(albedo, N, vW, 1.0) + albedo * (uSkyColor + uSunColor * 0.15) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.8 + emis * (0.9 + 1.8 * uNight);
  gl_FragColor = vec4(fogged(lit, vW), 1.0);
}`;

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _w = new THREE.Vector3(), _h = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3();
const angDamp = (a, b, tau, dt) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * (1 - Math.exp(-dt / tau)); };

export class Player {
  constructor(scene, light, camera) {
    this.camera = camera; this.light = light;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = 0; this.onGround = true; this.riding = false; this.first = false;
    this.camYaw = 0; this.camPitch = 0.22; this.camDist = 5.4; this.arrive = 0; this.alt = 1.6; this.altTarget = 1.6; this.gliding = false; this.bank = 0; this._bob = 0; this.speed = 0;
    const mat = (sway) => new THREE.ShaderMaterial({ vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, uniforms: { ...light, uSway: { value: sway }, uVelLocal: { value: new THREE.Vector3() } }, side: THREE.DoubleSide });
    // --- the wanderer ---
    const cloak = paint(new THREE.LatheGeometry([[0.02, 1.5], [0.15, 1.46], [0.21, 1.24], [0.2, 1.0], [0.25, 0.7], [0.36, 0.3], [0.5, 0.02]].map(([x, y]) => new THREE.Vector2(x, y)), 24), 0.2, 0.022, 0.03);
    const cape = paint(new THREE.LatheGeometry([[0.0, 1.52], [0.23, 1.47], [0.3, 1.32], [0.27, 1.18]].map(([x, y]) => new THREE.Vector2(x, y)), 24), 0.3, 0.035, 0.04);
    const trim = paint(new THREE.TorusGeometry(0.5, 0.022, 6, 24).rotateX(Math.PI / 2).translate(0, 0.03, 0), 1.5, 1.0, 0.32);
    const sash = paint(new THREE.TorusGeometry(0.212, 0.018, 6, 20).rotateX(Math.PI / 2).translate(0, 1.02, 0), 1.35, 0.9, 0.3);
    const hood = paint(new THREE.SphereGeometry(0.245, 18, 12).scale(1, 1.08, 1.05).translate(0, 1.67, -0.03), 0.24, 0.028, 0.035);
    const peak = paint(new THREE.ConeGeometry(0.16, 0.34, 10).rotateX(-0.9).translate(0, 1.86, -0.2), 0.24, 0.028, 0.035);
    const face = paint(new THREE.SphereGeometry(0.19, 16, 10).translate(0, 1.62, 0.085), 0.02, 0.015, 0.02);
    const eyes = [-1, 1].map((sx) => paint(new THREE.SphereGeometry(0.027, 8, 6).translate(sx * 0.066, 1.645, 0.262), 4.0, 3.3, 2.2));
    this.bodyMat = mat(1);
    this.body = new THREE.Mesh(merge([cloak, cape, trim, sash, hood, peak, face, ...eyes]), this.bodyMat); this.body.frustumCulled = false;
    this.group = new THREE.Group(); this.group.add(this.body); scene.add(this.group);
    // --- the scarf: a little rope simulation drawn as a ribbon ---
    this.N = 22; this.sp = []; this.sv = []; for (let i = 0; i < this.N; i++) { this.sp.push(new THREE.Vector3()); this.sv.push(new THREE.Vector3()); }
    const sg = new THREE.BufferGeometry(), idx = [];
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.N * 6), 3)); sg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.N * 6).fill(0), 3));
    const col = new Float32Array(this.N * 6); for (let i = 0; i < this.N * 2; i++) { const t = Math.floor(i / 2) / this.N; col[i * 3] = 1.25 - 0.4 * t; col[i * 3 + 1] = 0.78 - 0.4 * t; col[i * 3 + 2] = 0.2; }
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (let i = 0; i < this.N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2); sg.setIndex(idx);
    this.scarf = new THREE.Mesh(sg, mat(0)); this.scarf.frustumCulled = false; scene.add(this.scarf);
    // --- the skiff ---
    const hull = paint(new THREE.SphereGeometry(1, 22, 12).scale(0.56, 0.12, 1.75), 0.085, 0.095, 0.12);
    const glow = paint(new THREE.SphereGeometry(1, 16, 8).scale(0.4, 0.045, 1.35).translate(0, -0.1, 0), 0.5, 2.6, 3.1);
    const fin = paint(new THREE.BoxGeometry(0.035, 0.46, 0.7).translate(0, 0.28, -1.25), 0.5, 0.07, 0.05);
    const lamp = paint(new THREE.SphereGeometry(0.06, 8, 6).translate(0, 0.07, 1.62), 5, 4, 2.6);
    this.skiff = new THREE.Mesh(merge([hull, glow, fin, lamp]), mat(0)); this.skiff.frustumCulled = false; this.skiff.visible = false; scene.add(this.skiff);
  }

  reset(x, z, world, yaw = 0) {
    this.pos.set(x, world.height(x, z), z); this.vel.set(0, 0, 0); this.yaw = yaw; this.camYaw = yaw + Math.PI; this.camPitch = 0.2; this.onGround = true;
    this.riding = false; this.skiff.visible = false; this.arrive = 1; this.altTarget = 1.6;
    for (const p of this.sp) p.set(x, this.pos.y + 1.4, z);
    this.camera.position.set(x, this.pos.y + 80, z + 60);
  }
  toggleRide() { this.riding = !this.riding; this.skiff.visible = this.riding; this.altTarget = Math.max(1.6, this.alt); if (!this.riding) { this.onGround = false; this.vel.y = Math.min(this.vel.y, 2); } }

  update(dt, input, world, time) {
    const p = this.pos, v = this.vel, cam = this.camera, sea = world.hasSea;
    // ---- look ----
    const sens = input.lastDevice === 'gamepad' ? 0.0028 : 0.0025;
    this.camYaw -= input.look.x * sens; this.camPitch = clamp(this.camPitch + input.look.y * sens, this.first ? -1.35 : -0.42, this.first ? 1.35 : 1.25);
    if (input.pressed('view')) { this.first = !this.first; }
    if (input.pressed('vehicle')) this.toggleRide();
    _f.set(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw)); _r.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    _w.set(0, 0, 0).addScaledVector(_f, input.move.y).addScaledVector(_r, input.move.x); const wl = _w.length(); if (wl > 1) _w.multiplyScalar(1 / wl);
    const moving = wl > 0.05, raw = world.height(p.x, p.z), g = sea ? Math.max(raw, this.riding ? 0 : -1.1) : raw;
    this.gliding = false;
    if (this.riding) {
      const top = input.down('sprint') ? 54 : 29;
      const tau = moving ? 0.6 : 1.7;                                                   // it coasts
      v.x = damp(v.x, _w.x * top, tau, dt); v.z = damp(v.z, _w.z * top, tau, dt);
      this.altTarget = clamp(this.altTarget + (input.down('jump') ? 36 : input.down('brake') ? -40 : -7) * dt, 1.6, 430);
      const ty = g + this.altTarget + Math.sin(time * 1.7) * 0.07, ny = damp(p.y, ty, 0.28, dt); v.y = (ny - p.y) / Math.max(dt, 1e-4); p.y = ny; this.onGround = false;
    } else {
      const wading = sea && raw < -0.35, top = (input.down('sprint') ? 9.6 : 4.7) * (wading ? 0.5 : 1);
      const tau = this.onGround ? 0.1 : 0.4;
      v.x = damp(v.x, _w.x * top, tau, dt); v.z = damp(v.z, _w.z * top, tau, dt);
      if (this.onGround) { if (input.pressed('jump')) { v.y = 7.9; this.onGround = false; } else { p.y = damp(p.y, g, 0.035, dt); v.y = 0; } }
      if (!this.onGround) {
        v.y -= 21 * dt;
        if (input.down('jump') && v.y < -1.3) { v.y = Math.max(v.y, -1.5); this.gliding = true; const sp = Math.hypot(v.x, v.z); if (moving && sp < 13) { v.x *= 1 + 1.4 * dt; v.z *= 1 + 1.4 * dt; } }   // the cloak catches the air
        p.y += v.y * dt; if (p.y <= g) { p.y = g; v.y = 0; this.onGround = true; }
      }
    }
    p.x += v.x * dt; p.z += v.z * dt;
    this.alt = p.y - g; const sp = (this.speed = Math.hypot(v.x, v.z));
    // ---- body ----
    const prevYaw = this.yaw; if (sp > 0.4) this.yaw = angDamp(this.yaw, Math.atan2(v.x, v.z), this.riding ? 0.22 : 0.09, dt);
    let turn = this.yaw - prevYaw; turn = Math.atan2(Math.sin(turn), Math.cos(turn)) / Math.max(dt, 1e-4);
    this.bank = damp(this.bank, clamp(-turn * 0.22 * Math.min(1, sp / 12), -0.6, 0.6), 0.25, dt);
    this._bob += sp * dt * 2.3; const bob = this.onGround && !this.riding ? Math.abs(Math.sin(this._bob)) * 0.05 * Math.min(1, sp / 4) : 0;
    const G = this.group; G.position.set(p.x, p.y + bob + (this.riding ? 0.16 : 0), p.z);
    G.rotation.set(0, 0, 0); G.rotateY(this.yaw); G.rotateZ(this.riding ? this.bank : this.bank * 0.4); G.rotateX(this.gliding ? 0.55 : Math.min(0.3, sp * (this.riding ? 0.004 : 0.016)));
    this.body.visible = !this.first; this.scarf.visible = !this.first;
    _t.set(v.x, 0, v.z).applyAxisAngle(_s.set(0, 1, 0), -this.yaw); this.bodyMat.uniforms.uVelLocal.value.copy(_t).multiplyScalar(this.riding ? 0.25 : 1);
    if (this.riding) { const S = this.skiff; S.position.set(p.x, p.y, p.z); S.rotation.set(0, 0, 0); S.rotateY(this.yaw); S.rotateZ(this.bank * 1.15); S.rotateX(clamp(-v.y * 0.012, -0.35, 0.35)); }
    this._scarf(dt, time);
    // ---- camera ----
    _h.set(p.x, p.y + 1.56 + bob, p.z);
    this.arrive = Math.max(0, this.arrive - dt / 3.4); const ar = this.arrive * this.arrive * (3 - 2 * this.arrive);
    const wantDist = (this.riding ? 8.6 + sp * 0.075 : 5.4 + (this.gliding ? 1.5 : 0)) + ar * 70;
    this.camDist = damp(this.camDist, this.first ? 0 : wantDist, 0.25, dt);
    const cp = Math.cos(this.camPitch + ar * 0.5), spch = Math.sin(this.camPitch + ar * 0.5);
    const dir = _c.set(Math.sin(this.camYaw) * cp, spch, Math.cos(this.camYaw) * cp);
    if (this.first || this.camDist < 0.3) { cam.position.copy(_h); cam.up.set(0, 1, 0); cam.lookAt(_t.copy(_h).addScaledVector(dir, -1)); }
    else {
      _t.copy(_h).addScaledVector(dir, this.camDist);
      const floor = Math.max(world.height(_t.x, _t.z), sea ? 0 : -1e9) + 0.55; if (_t.y < floor) _t.y = floor;       // never sink into a hillside
      const k = 1 - Math.exp(-dt / 0.045); cam.position.lerp(_t, ar > 0 ? 1 : k); if (cam.position.y < floor) cam.position.y = floor;
      cam.up.set(0, 1, 0); cam.lookAt(_t.copy(_h).setY(_h.y + 0.3 + (this.riding ? 0.5 : 0)));
    }
    if (this.riding && !this.first) cam.rotateZ(this.bank * 0.25);
    const fov = 50 + Math.min(24, sp * 0.4) + (this.gliding ? 5 : 0); if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = damp(cam.fov, fov, 0.35, dt); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  _scarf(dt, time) {
    const N = this.N, sp = this.sp, wind = this.light.uWind.value, seg = 0.15, pos = this.scarf.geometry.attributes.position.array;
    const anchor = _t.set(0, 1.42, -0.17).applyMatrix4(this.group.matrixWorld.identity().compose(this.group.position, this.group.quaternion, this.group.scale));
    sp[0].copy(anchor); const h = Math.min(dt, 1 / 30);
    for (let i = 1; i < N; i++) {
      const q = sp[i], vv = this.sv[i];
      vv.x += (wind.x * 3.2 + Math.sin(time * 3.1 + i * 0.7) * 1.6) * h; vv.z += (wind.y * 3.2 + Math.cos(time * 2.6 + i * 0.9) * 1.6) * h; vv.y += (-1.6 + Math.sin(time * 4.3 + i) * 1.1) * h;
      vv.multiplyScalar(Math.exp(-h * 3.2)); q.addScaledVector(vv, h);
      const d = _s.copy(q).sub(sp[i - 1]), l = d.length() || 1e-4; if (l > seg) { const corr = d.multiplyScalar((l - seg) / l); q.sub(corr); vv.addScaledVector(corr, -1 / h * 0.5); }
    }
    for (let i = 0; i < N; i++) {
      const a = sp[Math.max(0, i - 1)], b = sp[Math.min(N - 1, i + 1)], side = _s.copy(b).sub(a).cross(_c.set(0, 1, 0)).normalize().multiplyScalar(0.11 * (1 - 0.45 * (i / N)));
      pos[i * 6] = sp[i].x - side.x; pos[i * 6 + 1] = sp[i].y - side.y; pos[i * 6 + 2] = sp[i].z - side.z; pos[i * 6 + 3] = sp[i].x + side.x; pos[i * 6 + 4] = sp[i].y + side.y; pos[i * 6 + 5] = sp[i].z + side.z;
    }
    const nor = this.scarf.geometry.attributes.normal.array; for (let i = 0; i < N * 2; i++) { nor[i * 3 + 1] = 1; }
    this.scarf.geometry.attributes.position.needsUpdate = true; this.scarf.geometry.attributes.normal.needsUpdate = true;
  }
}
