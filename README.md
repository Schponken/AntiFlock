# AntiFlock

A heavyweight combat robotics simulator that runs in the browser. Two robots,
250 pounds each, three minutes, one steel cage.

Everything is simulated rather than scripted: the robots are rigid bodies with
real mass, the drivetrain applies motor force at each wheel's contact patch, and
a spinner is a real rotor on a motorised joint. When a bar hits something, the
damage it does is computed from the kinetic energy the rotor actually gave up in
that collision — a measurement taken from the solver, not a lookup table.

```
npm install
npm run dev        # http://localhost:5173
```

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Drive (tank steering) |
| `Space` | Weapon throttle |
| `F` | Fire a flipper, hammer, lifter or crusher |
| `R` | Self-righting arm |
| `C` | Cycle camera: broadcast → chase → orbit |
| `P` | Pause |
| `M` | Mute |
| `Enter` | Skip the opening sequence |
| `Esc` | Back to the menu |
| `F3` | Debug overlay |

A gamepad works too: left stick to drive, right stick to steer, right trigger
for the weapon.

## The simulation

**Units are real.** Kilograms, metres, watts, joules, seconds. A heavyweight is
113.4 kg, the arena is a 48-foot square, gravity is 9.81 m/s², and a 30 kg bar
at 1400 rpm stores about 60 kJ with a tip speed of roughly 160 mph. The physics
steps at a fixed 240 Hz because a bar at that speed sweeps 35° in a 60 Hz frame,
which is far too coarse to resolve a hit against armour.

**Robots are wedges, not boxes.** The chassis is a convex hull whose front face
is cut back according to the frame's wedge value, and the collider uses the same
vertices the mesh does. Getting underneath the other robot is a geometric
property of the shape, not a scripted outcome.

**The drivetrain is a friction model.** Each wheel raycasts to the floor and,
when it finds it, applies longitudinal and lateral force at the contact patch,
limited by a friction circle. Applying the force at the patch rather than at the
centre of mass is what produces wheelies under power, weight transfer, and the
shove of a pushing match, all without any of those being written down anywhere.
Combat robots have no suspension, so the wheels are modelled as rigid.

**Weapons are real bodies.** Every weapon is a second rigid body on a revolute
joint. Spinners run the joint motor to a velocity target with the torque limit
falling off as speed rises, the way a real motor does — which is why a big bar
takes fifteen seconds to come up to speed and why it is worth choosing when to
commit. Flippers, hammers, lifters and crushers use the same joint with angular
limits and a position target. Because the rotor is a real body, its stored
energy, its gyroscopic resistance to turning, and the recoil it puts back into
its own robot all come out of the solver.

**Damage is energy, not hit points per second.** Armour is split into six zones,
so a robot can be opened up along one flank while its front stays intact. Once a
zone's plate is gone, hits there go into the frame at nearly twice the rate. A
glancing blow transfers very little — the angle term is squared, which is what
makes a wedge or a curved shell genuinely worth building. Plastics like UHMW
have poor hit points and excellent energy absorption, and they work, for the
same reason they work in real life.

**Match flow follows the rulebook.** Three minutes. A robot that stops moving
gets a ten count, which resets if it gets going again. If the clock runs out,
three judges each award eleven points across damage, aggression and control.

## Building a robot

The garage is a weight budget. Seven chassis, seven armour materials, six
drivetrains, four wheel types and ten weapons, and everything competes for the
same 250 pounds:

- Armour mass is plate area × thickness × density, so 5 mm of titanium and 5 mm
  of AR500 are very different propositions.
- A heavier robot is slower and accelerates worse, because above the traction
  crossover the motors are the limit and mass stops cancelling out.
- A bigger rotor stores more energy and takes longer to spin up.
- Frames that cannot mount a weapon say so, and say why.

Nothing is hidden: the panel shows the running total, the breakdown by
subsystem, and the derived speed, acceleration, push force, durability and
weapon energy — all computed by the same code the fight uses.

## The arena

A 48-foot steel box with polycarbonate walls, a roof (vertical spinners really
do reach it), two banks of retracting killsaws and four corner pulverisers.

Every texture in the game is generated procedurally on a canvas at runtime —
the diamond plate, the hazard chevrons, the scuffed polycarbonate, the crowd,
the robots' liveries and their painted-on names. Every sound is synthesised with
the Web Audio API: impacts are filtered noise bursts with a pitched body and a
ringing tail, motors are oscillators tracking the real rotor speed, and the
crowd is a noise bed that swells on cue. There are no asset files at all.

## The opening sequence

The start of a match is a scripted show, defined as a cue list in
`src/sim/match.ts` and driven by `src/audio/showSequence.ts`, so the lighting,
the audio and the on-screen graphics all read from one timeline:

the house lights drop and the crowd comes up → the spotlights sweep the cage →
each robot is introduced in turn with a lower-third and its specification → the
lights slam back up → the start light goes red → three, two, one → **activate**,
with the horn, the strobe, and the light going green.

Press `Enter` at any point to skip it.

## Layout

```
src/
  core/       maths and a deterministic RNG
  sim/        the simulation — parts, damage, judging, match flow, physics
  render/     Three.js: procedural textures, arena, robots, effects, lighting
  audio/      Web Audio synthesis, the announcer, the show director
  ui/         garage, HUD, menus
  input/      keyboard and gamepad
  ai/         the opponent driver
```

`src/sim` never imports from `src/render`, `src/audio` or `src/ui`. The
simulation is the source of truth and everything else reads from it, which is
what lets the whole thing be tested without a browser.

## Testing

```
npm run typecheck   # tsc, strict
npm test            # unit and headless physics tests
npm run test:e2e    # real Chromium, real WebGL
npm run verify      # typecheck + unit tests + production build
```

The unit tests cover the pure simulation: the parts maths, the damage model, the
judges, and the match state machine. On top of those, a set of integration tests
runs the actual Rapier solver headlessly to check the things that only show up
once bodies are moving — that robots settle on their wheels rather than sinking
through the floor, that the drivetrain produces thrust in the right direction,
that a bar reaches speed and loses it when it connects, that nothing escapes the
cage, and that a fight is reproducible from a seed.

The end-to-end tests boot the real game in Chromium, read pixels back off the
canvas to prove the arena is actually being drawn, and then play: drive the
robot, spin the weapon, watch the clock, force a knockout, check the result
card.

## Notes

The announcer uses the browser's speech synthesis where it is available. Where
it is not — some headless and locked-down environments — it falls back to a
short tonal phrase with the cadence of the line, and the caption is always shown
on screen either way.

The opening sequence, the arena hazards and the rules are modelled on the sport
as it is generally run. All names, voice lines, artwork, sounds and robots here
are original to this project.
