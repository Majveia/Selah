# Selah

*Pause — and behold.* An interactive, simulated universe in Three.js. No build step.

```
node tools/serve.mjs        # → http://localhost:8080/
```

Any static file server works (the page is `index.html`; it needs WebGL 2).

## What is in it

| Scale | What you see | What is simulated |
| --- | --- | --- |
| **Opening film** | Silence → first light → expansion and cooling → the web forms → into a galaxy → sunrise over a world → title | One continuous shot through the real, interactive realms, with narration, captions and a generative score |
| **Cosmic web** | Millions of mass tracers, galaxies that resolve as you approach, a cosmic-time slider | ΛCDM Gaussian random field (BBKS transfer function) → Zel'dovich flow driven by the linear growth factor; colour from the exact caustic density |
| **Galaxy** | A spiral with dust lanes, star-forming knots and a golden bulge | Differential rotation with a flat rotation curve; arms are a density wave the stars pass through |
| **Black hole** | Shadow, photon ring, the far side of the disk arching overhead, a lensed sky | Per-pixel null geodesics in Schwarzschild spacetime; Keplerian disk with Doppler beaming and gravitational redshift |
| **Star system** | A sun, its worlds, moons, rings and an asteroid belt | Seeded systems: mass–luminosity–temperature relations, Kepler periods, habitable zones |
| **Orbit** | Continents, oceans with sun glint, clouds and their shadows, city lights at night, atmosphere | Procedural worlds by kind (garden, ocean, desert, ice, molten, giants) |
| **Surface** | Walk, glide and ride a hover-skiff through meadows, mountains and towns under a turning sky | Streaming seeded terrain, day/night light, settlements, third- and first-person cameras |

## Controls

- **Cosmic realms** — drag to turn, scroll / pinch to fly, double-click / double-tap to travel, scroll out to go up a scale.
- **Surface** — WASD + mouse (click to capture), Space to jump and hold to glide, Shift to run, **R** for the skiff
  (hold Space to climb — keep climbing to return to orbit), **C** first/third person, **M** to leave.
  Touch: left thumb moves, right thumb looks, four small buttons act. Gamepads work.
- **P** hides the interface. Settings (⋯) switch detail level and narrator, and replay the intro.

## Development

- `?realm=web|galaxy|blackhole|system|orbit|surface` opens one realm directly; `?q=low|mid|high|ultra` sets detail;
  `?freeze=SECONDS` fast-forwards deterministically and stops (used by `tools/shot.cjs` for screenshots).
- `tools/shot.cjs` — headless screenshots. `tools/audio/render.cjs` — offline render of the score with level checks.
- `tools/voice/` — regenerates the narration with an offline neural voice (Mimic 3) from `tools/voice/script.json`.

Everything is procedural: there are no textures or models, and the only binary assets are the narration clips.
