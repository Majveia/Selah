// Unified input: mouse, keyboard, multi-touch and gamepad folded into one small per-frame state object.
//
// Two interpretation modes:
//   'orbit'      one finger / left-drag = rotate, two fingers = pinch-zoom + twist + pan, wheel = zoom, right-drag = pan
//   'character'  left side of the screen = floating move stick, the rest = look; mouse look via pointer-lock or drag;
//                WASD / arrows / gamepad sticks
//
// Read these every frame (all deltas are reset by endFrame()):
//   input.drag {dx,dy}   primary drag in CSS px           input.pan {dx,dy}   secondary drag in CSS px
//   input.zoom           + = zoom in (log units; one wheel notch ≈ 0.15, pinch = ln(scale))
//   input.twist          radians (two-finger rotate)
//   input.move {x,y}     -1..1 (x right, y forward)       input.look {x,y}    px-equivalent this frame
//   input.down(a) / input.pressed(a) / input.released(a)  for actions: jump sprint interact view vehicle photo menu map boost brake
//   input.on('tap' | 'doubletap' | 'longpress' | 'key' | 'modechange' | 'firstgesture', fn)
//   input.stick {active, ox, oy, x, y}   (the floating virtual stick; the HUD draws it only while active)
//   input.lastDevice 'mouse' | 'touch' | 'gamepad' | 'keyboard'

const ACTION_KEYS = {
  jump: ['Space'], sprint: ['ShiftLeft', 'ShiftRight'], interact: ['KeyE', 'KeyF', 'Enter'], view: ['KeyC', 'KeyV'],
  vehicle: ['KeyR'], photo: ['KeyP'], menu: ['Escape'], map: ['KeyM', 'Tab'], boost: ['ShiftLeft', 'ShiftRight'], brake: ['KeyX', 'ControlLeft'],
  zoomIn: ['Equal', 'NumpadAdd', 'PageUp'], zoomOut: ['Minus', 'NumpadSubtract', 'PageDown'], up: ['Space'], down: ['KeyQ', 'ControlLeft'],
};
const PAD_BUTTONS = { jump: 0, interact: 2, view: 3, vehicle: 1, sprint: 10, boost: 7, brake: 6, menu: 9, map: 8, zoomIn: 5, zoomOut: 4, photo: 11 };

