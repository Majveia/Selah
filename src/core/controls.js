// OrbitRig — the camera used by every "cosmic" realm (web, galaxy, system, black hole, planet orbit).
// Feels like holding the universe in your hand: drag to spin with momentum, pinch/scroll for logarithmic zoom,
// gentle auto-drift when you let go, and scripted fly-throughs for cinematics and travel.

import * as THREE from 'three';
import { clamp, damp } from './rng.js';

const _v = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion();

export class OrbitRig {
  constructor(camera, input, opts = {}) {
    this.camera = camera; this.input = input;
    this.target = new THREE.Vector3().copy(opts.target || new THREE.Vector3());
    this.yaw = opts.yaw ?? 0; this.pitch = opts.pitch ?? 0.25; this.roll = 0;
    this.distance = opts.distance ?? 10;
    this.minDistance = opts.minDistance ?? 0.1; this.maxDistance = opts.maxDistance ?? 1000;
    this.minPitch = opts.minPitch ?? -1.5; this.maxPitch = opts.maxPitch ?? 1.5;
    this.rotateSpeed = opts.rotateSpeed ?? 0.0052;   // rad per CSS px
    this.zoomSpeed = opts.zoomSpeed ?? 1.0;
    this.panEnabled = opts.pan ?? false;
    this.idleSpin = opts.idleSpin ?? 0.012;          // rad/s yaw drift after the user lets go
    this.idleDelay = opts.idleDelay ?? 3.5;
    this.smooth = opts.smooth ?? 0.085;              // seconds; camera smoothing time-constant
    this.enabled = true;
    this.onZoomInLimit = null; this.onZoomOutLimit = null; // called when the user keeps pushing past the zoom limits
    this._goal = { yaw: this.yaw, pitch: this.pitch, logD: Math.log(this.distance), target: this.target.clone(), roll: 0 };
    this._vel = { yaw: 0, pitch: 0 };
    this._pressure = 0; this._idle = 0; this._flight = null; this._shake = 0;
    this.apply();
  }

  /** Jump instantly to a pose. */
  set({ target, distance, yaw, pitch, roll } = {}) {
    if (target) { this.target.copy(target); this._goal.target.copy(target); }
    if (distance != null) { this.distance = distance; this._goal.logD = Math.log(distance); }
    if (yaw != null) { this.yaw = this._goal.yaw = yaw; }
    if (pitch != null) { this.pitch = this._goal.pitch = pitch; }
    if (roll != null) { this.roll = this._goal.roll = roll; }
    this._vel.yaw = this._vel.pitch = 0; this._flight = null;
    this.apply();
    return this;
  }

  /** Scripted camera move. Returns a promise resolved on arrival (or interruption). Distance is interpolated in log space. */
  flyTo(pose, seconds = 2.5, { ease = 'inOut', interruptible = false } = {}) {
    return new Promise((resolve) => {
      if (this._flight) this._flight.resolve(false);
      const from = { target: this.target.clone(), logD: Math.log(this.distance), yaw: this.yaw, pitch: this.pitch, roll: this.roll };
      const to = {
        target: pose.target ? pose.target.clone() : from.target.clone(),
        logD: pose.distance != null ? Math.log(pose.distance) : from.logD,
        yaw: pose.yaw != null ? pose.yaw : from.yaw, pitch: pose.pitch != null ? pose.pitch : from.pitch, roll: pose.roll != null ? pose.roll : from.roll,
      };
      if (pose.shortest !== false) { // take the short way round
        while (to.yaw - from.yaw > Math.PI) to.yaw -= Math.PI * 2;
        while (to.yaw - from.yaw < -Math.PI) to.yaw += Math.PI * 2;
      }
      this._flight = { from, to, t: 0, seconds: Math.max(0.001, seconds), ease, interruptible, resolve };
    });
  }
  get flying() { return !!this._flight; }
  shake(amount) { this._shake = Math.max(this._shake, amount); }

  update(dt) {
    const inp = this.input, g = this._goal;
    const active = this.enabled && inp && inp.enabled && inp.mode === 'orbit';
    if (this._flight) {
      const f = this._flight;
      if (active && f.interruptible && (Math.abs(inp.drag.dx) + Math.abs(inp.drag.dy) > 2 || Math.abs(inp.zoom) > 0.01)) {
        this._flight = null; f.resolve(false);
      } else {
        f.t = Math.min(1, f.t + dt / f.seconds);
        const x = f.t; let e;
        switch (f.ease) {
          case 'linear': e = x; break;
          case 'out': e = 1 - Math.pow(1 - x, 3); break;
          case 'in': e = x * x * x; break;
          case 'expoOut': e = x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); break;
          default: e = x * x * x * (x * (x * 6 - 15) + 10);
        }
        this.target.lerpVectors(f.from.target, f.to.target, e);
        this.distance = Math.exp(f.from.logD + (f.to.logD - f.from.logD) * e);
        this.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * e; this.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
        this.roll = f.from.roll + (f.to.roll - f.from.roll) * e;
        g.target.copy(this.target); g.logD = Math.log(this.distance); g.yaw = this.yaw; g.pitch = this.pitch; g.roll = this.roll;
        this._vel.yaw = this._vel.pitch = 0;
        if (f.t >= 1) { this._flight = null; f.resolve(true); }
        this.apply(dt);
        return;
      }
    }

