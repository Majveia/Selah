// A Realm is one scale of the universe (cosmic web, galaxy, star system, black hole, planet orbit, surface…).
// The App owns the renderer, post pipeline, input, audio and HUD; realms own a scene, a camera and their own logic.
//
// LIFECYCLE
//   constructor(app)            cheap; no GPU work
//   await init()                build everything (called once, may be awaited behind a transition)
//   enter(params, fromRealm)    becomes active (params: { seed, ... } — whatever the caller passed to app.travel)
//   update(dt, time)            every frame while active or while part of a transition
//   exit(toRealm)               stops being active (keep resources; realms are reused)
//   resize(viewport)            viewport = { width, height, cssWidth, cssHeight, pixelRatio, aspect } (width/height in render px)
//   dispose()
//
// RENDERING
//   Default: the post pipeline clears its HDR target and draws `this.scene` with `this.camera`.
//   Custom:  define render(renderer, target, post, dt) and draw into `target` yourself (ray-marchers, GPU sims…).
//   Output is scene-referred linear HDR: 1.0 ≈ white, values above `post.bloomThreshold` bloom. Empty space must be 0.
//   `this.post` holds per-realm overrides of POST_DEFAULTS (see core/post.js); the app cross-fades them in transitions.
//
// INPUT
//   `this.inputMode` = 'orbit' | 'character' is applied when the realm becomes active. Read `this.app.input`.
//
// HUD
//   describe() → { title, subtitle, scale } shown by the minimal HUD (e.g. { title: 'Cosmic Web', scale: '300 Mpc' }).
//   hints()    → optional array of { keys, touch, text } control hints.

import * as THREE from 'three';

export class Realm {
  constructor(app) {
    this.app = app;
    this.name = 'realm';
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.post = {};
    this.inputMode = 'orbit';
    this.active = false;
  }
  async init() {}
  enter(/* params, from */) {}
  exit(/* to */) {}
  update(/* dt, time */) {}
  resize(vp) { this.camera.aspect = vp.aspect; this.camera.updateProjectionMatrix(); }
  describe() { return { title: this.name, subtitle: '', scale: '' }; }
  dispose() {}
}
