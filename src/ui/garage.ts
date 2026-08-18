/**
 * The garage: where a robot is designed.
 *
 * Every choice is a weight decision. The panel shows the running total against
 * the 250 lb limit and the derived performance in real units, so the trade-offs
 * are visible as they are made: thicker armour is heavier and slower, a bigger
 * bar means less armour, six wheels push harder and turn worse.
 *
 * Illegal designs are shown, not hidden — a weapon that will not fit the frame
 * is greyed out with the reason, and being overweight is called out plainly
 * rather than silently prevented.
 */

import { kgToLb, mpsToMph } from '../core/math';
import {
  ARMOR,
  CHASSIS,
  DRIVES,
  LIVERIES,
  SRIMECH_MASS_KG,
  WEAPONS,
  WEIGHT_LIMIT_KG,
  WEIGHT_LIMIT_LB,
  WHEELS,
  computeStats,
  getArmor,
  getChassis,
  isMountCompatible,
  maxLegalThickness,
  type BotDesign,
  type LiveryId,
} from '../sim/parts';

/** Convert 0xRRGGBB to the #rrggbb an <input type=color> expects. */
function toHexInput(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function fromHexInput(value: string): number {
  return parseInt(value.replace('#', ''), 16) || 0;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface GarageCallbacks {
  onChange: (design: BotDesign) => void;
  onFight: () => void;
  onBack: () => void;
  onRandomise: () => void;
}

export class Garage {
  readonly root: HTMLElement;
  private design: BotDesign;
  private callbacks: GarageCallbacks;

  private leftPanel!: HTMLElement;
  private rightPanel!: HTMLElement;
  private fightButton!: HTMLButtonElement;

  constructor(design: BotDesign, callbacks: GarageCallbacks) {
    this.design = design;
    this.callbacks = callbacks;
    this.root = el('div', 'layer interactive hidden');
    this.root.id = 'garage';
    this.build();
    this.refresh();
  }

  get currentDesign(): BotDesign {
    return this.design;
  }

  setDesign(design: BotDesign): void {
    this.design = design;
    this.refresh();
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private build(): void {
    this.leftPanel = el('div', 'garage-panel');
    const centre = el('div', 'garage-centre');
    this.rightPanel = el('div', 'garage-panel');

    // The centre column is mostly a window onto the 3D preview behind it.
    const title = el('h1', 'garage-title', 'The Garage');
    centre.appendChild(title);

    const footer = el('div', 'garage-footer');
    const back = el('button', 'ghost', 'Back');
    back.addEventListener('click', () => this.callbacks.onBack());
    const randomise = el('button', '', 'Random Build');
    randomise.addEventListener('click', () => this.callbacks.onRandomise());
    this.fightButton = el('button', 'primary', 'Fight');
    this.fightButton.addEventListener('click', () => this.callbacks.onFight());
    footer.append(back, randomise, this.fightButton);
    centre.appendChild(footer);

    this.root.append(this.leftPanel, centre, this.rightPanel);
  }

  /** Rebuild both panels from the current design. */
  private refresh(): void {
    this.leftPanel.replaceChildren();
    this.rightPanel.replaceChildren();

    const stats = computeStats(this.design);

    // --- Left: identity and hardware -----------------------------------------
    this.leftPanel.appendChild(this.buildIdentitySection());
    this.leftPanel.appendChild(this.buildChassisSection());
    this.leftPanel.appendChild(this.buildWeaponSection());

    // --- Right: weight, armour, drive, stats ----------------------------------
    this.rightPanel.appendChild(this.buildWeightSection());
    this.rightPanel.appendChild(this.buildArmorSection());
    this.rightPanel.appendChild(this.buildDriveSection());
    this.rightPanel.appendChild(this.buildStatsSection());

    this.fightButton.disabled = !stats.legal;
    this.fightButton.textContent = stats.legal ? 'Fight' : 'Illegal Build';
  }

  private commit(mutate: (design: BotDesign) => void): void {
    mutate(this.design);

    // Changing the frame can invalidate the weapon. Rather than silently
    // swapping it, move to the first weapon the new frame can carry.
    const chassis = getChassis(this.design.chassisId);
    const weapon = WEAPONS.find((w) => w.id === this.design.weaponId);
    if (weapon && !isMountCompatible(chassis, weapon)) {
      const fallback = WEAPONS.find((w) => isMountCompatible(chassis, w));
      if (fallback) this.design.weaponId = fallback.id;
    }

    // Keep the armour within what the material can be made in.
    const armor = getArmor(this.design.armorId);
    if (this.design.armorThicknessMm > armor.maxThicknessMm) {
      this.design.armorThicknessMm = armor.maxThicknessMm;
    }

    this.refresh();
    this.callbacks.onChange(this.design);
  }

  private section(title: string): { section: HTMLElement; body: HTMLElement } {
    const section = el('div', 'section');
    section.appendChild(el('div', 'section-head', title));
    const body = el('div', 'section-body');
    section.appendChild(body);
    return { section, body };
  }

  // -------------------------------------------------------------------------

  private buildIdentitySection(): HTMLElement {
    const { section, body } = this.section('Identity');

    const nameField = el('div', 'field');
    const nameLabel = el('div', 'field-label');
    nameLabel.appendChild(el('span', undefined, 'Robot Name'));
    nameField.appendChild(nameLabel);
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.value = this.design.name;
    nameInput.addEventListener('input', () => {
      // Do not rebuild the whole panel on every keystroke — it would steal
      // focus from the field being typed into.
      this.design.name = nameInput.value.toUpperCase();
      this.callbacks.onChange(this.design);
    });
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    const colours = el('div', 'colour-row');
    for (const [label, key] of [
      ['Primary', 'primaryColor'],
      ['Trim', 'secondaryColor'],
      ['Accent', 'accentColor'],
    ] as const) {
      const field = el('div', 'field');
      const labelRow = el('div', 'field-label');
      labelRow.appendChild(el('span', undefined, label));
      field.appendChild(labelRow);
      const input = el('input');
      input.type = 'color';
      input.value = toHexInput(this.design[key]);
      input.addEventListener('input', () => {
        this.design[key] = fromHexInput(input.value);
        this.callbacks.onChange(this.design);
      });
      field.appendChild(input);
      colours.appendChild(field);
    }
    body.appendChild(colours);

    const liveryField = el('div', 'field');
    const liveryLabel = el('div', 'field-label');
    liveryLabel.appendChild(el('span', undefined, 'Livery'));
    liveryField.appendChild(liveryLabel);
    const liveryGrid = el('div', 'option-grid');
    liveryGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    for (const livery of LIVERIES) {
      const option = el('button', 'option tiny');
      option.textContent = livery.name;
      if (this.design.livery === livery.id) option.classList.add('selected');
      option.addEventListener('click', () =>
        this.commit((d) => {
          d.livery = livery.id as LiveryId;
        }),
      );
      liveryGrid.appendChild(option);
    }
    liveryField.appendChild(liveryGrid);
    body.appendChild(liveryField);

    return section;
  }

  private buildChassisSection(): HTMLElement {
    const { section, body } = this.section('Chassis');
    const grid = el('div', 'option-grid');

    for (const chassis of CHASSIS) {
      const option = el('button', 'option');
      if (this.design.chassisId === chassis.id) option.classList.add('selected');

      option.appendChild(el('div', 'option-name', chassis.name));
      option.appendChild(el('div', 'option-blurb', chassis.blurb));
      const meta = [
        `${chassis.massKg} kg frame`,
        chassis.invertible ? 'invertible' : 'not invertible',
        `${(chassis.clearance * 1000).toFixed(0)} mm clearance`,
      ].join(' · ');
      option.appendChild(el('div', 'option-meta', meta));

      option.addEventListener('click', () =>
        this.commit((d) => {
          d.chassisId = chassis.id;
        }),
      );
      grid.appendChild(option);
    }

    body.appendChild(grid);

    // Self-righting mechanism.
    const toggle = el('div', 'toggle-row');
    toggle.appendChild(
      el('span', 'field-label', `Self-righting arm (+${SRIMECH_MASS_KG} kg)`),
    );
    const button = el('button', 'tiny', this.design.srimech ? 'Fitted' : 'Not fitted');
    if (this.design.srimech) button.classList.add('primary');
    button.addEventListener('click', () =>
      this.commit((d) => {
        d.srimech = !d.srimech;
      }),
    );
    toggle.appendChild(button);
    body.appendChild(toggle);

    return section;
  }

  private buildWeaponSection(): HTMLElement {
    const { section, body } = this.section('Weapon');
    const chassis = getChassis(this.design.chassisId);
    const grid = el('div', 'option-grid');

    for (const weapon of WEAPONS) {
      const fits = isMountCompatible(chassis, weapon);
      const option = el('button', 'option');
      if (this.design.weaponId === weapon.id) option.classList.add('selected');
      if (!fits) option.classList.add('illegal');

      option.appendChild(el('div', 'option-name', weapon.name));
      option.appendChild(el('div', 'option-blurb', weapon.blurb));

      // Show what it actually does, computed the same way the fight will.
      const preview = computeStats({ ...this.design, weaponId: weapon.id });
      const bits: string[] = [`${weapon.massKg} kg`];
      if (weapon.kind !== 'none') {
        bits.push(`${(preview.weaponEnergyJ / 1000).toFixed(1)} kJ`);
        if (weapon.rpm > 0) {
          bits.push(`${weapon.rpm} rpm`);
          bits.push(`${preview.spinUpTime.toFixed(0)} s spin-up`);
        } else {
          bits.push(`${weapon.cycleTime.toFixed(1)} s cycle`);
        }
      }
      option.appendChild(el('div', 'option-meta', bits.join(' · ')));

      if (!fits) {
        option.appendChild(
          el('div', 'option-meta', `${chassis.name} has no ${weapon.mount} mount`),
        );
        option.disabled = true;
      }

      option.addEventListener('click', () =>
        this.commit((d) => {
          d.weaponId = weapon.id;
        }),
      );
      grid.appendChild(option);
    }

    body.appendChild(grid);
    return section;
  }

  private buildWeightSection(): HTMLElement {
    const stats = computeStats(this.design);
    const wrapper = el('div', 'weight');

    const head = el('div', 'weight-head');
    const total = el('div', `weight-total${stats.legal ? '' : ' over'}`);
    total.textContent = `${stats.totalMassLb.toFixed(1)} lb`;
    head.appendChild(total);
    head.appendChild(el('div', 'weight-limit', `limit ${WEIGHT_LIMIT_LB} lb`));
    wrapper.appendChild(head);

    const bar = el('div', 'weight-bar');
    const fill = el('div', `weight-fill${stats.overweightKg > 0 ? ' over' : ''}`);
    fill.style.width = `${Math.min(100, (stats.totalMassKg / WEIGHT_LIMIT_KG) * 100)}%`;
    bar.appendChild(fill);
    wrapper.appendChild(bar);

    const breakdown = el('div', 'weight-breakdown');
    const rows: [string, number][] = [
      ['Frame', stats.chassis.massKg],
      ['Armour', stats.armorMassKg],
      ['Drive', stats.drive.massKg],
      ['Wheels', stats.wheel.massKg],
      ['Weapon', stats.weapon.massKg],
    ];
    if (this.design.srimech) rows.push(['Srimech', SRIMECH_MASS_KG]);
    for (const [label, kg] of rows) {
      breakdown.appendChild(el('span', undefined, label));
      breakdown.appendChild(el('span', 'val', `${kgToLb(kg).toFixed(1)} lb`));
    }
    wrapper.appendChild(breakdown);

    if (stats.overweightKg > 0) {
      wrapper.appendChild(
        el(
          'div',
          'warning',
          `Over the limit by ${kgToLb(stats.overweightKg).toFixed(1)} lb. Thin the armour, lighten the weapon, or change the drive.`,
        ),
      );
    } else if (!isMountCompatible(stats.chassis, stats.weapon)) {
      wrapper.appendChild(
        el('div', 'warning', `${stats.chassis.name} cannot mount the ${stats.weapon.name}.`),
      );
    }

    return wrapper;
  }

  private buildArmorSection(): HTMLElement {
    const { section, body } = this.section('Armour');
    const stats = computeStats(this.design);
    const grid = el('div', 'option-grid');

    for (const armor of ARMOR) {
      const option = el('button', 'option');
      if (this.design.armorId === armor.id) option.classList.add('selected');
      option.appendChild(el('div', 'option-name', armor.name));
      option.appendChild(el('div', 'option-blurb', armor.blurb));

      // What thickness could this material be fitted at?
      const maxT = maxLegalThickness({ ...this.design, armorId: armor.id });
      option.appendChild(
        el(
          'div',
          'option-meta',
          maxT > 0
            ? `up to ${maxT.toFixed(1)} mm at weight · ${armor.densityKgM3} kg/m³`
            : 'will not make weight',
        ),
      );

      option.addEventListener('click', () =>
        this.commit((d) => {
          d.armorId = armor.id;
          // Snap to the thickest legal plate in the new material, which is
          // almost always what you want.
          const limit = maxLegalThickness({ ...d, armorId: armor.id });
          if (limit > 0) d.armorThicknessMm = Math.max(0.5, limit);
        }),
      );
      grid.appendChild(option);
    }
    body.appendChild(grid);

    // Thickness slider.
    const field = el('div', 'field');
    const label = el('div', 'field-label');
    label.appendChild(el('span', undefined, 'Plate thickness'));
    label.appendChild(
      el('span', 'field-value', `${this.design.armorThicknessMm.toFixed(1)} mm`),
    );
    field.appendChild(label);

    const slider = el('input');
    slider.type = 'range';
    slider.min = '0.5';
    slider.max = String(stats.armor.maxThicknessMm);
    slider.step = '0.5';
    slider.value = String(this.design.armorThicknessMm);
    slider.addEventListener('input', () =>
      this.commit((d) => {
        d.armorThicknessMm = Number(slider.value);
      }),
    );
    field.appendChild(slider);

    const maxLegal = maxLegalThickness(this.design);
    field.appendChild(
      el(
        'div',
        'option-meta',
        maxLegal > 0
          ? `${maxLegal.toFixed(1)} mm is the thickest that makes weight`
          : 'nothing makes weight with this hardware',
      ),
    );
    body.appendChild(field);

    return section;
  }

  private buildDriveSection(): HTMLElement {
    const { section, body } = this.section('Drivetrain');
    const grid = el('div', 'option-grid');

    for (const drive of DRIVES) {
      const option = el('button', 'option');
      if (this.design.driveId === drive.id) option.classList.add('selected');
      option.appendChild(el('div', 'option-name', drive.name));
      option.appendChild(el('div', 'option-blurb', drive.blurb));
      const preview = computeStats({ ...this.design, driveId: drive.id });
      option.appendChild(
        el(
          'div',
          'option-meta',
          `${drive.wheelCount} wheels · ${(drive.powerW / 1000).toFixed(1)} kW · ${mpsToMph(preview.topSpeedMps).toFixed(0)} mph`,
        ),
      );
      option.addEventListener('click', () =>
        this.commit((d) => {
          d.driveId = drive.id;
        }),
      );
      grid.appendChild(option);
    }
    body.appendChild(grid);

    const wheelGrid = el('div', 'option-grid');
    wheelGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    for (const wheel of WHEELS) {
      const option = el('button', 'option');
      if (this.design.wheelId === wheel.id) option.classList.add('selected');
      option.appendChild(el('div', 'option-name', wheel.name));
      option.appendChild(el('div', 'option-meta', `grip ${wheel.grip.toFixed(2)} · ${wheel.hp} hp`));
      option.addEventListener('click', () =>
        this.commit((d) => {
          d.wheelId = wheel.id;
        }),
      );
      wheelGrid.appendChild(option);
    }
    body.appendChild(wheelGrid);

    return section;
  }

  private buildStatsSection(): HTMLElement {
    const { section, body } = this.section('Performance');
    const stats = computeStats(this.design);
    const grid = el('div', 'stat-grid');

    const rows: { name: string; value: string; fill?: number }[] = [
      {
        name: 'Top speed',
        value: `${mpsToMph(stats.topSpeedMps).toFixed(1)} mph`,
        fill: stats.topSpeedMps / 12,
      },
      {
        name: 'Acceleration',
        value: `${stats.accelMps2.toFixed(1)} m/s²`,
        fill: stats.accelMps2 / 9,
      },
      {
        name: 'Push force',
        value: `${stats.pushForceN.toFixed(0)} N`,
        fill: stats.pushForceN / 1100,
      },
      {
        name: 'Durability',
        value: `${stats.totalHp.toFixed(0)} hp`,
        fill: stats.totalHp / 1100,
      },
    ];

    if (stats.weapon.kind !== 'none') {
      rows.push({
        name: 'Weapon energy',
        value: `${(stats.weaponEnergyJ / 1000).toFixed(1)} kJ`,
        fill: stats.weaponEnergyJ / 120_000,
      });
      if (stats.weapon.rpm > 0) {
        rows.push({
          name: 'Tip speed',
          value: `${mpsToMph(stats.tipSpeedMps).toFixed(0)} mph`,
          fill: stats.tipSpeedMps / 90,
        });
        rows.push({
          name: 'Spin-up',
          value: `${stats.spinUpTime.toFixed(1)} s`,
          fill: 1 - Math.min(1, stats.spinUpTime / 40),
        });
      }
    }

    rows.push({
      name: 'Drives inverted',
      value: stats.invertible ? 'yes' : 'no',
    });
    rows.push({
      name: 'Self-rights',
      value: stats.selfRighting ? (stats.invertible ? 'not needed' : 'yes') : 'no',
    });

    for (const row of rows) {
      const stat = el('div', 'stat');
      stat.appendChild(el('div', 'stat-name', row.name));
      stat.appendChild(el('div', 'stat-value', row.value));
      if (row.fill !== undefined) {
        const bar = el('div', 'stat-bar');
        const fill = el('div', 'stat-bar-fill');
        fill.style.width = `${Math.max(0, Math.min(1, row.fill)) * 100}%`;
        bar.appendChild(fill);
        stat.appendChild(bar);
      }
      grid.appendChild(stat);
    }

    body.appendChild(grid);
    return section;
  }
}
