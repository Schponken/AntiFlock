/**
 * The workshop.
 *
 * Every control here edits the same `BotDesign` the physics rig is built from,
 * and the readout on the right is `computeStats` — the identical function the
 * simulation uses. There is no separate "preview maths": if the panel says the
 * disc stores 37 kilojoules and the machine weighs 249 pounds, that is exactly
 * what walks into the box.
 */

import * as THREE from 'three';
import {
  ACCESSORIES,
  CHASSIS,
  DECALS,
  DRIVE_MOTORS,
  FINISHES,
  MATERIALS,
  WEAPONS,
  WEIGHT_LIMIT_KG,
  WHEELS,
  driveLayout,
  weaponById,
  weaponMountFor,
  type AccessoryEffect,
  type DecalId,
} from '../game/parts.ts';
import {
  ARMOR_THICKNESS_RANGE,
  COVERAGE_RANGE,
  GEAR_RATIO_RANGE,
  PRESETS,
  cloneDesign,
  computeStats,
  isBuildable,
  saveDesign,
  validateDesign,
  type BotDesign,
} from '../game/design.ts';
import { buildBotVisual, type BotVisual } from '../render/botMesh.ts';
import { kgToLb, mpsToMph, clamp01 } from '../core/mathx.ts';
import { button, clear, colorField, el, slider } from './dom.ts';

type TabId = 'chassis' | 'armour' | 'drive' | 'weapon' | 'extras' | 'paint';

const TABS: { id: TabId; label: string }[] = [
  { id: 'chassis', label: 'Frame' },
  { id: 'armour', label: 'Armour' },
  { id: 'drive', label: 'Drive' },
  { id: 'weapon', label: 'Weapon' },
  { id: 'extras', label: 'Extras' },
  { id: 'paint', label: 'Livery' },
];

export interface BuilderCallbacks {
  onFight: (design: BotDesign) => void;
  onBack: () => void;
}

export class Builder {
  readonly root: HTMLElement;
  /** Turntable holding the live preview; the app adds this to the main scene. */
  readonly previewGroup = new THREE.Group();

  private design: BotDesign;
  private tab: TabId = 'chassis';
  private optionsPane: HTMLElement;
  private statsPane: HTMLElement;
  private tabBar: HTMLElement;
  private nameInput: HTMLInputElement;
  private fightButton: HTMLButtonElement;
  private visual: BotVisual | null = null;
  private callbacks: BuilderCallbacks;
  private spin = 0;

  constructor(design: BotDesign, callbacks: BuilderCallbacks) {
    this.design = cloneDesign(design);
    this.callbacks = callbacks;
    this.previewGroup.name = 'builder-preview';

    this.optionsPane = el('div', { class: 'builder__options' });
    this.statsPane = el('aside', { class: 'builder__stats' });
    this.tabBar = el('nav', { class: 'builder__tabs' });

    this.nameInput = el('input', {
      class: 'builder__name',
      type: 'text',
      maxlength: 24,
      value: this.design.name,
      'aria-label': 'Bot name',
    });
    this.nameInput.addEventListener('input', () => {
      this.design.name = this.nameInput.value;
      this.refreshStats();
    });

    this.fightButton = button('SAVE & FIGHT', () => this.commit(), { variant: 'primary' });

    this.root = el(
      'section',
      { class: 'screen builder' },
      el(
        'header',
        { class: 'builder__head' },
        el('div', { class: 'builder__title' }, el('span', { class: 'eyebrow', text: 'Workshop' }), this.nameInput),
        el(
          'div',
          { class: 'builder__presets' },
          el('span', { class: 'eyebrow', text: 'Load a build' }),
          this.buildPresetPicker(),
        ),
      ),
      el(
        'div',
        { class: 'builder__body' },
        el('div', { class: 'builder__left' }, this.tabBar, this.optionsPane),
        el('div', { class: 'builder__viewport' }),
        this.statsPane,
      ),
      el(
        'footer',
        { class: 'builder__foot' },
        button('← Back', () => this.callbacks.onBack(), { variant: 'ghost' }),
        this.fightButton,
      ),
    );

    this.buildTabs();
    this.rebuild();
  }

  get currentDesign(): BotDesign {
    return cloneDesign(this.design);
  }

  private buildPresetPicker(): HTMLElement {
    const select = el('select', { class: 'select' });
    select.append(el('option', { value: '', text: 'Custom build' }));
    for (const preset of PRESETS) {
      select.append(el('option', { value: preset.id, text: `${preset.label} — ${preset.tagline}` }));
    }
    select.addEventListener('change', () => {
      const preset = PRESETS.find((p) => p.id === select.value);
      if (!preset) return;
      this.design = cloneDesign(preset.design);
      this.nameInput.value = this.design.name;
      this.rebuild();
    });
    return select;
  }

