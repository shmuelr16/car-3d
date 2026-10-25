# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AVIR GT-S: a procedurally generated 3D sports car (every surface computed in code, no model files) plus a driving simulator with a free-roam city and a race track. Plain browser JavaScript on three.js r147, with no bundler, no package.json and no test suite. Everything lives in `car-3d/`. `car-3d/README.md` is the detailed design doc, written in Hebrew. Read it before you change the model, the city, the NPCs or the interiors: it explains many non-obvious fixes and why they were needed.

## Commands

All commands run from `car-3d/`:

- `python3 serve.py [port]`: local static server with caching off. The default address is http://localhost:8778/index.html. You can also open the HTML files directly with `file://`.
- `node build-standalone.mjs`: regenerates `standalone.html` and `drive-standalone.html`. Run it after any change to `car-model.js`, `index.html` or `drive.html`. Otherwise the single-file copies keep a stale inlined model.

There is no lint and no test runner. To verify a change, load the page and check the console. The pages expose debug handles for the console: `window.__CAR` (studio) and `window.__SIM`, `__NPC`, `__AUTO`, `__INT` (drive). Once `drive.html` finishes building, `window.__SIM.ready` is true.

## Architecture

- **`car-model.js`** is the only shared module. It is an IIFE that sets `window.AVIR` and requires the global `THREE` to load first. Its API: `build` (the car), `person` and `poseChain` (procedural humans with two-bone IK), `makeMaterials` and `studioEnv`, the `CAR`/`DOOR`/`LIGHTS`/`MAT` constants, `util` (geometry and texture helpers) and `surf` (body-surface sampling functions). The body is a loft: `section(u)` gives a cross-section along the car's length, and `bodySurf(u,v)` is the parametric surface. Doors, mirrors, trim and NPC cars all sample the same surface, so a change to the body propagates to them. `buildSurface` wraps v but not u, so the nose and tail need separate end caps (`capSurf`).
- **`index.html`** is the studio viewer: orbit camera, paint, lights, door and driver controls.
- **`drive.html`** (~3.9k lines, one inline script) is the simulator. It is organized as global state objects: `CITY` (grid size `CITY.N`; zones, signals, traffic and parks all derive from it), `SIG` (traffic lights), `NPC` (traffic, motorbikes, pedestrians), `AUTO` (pure-pursuit autopilot that drives through the normal physics inputs), `HOME` (the hand-built house), `INT` (building interiors, built on demand for the nearest building only), `S` (car physics state: bicycle model, fixed 120 Hz step), `MAN` (the driver on foot, entry/exit poses in car space), and `MODE` (`'city'`/`'track'`, toggled with `T`, with positions kept in `SAVED`).
- **Performance pattern:** city props, crowds and traffic are `InstancedMesh` pools. three.js draws every instance up to `count`, so the code culls by packing visible instances to the front and shortening `count` (`instancePack` `begin()`/`push()`/`end()`), not by scaling them to 0. NPCs rewrite their instance matrices every frame instead of using separate meshes. Keep new crowd or prop features on this pattern.
- **`vendor/three.min.js`** is a local copy of three.js, with a CDN fallback in each page. `build-standalone.mjs` replaces the exact `<script src="vendor/three.min.js">` + fallback `<script>` + `<script src="car-model.js">` sequence with inline copies. Keep that tag sequence unchanged in both pages, or the build will throw. The build also strips the `<!doctype>`/`<head>` wrapper (the form the Artifact publisher expects) and rewrites links between the pages.

## Conventions

- UI text is in Hebrew with RTL layout. Code comments are in English.
- The code style is dense ES5: `var`, short names, many statements per line. Match it.
- Do not edit `standalone.html` or `drive-standalone.html` by hand. They are generated.