export class Input {
  constructor(el) {
    this.el = el;
    this.mode = 'orbit';
    this.enabled = true;
    this.keys = new Set();
    this.pointers = new Map();
    this.drag = { dx: 0, dy: 0 }; this.pan = { dx: 0, dy: 0 };
    this.zoom = 0; this.twist = 0;
    this.move = { x: 0, y: 0 }; this.look = { x: 0, y: 0 };
    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, id: -1 };
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, inside: false };
    this.lastDevice = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
    this.locked = false;
    this.idleTime = 0; // seconds since the last user input (realms use it for cinematic idle drift)
    this._actions = new Map(); // name → held (from keyboard/gamepad/virtual buttons)
    this._virtual = new Set(); this._pressed = new Set(); this._released = new Set(); this._prevHeld = new Set();
    this._lookAccum = { x: 0, y: 0 };
    this._listeners = new Map();
    this._lastTap = { t: 0, x: 0, y: 0 };
    this._gestured = false;
    this._pinch = null;
    this._bind();
  }

  // ----- events ------------------------------------------------------------------------------------
  on(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, new Set()); this._listeners.get(type).add(fn); return () => this._listeners.get(type).delete(fn); }
  _emit(type, data) { const s = this._listeners.get(type); if (s) for (const fn of [...s]) fn(data); }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode; this.stick.active = false; this.stick.id = -1;
    for (const p of this.pointers.values()) p.role = 'none';
    if (mode !== 'character' && this.locked) document.exitPointerLock?.();
    this._emit('modechange', mode);
  }
  requestPointerLock() { if (this.lastDevice !== 'touch' && !this.locked) { try { const r = this.el.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } } }
  exitPointerLock() { if (this.locked) document.exitPointerLock?.(); }

  /** virtual (on-screen) buttons call this */
  setAction(name, held) { if (held) this._virtual.add(name); else this._virtual.delete(name); this._touchActivity('touch'); }
  down(name) { return this._actions.get(name) === true; }
  pressed(name) { return this._pressed.has(name); }
  released(name) { return this._released.has(name); }

  _touchActivity(device) {
    this.idleTime = 0;
    if (device && device !== this.lastDevice) { this.lastDevice = device; this._emit('device', device); }
    if (!this._gestured) { this._gestured = true; this._emit('firstgesture'); }
  }

  _ndc(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, nx: ((e.clientX - r.left) / r.width) * 2 - 1, ny: -(((e.clientY - r.top) / r.height) * 2 - 1), w: r.width, h: r.height };
  }

  _bind() {
    const el = this.el, opt = { passive: false };
    el.addEventListener('pointerdown', (e) => this._down(e), opt);
    window.addEventListener('pointermove', (e) => this._moveEv(e), opt);
    window.addEventListener('pointerup', (e) => this._up(e), opt);
    window.addEventListener('pointercancel', (e) => this._up(e, true), opt);
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return; e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      let d = -e.deltaY * unit;
      // trackpad pinch arrives as ctrl+wheel with small deltas; make it feel 1:1
      this.zoom += e.ctrlKey ? d * 0.012 : Math.sign(d) * Math.min(Math.abs(d), 240) * 0.0015;
      this._touchActivity('mouse');
    }, opt);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat) { this.keys.add(e.code); this._emit('key', e.code); }
      this._touchActivity('keyboard');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this._virtual.clear(); });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === this.el; this._emit('lock', this.locked); });
  }

  _down(e) {
    if (!this.enabled) return;
    const n = this._ndc(e);
    const p = { id: e.pointerId, type: e.pointerType, button: e.button, x: n.x, y: n.y, sx: n.x, sy: n.y, t: performance.now(), moved: 0, role: 'none', long: false };
    this.pointers.set(e.pointerId, p);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this._touchActivity(e.pointerType === 'touch' ? 'touch' : 'mouse');
    this.pointer.x = n.x; this.pointer.y = n.y; this.pointer.nx = n.nx; this.pointer.ny = n.ny;

    if (this.mode === 'character' && e.pointerType === 'touch') {
      if (!this.stick.active && n.x < n.w * 0.42 && n.y > n.h * 0.25) {
        p.role = 'stick'; Object.assign(this.stick, { active: true, ox: n.x, oy: n.y, x: 0, y: 0, id: e.pointerId });
      } else p.role = 'look';
    } else if (e.pointerType === 'mouse') {
      p.role = e.button === 2 || e.button === 1 ? 'pan' : (this.mode === 'character' ? 'look' : 'drag');
    } else {
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch');
      if (touches.length >= 2) { for (const q of touches) q.role = 'pinch'; this._pinch = null; }
      else p.role = 'drag';
    }
    // long-press detection (touch): used for "hold to skip", context actions
    p.timer = setTimeout(() => { if (this.pointers.has(p.id) && p.moved < 10) { p.long = true; this._emit('longpress', { x: p.x, y: p.y, nx: n.nx, ny: n.ny }); } }, 520);
  }

  _moveEv(e) {
    const n = this._ndc(e);
    if (e.pointerType === 'mouse') { this.pointer.x = n.x; this.pointer.y = n.y; this.pointer.nx = n.nx; this.pointer.ny = n.ny; this.pointer.inside = true; }
    if (!this.enabled) return;
    if (this.locked && e.pointerType === 'mouse') { this._lookAccum.x += e.movementX || 0; this._lookAccum.y += e.movementY || 0; this._touchActivity('mouse'); return; }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = n.x - p.x, dy = n.y - p.y;
    p.x = n.x; p.y = n.y; p.moved += Math.abs(dx) + Math.abs(dy);
    this._touchActivity(e.pointerType === 'touch' ? 'touch' : 'mouse');
    switch (p.role) {
      case 'drag': this.drag.dx += dx; this.drag.dy += dy; break;
      case 'pan': this.pan.dx += dx; this.pan.dy += dy; break;
      case 'look': this._lookAccum.x += dx * (p.type === 'touch' ? 1.6 : 1); this._lookAccum.y += dy * (p.type === 'touch' ? 1.6 : 1); break;
      case 'stick': {
        const R = 56; let sx = (n.x - this.stick.ox) / R, sy = (n.y - this.stick.oy) / R; const m = Math.hypot(sx, sy);
        if (m > 1) { // the stick origin follows the thumb so you never "run out" of stick
          this.stick.ox += (sx - sx / m) * R; this.stick.oy += (sy - sy / m) * R; sx /= m; sy /= m;
        }
        this.stick.x = sx; this.stick.y = -sy; break;
      }
      case 'pinch': {
        const t = [...this.pointers.values()].filter((q) => q.role === 'pinch');
        if (t.length >= 2) {
          const [a, b] = t; const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; const ang = Math.atan2(b.y - a.y, b.x - a.x);
          if (this._pinch) {
            this.zoom += Math.log(dist / this._pinch.dist) * 1.15;
            let da = ang - this._pinch.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
            this.twist += da; this.pan.dx += cx - this._pinch.cx; this.pan.dy += cy - this._pinch.cy;
          }
          this._pinch = { dist, ang, cx, cy };
        }
        break;
      }
    }
  }

  _up(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (p.role === 'stick') { this.stick.active = false; this.stick.x = 0; this.stick.y = 0; this.stick.id = -1; }
    if (p.role === 'pinch') {
      this._pinch = null;
      const rest = [...this.pointers.values()].filter((q) => q.role === 'pinch');
      if (rest.length === 1) rest[0].role = this.mode === 'character' ? 'look' : 'drag';
    }
    if (cancelled || !this.enabled) return;
    const now = performance.now();
    if (now - p.t < 300 && p.moved < 9 && !p.long && p.button !== 2) {
      const n = this._ndc(e); const tap = { x: n.x, y: n.y, nx: n.nx, ny: n.ny, type: p.type };
      const lt = this._lastTap;
      if (now - lt.t < 340 && Math.hypot(lt.x - n.x, lt.y - n.y) < 36) { this._emit('doubletap', tap); lt.t = 0; }
      else { this._emit('tap', tap); lt.t = now; lt.x = n.x; lt.y = n.y; }
    }
  }

  // ----- per-frame ------------------------------------------------------------------------------------
  update(dt) {
    this.idleTime += dt;
    // keyboard move
    const k = this.keys; let mx = 0, my = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    const km = Math.hypot(mx, my); if (km > 1) { mx /= km; my /= km; }
    if (this.stick.active) { mx = this.stick.x; my = this.stick.y; }
    let lx = this._lookAccum.x, ly = this._lookAccum.y; this._lookAccum.x = 0; this._lookAccum.y = 0;

    const held = new Set(this._virtual);
    for (const name in ACTION_KEYS) for (const code of ACTION_KEYS[name]) if (k.has(code)) held.add(name);

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dz = (v) => { const a = Math.abs(v); return a < 0.16 ? 0 : Math.sign(v) * ((a - 0.16) / 0.84); };
      const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0), rx = dz(pad.axes[2] || 0), ry = dz(pad.axes[3] || 0);
      if (ax || ay) { mx = ax; my = -ay; }
      if (rx || ry) { lx += rx * Math.abs(rx) * 1150 * dt; ly += ry * Math.abs(ry) * 800 * dt; }
      let any = !!(ax || ay || rx || ry);
      for (const name in PAD_BUTTONS) { const b = pad.buttons[PAD_BUTTONS[name]]; if (b && (b.pressed || b.value > 0.4)) { held.add(name); any = true; } }
      if (this.mode === 'orbit') { // sticks drive the orbit camera too
        this.drag.dx += rx * 520 * dt; this.drag.dy += ry * 380 * dt;
        const zin = pad.buttons[7]?.value || 0, zout = pad.buttons[6]?.value || 0; this.zoom += (zin - zout) * 1.4 * dt;
        if (zin || zout) any = true;
      }
      if (any) this._touchActivity('gamepad');
      break;
    }
    if (this.mode === 'orbit') { // keyboard orbit / zoom for accessibility
      this.drag.dx += -mx * 420 * dt * (this.stick.active ? 0 : 1); this.drag.dy += my * 300 * dt * (this.stick.active ? 0 : 1);
      if (held.has('zoomIn')) this.zoom += 1.6 * dt; if (held.has('zoomOut')) this.zoom -= 1.6 * dt;
    }
    this.move.x = mx; this.move.y = my; this.look.x = lx; this.look.y = ly;

    this._pressed.clear(); this._released.clear();
    for (const a of held) if (!this._prevHeld.has(a)) this._pressed.add(a);
    for (const a of this._prevHeld) if (!held.has(a)) this._released.add(a);
    this._actions.clear(); for (const a of held) this._actions.set(a, true);
    this._prevHeld = held;
    if (held.size || mx || my) this.idleTime = 0;
  }

  endFrame() {
    this.drag.dx = this.drag.dy = 0; this.pan.dx = this.pan.dy = 0; this.zoom = 0; this.twist = 0;
  }
}