  private buildTabs(): void {
    clear(this.tabBar);
    for (const tab of TABS) {
      const node = button(
        tab.label,
        () => {
          this.tab = tab.id;
          this.buildTabs();
          this.renderOptions();
        },
        { className: `tab ${this.tab === tab.id ? 'is-active' : ''}` },
      );
      this.tabBar.append(node);
    }
  }

  /** Rebuild everything: options, stats and the 3D preview. */
  private rebuild(): void {
    this.renderOptions();
    this.refreshStats();
    this.rebuildPreview();
  }

  /** Options changed in a way that changes the machine's shape or colour. */
  private changed(rebuildMesh: boolean): void {
    this.refreshStats();
    if (rebuildMesh) this.rebuildPreview();
  }

  private rebuildPreview(): void {
    if (this.visual) {
      this.visual.dispose();
      this.visual.root.removeFromParent();
      this.visual = null;
    }
    const stats = computeStats(this.design);
    this.visual = buildBotVisual(this.design, stats, 0);
    // Sit the machine on its wheels on the turntable.
    this.visual.root.position.y = stats.parts.chassis.height / 2 + stats.parts.chassis.groundClearance;
    this.previewGroup.add(this.visual.root);

    // Wheels have no physics here, so place them from the same geometry the rig uses.
    const { chassis, wheel } = stats.parts;
    const { halfTrack, wheelLocalY, rowZ } = driveLayout(chassis, wheel);
    for (let i = 0; i < this.visual.wheels.length; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = rowZ[Math.floor(i / 2)]!;
      // Wheels are children of `root`, so these are root-local coordinates. Adding
      // the root's own height here would lift the whole machine off the turntable.
      this.visual.wheels[i]!.position.set(side * halfTrack, wheelLocalY, z);
    }
    if (this.visual.weaponPivot) {
      const mount = weaponMountFor(chassis, wheel, stats.parts.weapon);
      this.visual.weaponPivot.position.set(
        mount.x,
        mount.y,
        mount.z,
      );
    }
    this.visual.underglow.intensity = 2.4;
  }

  /** Slowly rotate the preview so the player can see the whole machine. */
  update(dt: number): void {
    this.spin += dt * 0.5;
    this.previewGroup.rotation.y = this.spin;

    // Spin the rotor about its own axis. Turning a horizontal bar about X makes
    // it tumble end-over-end rather than sweep flat, which reads as a broken
    // machine rather than as a weapon.
    const rotor = this.visual?.weapon;
    if (rotor) {
      const axis = computeStats(this.design).parts.weapon.rotor?.axis ?? 'x';
      if (axis === 'y') rotor.rotation.y += dt * 2.2;
      else rotor.rotation.x += dt * 2.2;
    }
  }

  // -------------------------------------------------------------------------
  // Option panes
  // -------------------------------------------------------------------------

  private renderOptions(): void {
    clear(this.optionsPane);
    switch (this.tab) {
      case 'chassis':
        this.renderChassis();
        break;
      case 'armour':
        this.renderArmour();
        break;
      case 'drive':
        this.renderDrive();
        break;
      case 'weapon':
        this.renderWeapon();
        break;
      case 'extras':
        this.renderExtras();
        break;
      case 'paint':
        this.renderPaint();
        break;
    }
  }

  private optionCard(options: {
    title: string;
    blurb: string;
    meta: string;
    selected: boolean;
    disabled?: boolean;
    onSelect: () => void;
  }): HTMLElement {
    const card = el(
      'button',
      {
        type: 'button',
        class: `option ${options.selected ? 'is-selected' : ''} ${options.disabled ? 'is-disabled' : ''}`,
        disabled: options.disabled,
      },
      el('span', { class: 'option__title', text: options.title }),
      el('span', { class: 'option__meta', text: options.meta }),
      el('span', { class: 'option__blurb', text: options.blurb }),
    );
    if (!options.disabled) card.addEventListener('click', options.onSelect);
    return card;
  }