    if (active) {
      const dragging = inp.pointers.size > 0 || Math.abs(inp.drag.dx) + Math.abs(inp.drag.dy) > 0;
      if (dragging && (inp.drag.dx || inp.drag.dy)) {
        const dy = -inp.drag.dx * this.rotateSpeed, dp = inp.drag.dy * this.rotateSpeed;
        g.yaw += dy; g.pitch += dp;
        const k = 1 - Math.exp(-dt / 0.06);
        this._vel.yaw += (dy / Math.max(dt, 1e-3) - this._vel.yaw) * k; this._vel.pitch += (dp / Math.max(dt, 1e-3) - this._vel.pitch) * k;
        this._idle = 0;
      } else if (inp.pointers.size === 0) { // momentum after release
        g.yaw += this._vel.yaw * dt; g.pitch += this._vel.pitch * dt;
        const decay = Math.exp(-dt / 0.9); this._vel.yaw *= decay; this._vel.pitch *= decay;
      } else { this._vel.yaw *= Math.exp(-dt / 0.1); this._vel.pitch *= Math.exp(-dt / 0.1); }

      if (inp.zoom) {
        const want = g.logD - inp.zoom * this.zoomSpeed;
        const lo = Math.log(this.minDistance), hi = Math.log(this.maxDistance);
        if (want < lo) { this._pressure += lo - want; if (this._pressure > 0.35 && this.onZoomInLimit) { this._pressure = 0; this.onZoomInLimit(); } }
        else if (want > hi) { this._pressure -= want - hi; if (this._pressure < -0.35 && this.onZoomOutLimit) { this._pressure = 0; this.onZoomOutLimit(); } }
        else this._pressure *= 0.5;
        g.logD = clamp(want, lo, hi); this._idle = 0;
      } else this._pressure *= Math.exp(-dt / 0.6);
      if (inp.twist) g.roll += inp.twist * 0.0; // twist reserved (roll feels disorienting in orbit views)
      if (this.panEnabled && (inp.pan.dx || inp.pan.dy)) {
        const s = this.distance * 0.0016;
        _right.setFromMatrixColumn(this.camera.matrixWorld, 0); _up.setFromMatrixColumn(this.camera.matrixWorld, 1);
        g.target.addScaledVector(_right, -inp.pan.dx * s).addScaledVector(_up, inp.pan.dy * s);
      }
    }
    // cinematic idle drift
    this._idle += dt;
    if (this.idleSpin && this._idle > this.idleDelay) {
      const k = clamp((this._idle - this.idleDelay) / 4); g.yaw += this.idleSpin * k * k * dt;
    }
    g.pitch = clamp(g.pitch, this.minPitch, this.maxPitch);
    this.yaw = damp(this.yaw, g.yaw, this.smooth, dt); this.pitch = damp(this.pitch, g.pitch, this.smooth, dt);
    this.roll = damp(this.roll, g.roll, this.smooth * 2, dt);
    this.distance = Math.exp(damp(Math.log(this.distance), g.logD, this.smooth * 1.6, dt));
    this.target.x = damp(this.target.x, g.target.x, this.smooth * 1.5, dt); this.target.y = damp(this.target.y, g.target.y, this.smooth * 1.5, dt); this.target.z = damp(this.target.z, g.target.z, this.smooth * 1.5, dt);
    this.apply(dt);
  }

  apply(dt = 0) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _v.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp).multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(_v);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    if (this.roll) { _q.setFromAxisAngle(_v.set(0, 0, 1), this.roll); this.camera.quaternion.multiply(_q); }
    if (this._shake > 1e-4) {
      const s = this._shake * 0.01; const t = performance.now() * 0.001;
      this.camera.rotateX(Math.sin(t * 61.3) * s); this.camera.rotateY(Math.sin(t * 47.9 + 1.3) * s);
      this._shake *= Math.exp(-dt / 0.35);
    }
    this.camera.updateMatrixWorld();
  }
}
