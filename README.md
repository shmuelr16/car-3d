# car-3d

**AVIR GT-S** is a detailed sports car model built entirely in code, plus a driving simulator that uses it. Every surface is computed procedurally on top of [three.js](https://threejs.org/) r147, with no external model files.

## What's inside

- **Studio** (`car-3d/index.html`): view the car, change paint and lights, switch cameras, open the doors and see the driver.
- **Driving sim** (`car-3d/drive.html`):
  - A free-roam city with traffic, motorbikes, pedestrians and traffic lights.
  - Buildings you can walk into, and your own house with a garage.
  - A closed race track with lap timing.
  - Physics, an autopilot (`G`), day and night, synthesized engine sound, and gamepad support.
  - The driver can open the door, get out, walk around and get back in (`F`).

## Run it

Open `car-3d/index.html` or `car-3d/drive.html` directly in a browser. Everything works offline because three.js is vendored.

Or start the local server:

```sh
cd car-3d
python3 serve.py        # http://localhost:8778/index.html
```

To share it, use `car-3d/standalone.html` and `car-3d/drive-standalone.html`. Each is a single self-contained file. After editing `car-model.js` (or either page), rebuild them:

```sh
node build-standalone.mjs
```

## Controls (driving)

`W`/`S` throttle and brake · `A`/`D` steer · `Space` handbrake · `G` autopilot · `F` exit/enter car · `T` city/track · `E` driving aids · `C` or `1`–`4` camera · `L` lights · `N` night · `M` sound · `R` reset · `Q` graphics quality · `H` help

See [`car-3d/README.md`](car-3d/README.md) for the full design notes (in Hebrew).
