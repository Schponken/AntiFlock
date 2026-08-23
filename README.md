# ANTIFLOCK

A 3D robot-combat simulator in the browser. Build a 250 lb machine out of real
parts, then fight it in a steel box with working hazards, a live physics
simulation, and a fight-night show open.

Nothing here is faked with hidden "power levels", and nothing is downloaded at
runtime. Every texture, every sound and every piece of music is generated in the
browser from code.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

---

## What makes it a simulation rather than a game with numbers

The parts catalogue stores genuine physical quantities — kilograms per cubic
metre, newton-metres, RPM, joules — and one function (`computeStats`) turns a
design into mass, inertia, top speed and stored energy. The builder screen and
the physics rig both read that same function, so the panel cannot lie to you: if
it says the disc holds 36 kJ and the machine weighs 249 lb, that is exactly what
walks into the arena.

**Weapons are rigid bodies, not animations.** A spinner is a real body on a
motorised revolute joint. Its angular momentum, the gyroscopic lean it puts into
every turn, the way a big bite stalls it and throws both machines apart — none of
that is scripted. It falls out of the solver.

**Damage is measured in joules, and the joules are conserved.** A hit computes
the energy available from the rotor's real inertia and tip speed, works out how
much of it couples into the target (slippery ductile armour sheds a glancing
weapon; hard brittle armour has nowhere to put it), subtracts that from the
target's structure and takes the same amount back out of the rotor. One number,
two consequences.

**Losing parts changes how the machine drives.** A destroyed wheel loses its
engine force and its grip, so a damaged bot genuinely limps in a circle. Armour
panels detach into physical debris that then gets in everyone's way.

### Two engine constraints worth knowing about

Both of these were found by testing, and both shaped the design:

- **Rapier clamps angular velocity to a quarter turn per step.** At 240 Hz that
  ceiling is 188 rad/s — slower than any real heavyweight spinner, which would
  have quietly capped every weapon in the game at half speed. The simulation runs
  at **480 Hz**, raising the ceiling to 377 rad/s, and `MAX_SIMULABLE_OMEGA` is
  enforced in code so no weapon can be specced past it.
- **Rapier's raycast vehicle applies drive force at the centre of mass**, which
  throws away the moment arm. Differential thrust therefore produces no yaw at
  all: two wheels forward and two back cancel to nothing, and a bot that has lost
  the wheels down one side tracks perfectly straight. `applyDifferentialYaw()`
  adds back exactly the couple the solver dropped, built from the wheels' own
  traction-limited impulses so it can never exceed what the floor can supply.

---

## The show open

`src/game/startSequence.ts` is a cue list, so lighting, audio, camera and
announcer stay locked to each other regardless of frame rate:

blackout and a rising drone → searchlights sweeping a dark box → red corner
introduced under a spotlight → blue corner → "Drivers, are you ready?" →
"It's robot fighting time!" with the strobe → the arena lights **slam** on
together with a contactor thump and a bloom flare → `3 · 2 · 1` →
**ACTIVATE**, klaxon, music.

Any key skips it, and there is a permanent setting for people who have seen it.

---

## Controls

| | |
|---|---|
| `W` `A` `S` `D` / arrows | Tank drive |
| `Shift` | Weapon (hold to spin up) |
| `Space` | Fire flipper / hammer |
| `R` | Self-right |
| `C` | Broadcast ↔ chase camera |

A gamepad works too: left stick drives, right stick steers, triggers for
throttle, bumper for the weapon.

---

## Building a machine

Six frames, eight armour materials, four motors, four wheel types, ten weapons,
seven accessories, plus paint, finish, decals and underglow — all inside a
**113.4 kg (250 lb)** limit that is checked before you are allowed to fight.

The interesting decisions are the real ones. Titanium is tougher per kilo than
AR500 but costs a fortune. A thicker disc stores more energy and takes longer to
wind up. Dropping the gear ratio buys acceleration and loses top speed. A metre
of horizontal bar has enormous reach and makes the machine fight your steering.
UHMW is nearly untearable and lets weapons skate off it — but it is slippery, so
you cannot push anybody.

---

## The arena

A 48-foot square steel floor inside scuffed polycarbonate, with killsaws that
come up through slots in the floor, corner pulverisers, and the screws down each
side. Hazards are kinematic bodies, so they shove machines around with real
contact velocities.

A fight ends by knockout (counted out after ten seconds of no movement, thrown
out of the box, or structurally destroyed) or on the judges' cards, scored 5-3-3
across damage, aggression and control.

---

## Layout

```
src/
  core/        maths, seeded RNG, typed events, cue-list timeline
  physics/     Rapier world, fixed timestep, collision layers
  game/        parts catalogue, design maths, bot rig, damage,
               arena, hazards, debris, AI, match flow, show open
  render/      procedural textures, bot meshes, lighting rig,
               particles, cameras, renderer + bloom
  audio/       synthesised engine, announcer
  ui/          builder, HUD, DOM helpers
tests/         unit + headless physics (vitest)
e2e/           real-browser smoke tests (playwright)
```

## Tests

```bash
npm test           # 54 unit + headless-physics tests
npm run test:e2e   # boots the real build in Chromium
npm run typecheck
npm run build
```

The unit suite runs the actual physics engine headlessly, so it covers things a
DOM test cannot: that every stock build is legal and stable, that each rotor
shape's inertia in the solver matches the catalogue to three decimal places, that
a bot with two wheels torn off veers instead of tracking straight, that a
spun-up spinner really damages an opponent, and that a machine never damages
itself with its own weapon.

The Playwright suite drives the real build in a real browser — WebGL, procedural
texture generation, the Rapier WASM module, the show open and a live fight — and
fails on any unexpected console error.

## Performance

Simulation is fixed-step at 480 Hz and decoupled from rendering. Quality
(pixel ratio, shadows, bloom) adapts downward if frames are being missed, because
a physics game that runs slowly is a worse game than one that renders softly. The
presentation clock runs on wall time so a three-minute round is three minutes
whatever the frame rate.