  private renderChassis(): void {
    for (const chassis of CHASSIS) {
      this.optionsPane.append(
        this.optionCard({
          title: chassis.name,
          blurb: chassis.blurb,
          meta: `${chassis.frameMass} kg · ${chassis.wheelCount} wheels · ${(chassis.groundClearance * 1000).toFixed(0)} mm clearance${chassis.invertible ? ' · invertible' : ''}`,
          selected: this.design.chassisId === chassis.id,
          onSelect: () => {
            this.design.chassisId = chassis.id;
            // A frame that cannot mount the current weapon gets its first legal one.
            if (!chassis.accepts.includes(computeStats(this.design).parts.weapon.kind)) {
              const fallback = WEAPONS.find((w) => chassis.accepts.includes(w.kind));
              if (fallback) this.design.weaponId = fallback.id;
            }
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  private renderArmour(): void {
    const stats = computeStats(this.design);
    this.optionsPane.append(
      slider({
        label: 'Plate thickness',
        min: ARMOR_THICKNESS_RANGE.min,
        max: ARMOR_THICKNESS_RANGE.max,
        step: 1,
        value: this.design.armorThicknessMm,
        format: (v) => `${v} mm`,
        onInput: (v) => {
          this.design.armorThicknessMm = v;
          this.changed(true);
        },
      }),
      slider({
        label: 'Coverage',
        min: COVERAGE_RANGE.min,
        max: COVERAGE_RANGE.max,
        step: 0.05,
        value: this.design.armorCoverage,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => {
          this.design.armorCoverage = v;
          this.changed(false);
        },
      }),
      el('p', {
        class: 'hint',
        text: `${stats.parts.chassis.name} is cut for ${stats.parts.chassis.armorArea.toFixed(2)} m² of structural plate.`,
      }),
    );

    for (const material of MATERIALS) {
      const mass = stats.parts.chassis.armorArea * this.design.armorCoverage *
        (this.design.armorThicknessMm / 1000) * material.density;
      this.optionsPane.append(
        this.optionCard({
          title: material.name,
          blurb: material.blurb,
          meta: `${mass.toFixed(1)} kg at current spec · ${material.density} kg/m³`,
          selected: this.design.armorMaterialId === material.id,
          onSelect: () => {
            this.design.armorMaterialId = material.id;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  private renderDrive(): void {
    const stats = computeStats(this.design);
    this.optionsPane.append(
      slider({
        label: 'Gear ratio',
        min: GEAR_RATIO_RANGE.min,
        max: GEAR_RATIO_RANGE.max,
        step: 1,
        value: this.design.gearRatio,
        format: (v) => `${v}:1`,
        onInput: (v) => {
          this.design.gearRatio = v;
          this.changed(false);
        },
      }),
      el('p', {
        class: 'hint',
        text: `Top speed ${mpsToMph(stats.topSpeed).toFixed(1)} mph · ${stats.acceleration.toFixed(1)} m/s² off the line.`,
      }),
      el('h4', { class: 'section', text: 'Motors' }),
    );

    for (const motor of DRIVE_MOTORS) {
      this.optionsPane.append(
        this.optionCard({
          title: motor.name,
          blurb: motor.blurb,
          meta: `${motor.freeRpm} rpm · ${motor.stallTorque} Nm · ${motor.mass} kg each`,
          selected: this.design.motorId === motor.id,
          onSelect: () => {
            this.design.motorId = motor.id;
            this.renderOptions();
            this.changed(false);
          },
        }),
      );
    }

    this.optionsPane.append(el('h4', { class: 'section', text: 'Wheels' }));
    for (const wheel of WHEELS) {
      this.optionsPane.append(
        this.optionCard({
          title: wheel.name,
          blurb: wheel.blurb,
          meta: `${(wheel.radius * 2000).toFixed(0)} mm · grip ${wheel.grip.toFixed(2)} · ${wheel.mass} kg each`,
          selected: this.design.wheelId === wheel.id,
          onSelect: () => {
            this.design.wheelId = wheel.id;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  private renderWeapon(): void {
    const chassis = computeStats(this.design).parts.chassis;

    for (const weapon of WEAPONS) {
      const compatible = chassis.accepts.includes(weapon.kind);
      const meta = weapon.rotor
        ? `${weapon.rotor.maxOmega} rad/s redline · ${(weapon.rotor.radius * 2000).toFixed(0)} mm swing`
        : weapon.actuator
          ? `${weapon.actuator.energy} J per shot · ${weapon.actuator.shots} shots`
          : weapon.clamp
            ? `${(weapon.clamp.force / 1000).toFixed(0)} kN jaw`
            : 'no moving parts';
      this.optionsPane.append(
        this.optionCard({
          title: weapon.name,
          blurb: compatible ? weapon.blurb : `${chassis.name} has no mounting for this.`,
          meta,
          selected: this.design.weaponId === weapon.id,
          disabled: !compatible,
          onSelect: () => {
            this.design.weaponId = weapon.id;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }

    /*
     * Only offer a rotor material when there is a rotor.
     *
     * `rotorMass` returns 0 for a weapon with no rotor, so for the flipper, the
     * hammer, the crusher and the wedge every one of the eight cards produced a
     * byte-identical build — same mass, same cost, same energy, same everything.
     * Eight choices that cannot be distinguished is worse than no choice, because
     * the player spends time on it.
     */
    const weapon = weaponById(this.design.weaponId);
    if (!weapon.rotor) {
      this.optionsPane.append(
        el('p', {
          class: 'muted',
          text: `${/^[aeiou]/i.test(weapon.name) ? 'An' : 'A'} ${weapon.name.toLowerCase()} has no rotor, so there is no rotor material to choose.`,
        }),
      );
      return;
    }

    this.optionsPane.append(el('h4', { class: 'section', text: 'Rotor material' }));
    for (const material of MATERIALS) {
      this.optionsPane.append(
        this.optionCard({
          title: material.name,
          blurb: material.blurb,
          meta: `${material.density} kg/m³ · toughness ${(material.toughness / 1000).toFixed(1)} kJ`,
          selected: this.design.weaponMaterialId === material.id,
          onSelect: () => {
            this.design.weaponMaterialId = material.id;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  private renderExtras(): void {
    const weapon = weaponById(this.design.weaponId);
    /*
     * Say so when a part cannot do anything for this build.
     *
     * The Gyro Compensator cancels a rotor's gyroscopic reaction, and the Extended
     * Battery feeds a rotor's motor and an actuator's charge — so on a fixed wedge
     * both are pure weight, and on a flipper the compensator is. Offering them
     * anyway is the same trap the rotor-material picker used to be.
     */
    const inert = (id: AccessoryEffect): string | null => {
      if (id === 'antispin' && !weapon.rotor) {
        return `Nothing to compensate: ${weapon.name.toLowerCase()} has no rotor.`;
      }
      if (id === 'bigbattery' && !weapon.rotor && !weapon.actuator && !weapon.clamp) {
        return `Nothing to power: ${weapon.name.toLowerCase()} draws no current.`;
      }
      return null;
    };

    for (const accessory of ACCESSORIES) {
      const active = this.design.accessories.includes(accessory.id);
      const useless = inert(accessory.id);
      this.optionsPane.append(
        this.optionCard({
          title: accessory.name,
          blurb: useless ?? accessory.blurb,
          meta: `${accessory.mass} kg`,
          selected: active,
          disabled: useless !== null && !active,
          onSelect: () => {
            this.toggleAccessory(accessory.id);
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  private toggleAccessory(id: AccessoryEffect): void {
    const index = this.design.accessories.indexOf(id);
    if (index >= 0) this.design.accessories.splice(index, 1);
    else this.design.accessories.push(id);
  }

  private renderPaint(): void {
    this.optionsPane.append(
      el(
        'div',
        { class: 'paintrow' },
        colorField('Primary', this.design.paint.primary, (v) => {
          this.design.paint.primary = v;
          this.changed(true);
        }),
        colorField('Secondary', this.design.paint.secondary, (v) => {
          this.design.paint.secondary = v;
          this.changed(true);
        }),
        colorField('Accent', this.design.paint.accent, (v) => {
          this.design.paint.accent = v;
          this.changed(true);
        }),
        colorField('Underglow', this.design.paint.glow, (v) => {
          this.design.paint.glow = v;
          this.changed(true);
        }),
      ),
      el('h4', { class: 'section', text: 'Finish' }),
    );

    for (const finish of FINISHES) {
      this.optionsPane.append(
        this.optionCard({
          title: finish.name,
          blurb: '',
          meta: `roughness ${finish.roughness.toFixed(2)}`,
          selected: this.design.paint.finishId === finish.id,
          onSelect: () => {
            this.design.paint.finishId = finish.id;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }

    this.optionsPane.append(el('h4', { class: 'section', text: 'Graphics' }));
    for (const decal of DECALS) {
      this.optionsPane.append(
        this.optionCard({
          title: decal.name,
          blurb: '',
          meta: '',
          selected: this.design.paint.decal === decal.id,
          onSelect: () => {
            this.design.paint.decal = decal.id as DecalId;
            this.renderOptions();
            this.changed(true);
          },
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Stats readout
  // -------------------------------------------------------------------------

  private refreshStats(): void {
    const stats = computeStats(this.design);
    const issues = validateDesign(this.design);
    const buildable = isBuildable(this.design);
    clear(this.statsPane);

    const used = clamp01(stats.weightUsed);
    const over = stats.overweightBy > 0;

    const weightBar = el(
      'div',
      { class: `weight ${over ? 'is-over' : ''}` },
      el('div', { class: 'weight__head' },
        el('span', { text: 'WEIGHT' }),
        el('strong', {
          text: `${kgToLb(stats.totalMass).toFixed(0)} / ${kgToLb(WEIGHT_LIMIT_KG).toFixed(0)} lb`,
        }),
      ),
      el('div', { class: 'weight__track' }, el('i', { class: 'weight__fill', style: `width:${used * 100}%` })),
      el('div', {
        class: 'weight__note',
        text: over
          ? `${kgToLb(stats.overweightBy).toFixed(1)} lb over the limit`
          : `${kgToLb(WEIGHT_LIMIT_KG - stats.totalMass).toFixed(1)} lb spare`,
      }),
    );

    const breakdown: [string, number][] = [
      ['Frame', stats.parts.chassis.frameMass],
      ['Armour', stats.armorMass],
      ['Drive', stats.driveMass],
      ['Weapon', stats.weaponMass],
      ['Extras', stats.accessoryMass],
      ['Electronics', stats.electronicsMass],
    ];

    const statRows: [string, string][] = [
      ['Top speed', `${mpsToMph(stats.topSpeed).toFixed(1)} mph`],
      ['Acceleration', `${stats.acceleration.toFixed(1)} m/s²`],
      ['Push force', `${(Math.min(stats.driveForce, stats.tractionLimit) / 9.81).toFixed(0)} kgf`],
      ['Armour integrity', `${(stats.armorHp / 1000).toFixed(0)} kJ`],
      ['Frame integrity', `${(stats.frameHp / 1000).toFixed(0)} kJ`],
    ];

    if (stats.weaponEnergy > 0) {
      statRows.push(
        ['Weapon energy', `${(stats.weaponEnergy / 1000).toFixed(1)} kJ`],
        ['Tip speed', `${mpsToMph(stats.weaponTipSpeed).toFixed(0)} mph`],
        ['Spin-up', `${stats.weaponSpinupTime.toFixed(1)} s`],
      );
    } else if (stats.actuatorEnergy > 0) {
      statRows.push(['Shot energy', `${stats.actuatorEnergy.toFixed(0)} J`]);
    }
    /*
     * The pack budget, made legible. `drawWatts` was a catalogue number nothing
     * read and nothing showed; now that it decides whether a machine can drive
     * while its weapon spins up, the player has to be able to see the sum before
     * they are in the box wondering why the drive went soft.
     */
    const draw = stats.driveDrawWatts + stats.weaponDrawWatts;
    statRows.push([
      'Peak pack draw',
      `${(draw / 1000).toFixed(1)} kW of ${(stats.packWatts / 1000).toFixed(1)} kW` +
        (draw > stats.packWatts ? ' — sags' : ''),
    ]);
    statRows.push(['Build cost', `$${Math.round(stats.cost).toLocaleString('en-US')}`]);

    this.statsPane.append(
      weightBar,
      el(
        'div',
        { class: 'breakdown' },
        ...breakdown.map(([label, mass]) =>
          el(
            'div',
            { class: 'breakdown__row' },
            el('span', { text: label }),
            el('span', { class: 'breakdown__bar' },
              el('i', { style: `width:${(mass / Math.max(1, stats.totalMass)) * 100}%` }),
            ),
            el('span', { class: 'breakdown__value', text: `${mass.toFixed(1)} kg` }),
          ),
        ),
      ),
      el(
        'dl',
        { class: 'statlist' },
        ...statRows.flatMap(([label, value]) => [
          el('dt', { text: label }),
          el('dd', { text: value }),
        ]),
      ),
      el(
        'div',
        { class: 'issues' },
        ...issues.map((issue) =>
          el('p', { class: `issue issue--${issue.level}`, text: issue.message }),
        ),
      ),
    );

    this.fightButton.disabled = !buildable;
    this.fightButton.textContent = buildable ? 'SAVE & FIGHT' : 'ILLEGAL BUILD';
  }

  private commit(): void {
    if (!isBuildable(this.design)) return;
    saveDesign(this.design);
    this.callbacks.onFight(cloneDesign(this.design));
  }

  dispose(): void {
    this.visual?.dispose();
    this.visual?.root.removeFromParent();
    this.visual = null;
  }
}
