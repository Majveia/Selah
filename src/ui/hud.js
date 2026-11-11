// Minimal HUD. Everything is tiny, low-contrast and disappears during cinematics / photo mode.
// The DOM lives in #hud; styles in style.css.

const ICON = {
  sound: '<path d="M4 10v4h3l4 3.2V6.8L7 10H4z"/><path d="M15 9.4a3.6 3.6 0 0 1 0 5.2M17.6 7a7 7 0 0 1 0 10"/>',
  mute: '<path d="M4 10v4h3l4 3.2V6.8L7 10H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  more: '<circle cx="6" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="18" cy="12" r=".9"/>',
  photo: '<path d="M4 8h3.2l1.6-2h6.4l1.6 2H20v11H4z"/><circle cx="12" cy="13.2" r="3.2"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  jump: '<path d="M6 13l6-6 6 6M12 7v11"/>',
  act: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" opacity=".5"/>',
  ride: '<path d="M3 14h4l3-4h5l5 4h1M7 14a2 2 0 1 0 4 0M15 14a2 2 0 1 0 4 0"/>',
  eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.4"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export class HUD {
  constructor(app) {
    this.app = app;
    const root = (this.root = document.getElementById('hud'));
    root.innerHTML = '';
    const add = (e) => (root.appendChild(e), e);

    this.barT = add(el('div', 'bar t')); this.barB = add(el('div', 'bar b'));
    this.loc = add(el('div', 'loc chrome', '<div class="crumbs"></div><div class="sub"></div>'));
    this.crumbs = this.loc.querySelector('.crumbs'); this.sub = this.loc.querySelector('.sub');
    this.scale = add(el('div', 'scale chrome'));
    this.tools = add(el('div', 'tools chrome'));
    this.tag = add(el('div', 'tag chrome'));
    this.timebar = add(el('div', 'timebar chrome', '<div class="lbl"><span></span><b></b></div><div class="trk"><div class="fil"></div><div class="knb"></div></div>'));
    this.captionEl = add(el('div', 'caption'));
    this.hintEl = add(el('div', 'hint chrome'));
    this.toastEl = add(el('div', 'toast chrome'));
    this.stick = add(el('div', 'stick', '<i></i>'));
    this.actions = add(el('div', 'actions chrome'));
    this.sheet = add(el('div', 'sheet chrome'));
    this.titleEl = add(el('div', 'title', `<div class="wrap">
      <svg viewBox="-10 -10 470 120" role="img" aria-label="Selah">
        <path pathLength="1" d="M68 16C52 2 14 4 14 28c0 26 58 18 58 46 0 24-42 26-62 10"/>
        <path pathLength="1" d="M158 4h-42v92h42M116 50h34"/>
        <path pathLength="1" d="M206 4v92h42"/>
        <path pathLength="1" d="M284 96l34-92 34 92"/>
        <path pathLength="1" d="M392 4v92M392 50h50M442 4v92"/>
      </svg><div class="tagline">pause — and behold</div></div>`));
    this.skip = add(el('div', 'skip', 'hold to skip'));
    this.gateEl = add(el('div', 'gate', `<div class="in"><div class="dot"></div><div class="word">Selah</div>
      <div class="prog"><i></i></div><div class="go">enter</div><div class="note">sound on · headphones recommended</div></div>`));

    // tools
    this.btnSound = this._tool('sound', 'Sound', () => this.app.emit('ui:sound'));
    this._tool('photo', 'Hide interface (P)', () => this.togglePhoto());
    this._tool('full', 'Fullscreen', () => this.toggleFullscreen());
    this._tool('more', 'Settings', () => this.sheet.classList.toggle('on'));
    this._buildSheet(); this._buildActions(); this._bindTimebar();

    document.body.classList.toggle('touch', app.input.lastDevice === 'touch');
    app.input.on('device', (d) => document.body.classList.toggle('touch', d === 'touch'));
    app.input.on('modechange', (m) => document.body.classList.toggle('character', m === 'character'));
    app.input.on('key', (code) => { if (code === 'KeyP') this.togglePhoto(); if (code === 'KeyH') this.showControls(); });
    app.input.on('tap', () => { this.sheet.classList.remove('on'); if (document.body.classList.contains('photo')) this.togglePhoto(false); });
    app.on('realm', () => { this._crumbKey = ''; this.showControls(7); });
    app.addUpdater((dt) => this.update(dt));
    this._captionTimer = 0; this._hintTimer = 0; this._crumbKey = ''; this._tagOn = false; this._last = {};
  }

  _tool(icon, label, fn) {
    const b = el('button', '', svg(icon)); b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
    this.tools.appendChild(b); return b;
  }

  _buildSheet() {
    const q = this.app.quality.tier, s = this.sheet;
    s.innerHTML = `<h4>Detail</h4><div class="row" data-k="q">${['low', 'mid', 'high', 'ultra'].map((t) => `<button data-v="${t}" class="${t === q ? 'sel' : ''}">${t}</button>`).join('')}</div>
      <h4>Narrator</h4><div class="row" data-k="voice"></div>
      <h4>Journey</h4><div class="row" data-k="go"><button data-v="intro">Replay intro</button><button data-v="home">Home world</button></div>
      <p class="help"></p>`;
    s.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return; e.stopPropagation();
      const k = b.parentElement.dataset.k, v = b.dataset.v;
      if (k === 'q') { const u = new URL(location.href); u.searchParams.set('q', v); location.href = u.toString(); }
      else if (k === 'voice') { this.app.emit('ui:voice', v); [...b.parentElement.children].forEach((c) => c.classList.toggle('sel', c === b)); }
      else if (k === 'go') { this.sheet.classList.remove('on'); this.app.emit('ui:' + v); }
    });
    s.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.setVoices(['off'], 'off');
  }
  setVoices(names, current) {
    const row = this.sheet.querySelector('[data-k="voice"]');
    row.innerHTML = names.map((n) => `<button data-v="${n}" class="${n === current ? 'sel' : ''}">${n}</button>`).join('');
  }

  _buildActions() {
    const defs = [['view', 'eye'], ['vehicle', 'ride'], ['interact', 'act'], ['jump', 'jump']];
    for (const [action, icon] of defs) {
      const b = el('button', '', svg(icon)); b.dataset.a = action; b.setAttribute('aria-label', action);
      const set = (on) => (e) => { e.preventDefault(); e.stopPropagation(); b.classList.toggle('dn', on); this.app.input.setAction(action, on); };
      b.addEventListener('pointerdown', set(true)); b.addEventListener('pointerup', set(false)); b.addEventListener('pointercancel', set(false)); b.addEventListener('pointerleave', set(false));
      this.actions.appendChild(b);
    }
  }

  _bindTimebar() {
    const tb = this.timebar; let dragging = false;
    const at = (e) => { const r = tb.querySelector('.trk').getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    tb.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragging = true; tb.setPointerCapture(e.pointerId); this._tc?.set(at(e)); });
    tb.addEventListener('pointermove', (e) => { if (dragging) this._tc?.set(at(e)); });
    const end = () => { dragging = false; };
    tb.addEventListener('pointerup', end); tb.addEventListener('pointercancel', end);
  }

  // ----- public API ---------------------------------------------------------------------------------
  setCinema(on) { document.body.classList.toggle('cinema', !!on); }
  setSkipVisible(on) { this.skip.classList.toggle('on', !!on); }
  togglePhoto(on) { document.body.classList.toggle('photo', on); if (document.body.classList.contains('photo')) this.toast('tap to bring the interface back'); }
  toggleFullscreen() {
    const d = document; if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else { const r = d.documentElement; (r.requestFullscreen || r.webkitRequestFullscreen)?.call(r)?.catch?.(() => {}); }
  }
  setSound(on) { this.btnSound.innerHTML = svg(on ? 'sound' : 'mute'); this.btnSound.classList.toggle('off', !on); }
  setProgress(p) { this.gateEl.querySelector('.prog i').style.width = `${Math.round(p * 100)}%`; }

  /** Show the entry gate; resolves when the visitor clicks/taps/presses a key (a user gesture — needed for audio). */
  gate(readyPromise) {
    document.body.classList.add('gated');
    return new Promise((resolve) => {
      let ready = false;
      Promise.resolve(readyPromise).then(() => { ready = true; this.setProgress(1); this.gateEl.classList.add('ready'); });
      const go = (e) => {
        if (!ready) return; if (e.type === 'keydown' && !['Enter', 'Space'].includes(e.code)) return;
        e.preventDefault?.(); e.stopPropagation?.();
        this.gateEl.removeEventListener('pointerup', go); window.removeEventListener('keydown', go);
        this.gateEl.classList.add('off'); document.body.classList.remove('gated');
        setTimeout(() => (this.gateEl.style.display = 'none'), 2800);
        resolve();
      };
      this.gateEl.addEventListener('pointerup', go); window.addEventListener('keydown', go);
    });
  }
  hideGate() { this.gateEl.classList.add('off'); this.gateEl.style.display = 'none'; document.body.classList.remove('gated'); }

  caption(text, seconds = 0) {
    if (!text) { this.captionEl.classList.remove('on'); return; }
    this.captionEl.textContent = text; this.captionEl.classList.add('on');
    this._captionTimer = seconds > 0 ? seconds : 0;
  }
  hint(html, seconds = 6) { this.hintEl.innerHTML = html; this.hintEl.classList.add('on'); this._hintTimer = seconds; }
  toast(text, seconds = 3) { this.toastEl.textContent = text; this.toastEl.classList.add('on'); clearTimeout(this._tt); this._tt = setTimeout(() => this.toastEl.classList.remove('on'), seconds * 1000); }
  showTitle(on) { this.titleEl.classList.toggle('on', !!on); }
  /** floating label at CSS px (x,y) */
  setTag(x, y, title, sub = '') {
    if (title == null) { if (this._tagOn) { this.tag.classList.remove('on'); this._tagOn = false; } return; }
    const html = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    if (this._last.tag !== html) { this.tag.innerHTML = html; this._last.tag = html; }
    this.tag.style.left = `${x}px`; this.tag.style.top = `${y}px`;
    if (!this._tagOn) { this.tag.classList.add('on'); this._tagOn = true; }
  }

  showControls(seconds = 8) {
    const r = this.app.active; if (!r || document.body.classList.contains('cinema')) return;
    const touch = this.app.input.lastDevice === 'touch';
    const h = r.hints ? r.hints(touch) : (touch ? 'drag to look · pinch to zoom · double-tap to travel' : 'drag to look · scroll to zoom · double-click to travel');
    if (h) this.hint(h, seconds);
    this.sheet.querySelector('.help').innerHTML = h || '';
  }

  update(dt) {
    const app = this.app, r = app.active;
    if (this._captionTimer > 0 && (this._captionTimer -= dt) <= 0) this.captionEl.classList.remove('on');
    if (this._hintTimer > 0 && (this._hintTimer -= dt) <= 0) this.hintEl.classList.remove('on');
    if (!r) return;
    const d = r.describe ? r.describe() : { title: r.name };
    const top = app.path[app.path.length - 1]; if (top && d.title) top.label = d.title;
    const key = app.path.map((p) => p.label || p.name).join('/');
    if (key !== this._crumbKey) {
      this._crumbKey = key; this.crumbs.innerHTML = '';
      app.path.forEach((p, i) => {
        if (i) this.crumbs.appendChild(el('i', '', '/'));
        const s = el('span', i === app.path.length - 1 ? 'here' : '', p.label || p.name);
        if (i < app.path.length - 1) s.addEventListener('click', (e) => { e.stopPropagation(); this.goTo(i); });
        this.crumbs.appendChild(s);
      });
    }
    if (this._last.sub !== d.subtitle) { this.sub.textContent = d.subtitle || ''; this._last.sub = d.subtitle; }
    if (this._last.scale !== d.scale) { this.scale.textContent = d.scale || ''; this.scale.style.opacity = d.scale ? 1 : 0; this._last.scale = d.scale; }
    // virtual stick
    const st = app.input.stick;
    if (st.active) {
      this.stick.classList.add('on'); this.stick.style.left = `${st.ox}px`; this.stick.style.top = `${st.oy}px`;
      this.stick.firstChild.style.transform = `translate(${st.x * 38}px, ${-st.y * 38}px)`;
    } else this.stick.classList.remove('on');
    // time control
    const tc = r.timeControl || null; this._tc = tc;
    this.timebar.classList.toggle('on', !!tc);
    if (tc) {
      const v = tc.get(); const lbl = tc.label();
      if (this._last.tv !== v || this._last.tl !== lbl) {
        this._last.tv = v; this._last.tl = lbl;
        this.timebar.querySelector('.fil').style.width = `${v * 100}%`; this.timebar.querySelector('.knb').style.left = `${v * 100}%`;
        this.timebar.querySelector('.lbl span').textContent = tc.name || 'time'; this.timebar.querySelector('.lbl b').textContent = lbl;
      }
    }
  }

  goTo(i) {
    const app = this.app; if (app.travelling || i >= app.path.length - 1) return;
    const entry = app.path[i]; app.path.length = i + 1;
    app.travel(entry.name, { ...entry.params, returning: true }, { type: 'rise', push: false });
  }
}
