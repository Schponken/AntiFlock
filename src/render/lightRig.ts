/**
 * The lighting rig above the box.
 *
 * This is written as a real rig rather than "some lights": four overhead banks
 * that slam on together through a contactor, a pair of coloured searchlights on
 * yokes that sweep the crowd during the introductions, wall washes in each
 * team's colour, and a strobe. The start sequence drives it like a lighting desk.
 */

import * as THREE from 'three';
import { ARENA_HALF, WALL_HEIGHT } from '../game/arena.ts';
import { clamp01, damp } from '../core/mathx.ts';
import { getRenderProfile, onRenderProfileChange, type RenderProfile } from './profile.ts';
import { prefersReducedMotion } from '../core/motion.ts';
import { makeLampGrid } from './textures.ts';

interface Searchlight {
  light: THREE.SpotLight;
  beam: THREE.Mesh;
  /** Phase offset so the two lights never sweep in lockstep. */
  phase: number;
  speed: number;
}

export class LightRig {
  readonly group = new THREE.Group();

  private hemisphere: THREE.HemisphereLight;
  private houseLights: THREE.PointLight[] = [];
  private arenaBanks: THREE.SpotLight[] = [];
  private bankPanels: THREE.Mesh[] = [];
  private searchlights: Searchlight[] = [];
  private wallWashes: THREE.PointLight[] = [];
  /** One decaying flare value per wash, so a single corner can be lit alone. */
  private washPulses: number[] = [];
  private strobeLight: THREE.PointLight;
  private impactFlash: THREE.PointLight;

  private houseTarget = 0;
  private houseLevel = 0;
  private arenaTarget = 0;
  private arenaLevel = 0;
  private sweeping = false;
  private sweepLevel = 0;
  private strobeUntil = 0;
  private strobeStrength = 0;
  private elapsed = 0;

  private headless: boolean;
  /** Torn down in `dispose`, or a finished rig keeps taking profile changes. */
  private unsubscribeProfile: (() => void) | null = null;

  constructor(options: { headless?: boolean } = {}) {
    this.headless = options.headless ?? false;
    this.group.name = 'light-rig';
    const profile = getRenderProfile();
    let shadowCastersLeft = profile.shadows ? profile.shadowCasters : 0;

    // Fill so nothing is ever pure black; the box has a lot of bounced light.
    this.hemisphere = new THREE.HemisphereLight(0x9fb4d0, 0x201a16, 0);
    this.group.add(this.hemisphere);

    // --- Four overhead banks -----------------------------------------------
    /*
     * A grid of lamp cells behind a diffuser, rather than a white slab. These are
     * the one light source the player looks straight at.
     *
     * The map is the only thing in this rig that needs a 2D canvas, so it is the
     * only thing a headless match has to skip — the lights themselves are pure
     * maths and the fight's behaviour depends on them.
     */
    const bankMaterial = new THREE.MeshStandardMaterial({
      color: 0x0d0f12,
      emissive: 0xfff4e0,
      emissiveMap: this.headless ? null : makeLampGrid(),
      emissiveIntensity: 0,
      roughness: 0.4,
      metalness: 0.6,
    });

    const offsets: [number, number][] = [
      [-ARENA_HALF * 0.5, -ARENA_HALF * 0.5],
      [ARENA_HALF * 0.5, -ARENA_HALF * 0.5],
      [-ARENA_HALF * 0.5, ARENA_HALF * 0.5],
      [ARENA_HALF * 0.5, ARENA_HALF * 0.5],
    ];

    for (const [x, z] of offsets) {
      const spot = new THREE.SpotLight(0xfff2df, 0, 34, Math.PI / 3.4, 0.45, 1.4);
      spot.position.set(x, 8.6, z);
      spot.target.position.set(x * 0.35, 0, z * 0.35);
      // Each shadow-casting light is a full extra render pass, so only as many as
      // the profile allows actually cast; the rest still light the scene.
      spot.shadow.camera.near = 1;
      spot.shadow.camera.far = 24;
      spot.shadow.bias = -0.0012;
      spot.shadow.normalBias = 0.02;
      if (shadowCastersLeft > 0) {
        shadowCastersLeft--;
        spot.castShadow = true;
        spot.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
      }
      this.group.add(spot);
      this.group.add(spot.target);
      this.arenaBanks.push(spot);

      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.16, 1.5),
        bankMaterial.clone(),
      );
      panel.position.set(x, 8.75, z);
      this.group.add(panel);
      this.bankPanels.push(panel);

      // A soft point light per bank fills the corners the spot cones miss.
      const fill = new THREE.PointLight(0xffeedd, 0, 22, 2);
      fill.position.set(x, 6.4, z);
      this.group.add(fill);
      this.houseLights.push(fill);
    }

    /*
     * Follow the profile down mid-match.
     *
     * Each shadow-casting bank is a full extra render pass, and the adaptive path
     * exists to shed exactly that — but the casters were fixed at construction, so
     * a machine that dropped from high to low kept paying for four shadow passes
     * for the rest of the fight and only shed pixel ratio and bloom. Reapplying
     * here is cheap: `castShadow` and the map size are the whole cost.
     */
    const applyBanks = (next: RenderProfile): void => {
      let left = next.shadows ? next.shadowCasters : 0;
      for (const bank of this.arenaBanks) {
        const casting = left > 0;
        if (casting) left--;
        if (bank.castShadow !== casting) {
          bank.castShadow = casting;
          // Three keeps the render target alive on a light that has stopped
          // casting; releasing it is the point of turning the caster off.
          if (!casting) {
            bank.shadow.map?.dispose();
            bank.shadow.map = null;
          }
        }
        if (casting && bank.shadow.mapSize.x !== next.shadowMapSize) {
          bank.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
          bank.shadow.map?.dispose();
          bank.shadow.map = null;
        }
      }
    };
    this.unsubscribeProfile = onRenderProfileChange(applyBanks);

    // --- Searchlights on yokes ---------------------------------------------
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (const [index, color] of [0xff2b2b, 0x2b6bff].entries()) {
      const sign = index === 0 ? -1 : 1;
      const spot = new THREE.SpotLight(color, 0, 40, 0.16, 0.35, 1.1);
      spot.position.set(sign * (ARENA_HALF - 1.6), 8.2, sign * (ARENA_HALF - 1.6));
      spot.target.position.set(0, 0, 0);
      this.group.add(spot);
      this.group.add(spot.target);

      // A visible cone so the beam reads in the air, not just on the floor.
      const beam = new THREE.Mesh(new THREE.ConeGeometry(1.5, 16, 20, 1, true), beamMaterial.clone());
      (beam.material as THREE.MeshBasicMaterial).color.setHex(color);
      beam.position.copy(spot.position);
      this.group.add(beam);

      this.searchlights.push({
        light: spot,
        beam,
        phase: index * Math.PI * 0.65,
        speed: 0.55 + index * 0.14,
      });
    }

    // --- Team wall washes ---------------------------------------------------
    for (const [index, color] of [0xff2b2b, 0x2b6bff].entries()) {
      const sign = index === 0 ? -1 : 1;
      const wash = new THREE.PointLight(color, 0, 16, 2);
      wash.position.set(0, WALL_HEIGHT + 0.9, sign * (ARENA_HALF - 0.6));
      this.group.add(wash);
      this.wallWashes.push(wash);
      this.washPulses.push(0);
    }

    this.strobeLight = new THREE.PointLight(0xffffff, 0, 40, 1.6);
    this.strobeLight.position.set(0, 6.5, 0);
    this.group.add(this.strobeLight);

    this.impactFlash = new THREE.PointLight(0xffb060, 0, 9, 2);
    this.impactFlash.visible = false;
    this.group.add(this.impactFlash);
  }

  // -------------------------------------------------------------------------
  // Desk controls
  // -------------------------------------------------------------------------

  /** Ambient room light — the "house" that goes down before the introductions. */
  setHouse(level: number, immediate = false): void {
    this.houseTarget = clamp01(level);
    if (immediate) this.houseLevel = this.houseTarget;
  }

  /** The fight lights. Slamming these on is the moment the show starts. */
  setArena(level: number, immediate = false): void {
    this.arenaTarget = clamp01(level);
    if (immediate) this.arenaLevel = this.arenaTarget;
  }

  setSweeping(on: boolean): void {
    this.sweeping = on;
  }

  /**
   * Fire the strobe for `duration` seconds.
   *
   * Honours `prefers-reduced-motion`. A 12 Hz full-arena flash is squarely inside
   * the 3-30 Hz band that triggers photosensitive seizures, and the stylesheet's
   * reduced-motion block cannot reach a `THREE.PointLight` — so the one place the
   * preference can be respected is here. When it is set the cue still lands, as a
   * single bright swell rather than a flicker, so the beat is not lost.
   */
  strobe(strength: number, duration: number): void {
    this.strobeStrength = clamp01(strength);
    this.strobeUntil = this.elapsed + duration;
  }

  /** Kill the strobe immediately, e.g. when the show open is skipped. */
  stopStrobe(): void {
    this.strobeUntil = 0;
    this.strobeLight.intensity = 0;
  }

  /** Kick the team wall washes, e.g. on a knockout. */
  pulseWash(strength = 1): void {
    for (let i = 0; i < this.washPulses.length; i++) {
      this.washPulses[i] = Math.max(this.washPulses[i]!, clamp01(strength));
    }
  }

  /**
   * Flare one team's wall wash on its own.
   *
   * The introductions light one corner at a time — that is the whole point of the
   * beat — and firing both washes together during each one threw away the only
   * cue distinguishing the red corner from the blue.
   */
  pulseWashFor(team: 0 | 1, strength = 1): void {
    for (let i = team; i < this.washPulses.length; i += 2) {
      this.washPulses[i] = Math.max(this.washPulses[i]!, clamp01(strength));
    }
  }

  /** A brief orange flare at an impact point. */
  flashAt(position: THREE.Vector3, strength: number): void {
    this.impactFlash.position.copy(position);
    this.impactFlash.intensity = Math.max(this.impactFlash.intensity, strength * 14);
    this.impactFlash.visible = true;
  }

  /** Everything off, instantly. Used for the blackout before the walk-in. */
  blackout(): void {
    this.setHouse(0, true);
    this.setArena(0, true);
    this.setSweeping(false);
    this.stopStrobe();
    this.sweepLevel = 0;
    this.washPulses.fill(0);
  }

  /** Normal, fully-lit arena — the state a practice session starts in. */
  fullLights(): void {
    this.setHouse(0.55, true);
    this.setArena(1, true);
    this.setSweeping(false);
    this.sweepLevel = 0;
  }

  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.elapsed += dt;

    // Big stadium fixtures do not fade instantly, but a contactor slam is fast.
    this.houseLevel = damp(this.houseLevel, this.houseTarget, 3.2, dt);
    this.arenaLevel = damp(this.arenaLevel, this.arenaTarget, 9, dt);

    this.hemisphere.intensity = 0.05 + this.houseLevel * 0.55 + this.arenaLevel * 0.45;

    for (const fill of this.houseLights) {
      fill.intensity = this.houseLevel * 12 + this.arenaLevel * 18;
    }
    for (const bank of this.arenaBanks) {
      bank.intensity = this.arenaLevel * 190;
    }
    for (const panel of this.bankPanels) {
      (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = this.arenaLevel * 2.6;
    }

    // Searchlights sweep across the box during the introductions.
    this.sweepLevel = damp(this.sweepLevel, this.sweeping ? 1 : 0, 2.4, dt);
    for (const searchlight of this.searchlights) {
      const angle = this.elapsed * searchlight.speed + searchlight.phase;
      const targetX = Math.sin(angle) * ARENA_HALF * 0.85;
      const targetZ = Math.cos(angle * 0.73) * ARENA_HALF * 0.85;
      searchlight.light.target.position.set(targetX, 0.2, targetZ);
      searchlight.light.target.updateMatrixWorld();
      searchlight.light.intensity = this.sweepLevel * 260;

      const material = searchlight.beam.material as THREE.MeshBasicMaterial;
      material.opacity = this.sweepLevel * 0.09;
      /*
       * Move the cone to the fixture *before* aiming it.
       *
       * `lookAt` builds the orientation from the object's current position, and at
       * this point that is still last frame's — the fixture position translated
       * eight metres down the previous beam axis. Aiming from a point out on the
       * floor rather than from the lamp put the visible cone up to 60 degrees off
       * the light it is supposed to be showing, so the bright patch on the floor
       * and the shaft of haze pointing at it were unrelated.
       */
      searchlight.beam.position.copy(searchlight.light.position);
      searchlight.beam.lookAt(searchlight.light.target.position);
      searchlight.beam.rotateX(-Math.PI / 2);
      searchlight.beam.translateY(-8);
    }

    // Wall washes idle low and flare when something big happens.
    for (let i = 0; i < this.wallWashes.length; i++) {
      const pulse = Math.max(0, (this.washPulses[i] ?? 0) - dt * 1.6);
      this.washPulses[i] = pulse;
      this.wallWashes[i]!.intensity = (0.18 + this.sweepLevel * 0.5 + pulse * 2.2) * 12;
    }

    if (this.elapsed < this.strobeUntil) {
      if (prefersReducedMotion()) {
        // One steady swell instead of a flicker: same cue, no flashing.
        this.strobeLight.intensity = this.strobeStrength * 120;
      } else {
        // 12 Hz reads as a strobe on camera and on screen.
        const on = Math.sin(this.elapsed * Math.PI * 2 * 12) > 0;
        this.strobeLight.intensity = on ? this.strobeStrength * 320 : 0;
      }
    } else {
      this.strobeLight.intensity = 0;
    }

    if (this.impactFlash.visible) {
      this.impactFlash.intensity = damp(this.impactFlash.intensity, 0, 14, dt);
      if (this.impactFlash.intensity < 0.05) this.impactFlash.visible = false;
    }
  }

  dispose(): void {
    this.unsubscribeProfile?.();
    this.unsubscribeProfile = null;
    // Shadow-casting lights own a render target each; `Light.dispose()` is what
    // releases it. Walking only the meshes left every match's shadow maps resident.
    this.group.traverse((object) => {
      if (object instanceof THREE.Light) object.dispose();
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
  }
}
