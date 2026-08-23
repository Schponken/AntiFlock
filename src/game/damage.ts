/**
 * The damage model.
 *
 * Everything here is bookkeeping in joules. A weapon carries kinetic energy; a
 * collision transfers some fraction of it; the fraction that transfers is
 * subtracted from the attacker's rotor *and* from the defender's structure. That
 * single shared currency is what makes a big hit slow the spinner down, throw both
 * machines apart, and blow a panel off, all from the same number.
 */

import { clamp, clamp01 } from '../core/mathx.ts';
import type { DerivedStats } from './design.ts';
import type { MaterialSpec } from './parts.ts';

export type PartKind = 'frame' | 'armor' | 'wheel' | 'weapon' | 'srimech';

export type ArmorFace = 'front' | 'rear' | 'left' | 'right' | 'top' | 'bottom';

export interface PartState {
  id: string;
  kind: PartKind;
  label: string;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  /** Cumulative energy absorbed, used to drive progressive visual denting. */
  absorbed: number;
  /** Armour panels only. */
  face?: ArmorFace;
  /** Wheels only: which drive index this part powers. */
  wheelIndex?: number;
  /** Panels that can physically fall off and become debris. */
  detachable: boolean;
}

export interface HitInput {
  /** Energy available in the strike, joules. */
  energy: number;
  /** Weapon damage multiplier from the parts catalogue. */
  bite: number;
  /** 0 = glancing graze, 1 = dead-square hit. */
  squareness: number;
  /** The surface being struck. */
  targetMaterial: MaterialSpec;
  /** Millimetres of plate at the point of impact. Drives how much shock the
   *  panel passes into the frame — see `plateStiffness`. */
  plateThicknessMm: number;
  /** Part taking the hit. */
  part: PartState;
}

export interface HitResult {
  /** Energy actually removed from the attacker, joules. */
  energyTransferred: number;
  /** Structural integrity consumed, joules. */
  damage: number;
  destroyed: boolean;
  /** 0-1, for sparks, screen shake and commentary. */
  severity: number;
  /** Energy the panel shrugged off into the structure behind it, joules. */
  shock: number;
  /**
   * How much of that shock the frame actually took, joules.
   *
   * Separate from `shock` because the frame floors at 1 HP: past that point the
   * strike stops doing structural work and the attacker must not be charged for
   * it. Zero from a bare `resolveHit`, which has no machine to pass shock into.
   */
  shockConsumed: number;
  part: PartState;
}

/** Below this, a contact is a scrape and produces no damage event at all. */
export const MIN_DAMAGING_ENERGY = 45;

/**
 * How much of a rebuffed strike reaches the structure behind the panel.
 *
 * Energy a panel does not absorb does not vanish — it is still delivered, and
 * something has to take it. A hard, rigid plate spreads that load into the frame
 * over the whole panel; a soft, ductile one deflects, concentrates the load on
 * its mountings and hands the shock straight through to whatever is bolted
 * behind. That is the well-known cost of running plastic: your armour survives
 * everything and your machine gets shaken to pieces underneath it.
 *
 * Without this term the model had no cost at all, and UHMW was strictly the best
 * armour in the game — better joules per kilogram than titanium *and* the lowest
 * transfer fraction, so there was no build for which any metal was the right
 * answer. That is a dead choice in a game whose entire premise is the choice.
 */
export const SHOCK_COUPLING = 0.3;

/**
 * How much of what a panel refuses comes back into the weapon that hit it,
 * before scaling by that panel's hardness. See `BotDamage.wearWeapon`.
 */
export const WEAPON_WEAR = 0.05;

/** Plate thickness the stiffness curve is normalised on, millimetres. */
export const NOMINAL_PLATE_MM = 10;

/**
 * How hard a panel of this thickness drives its own mountings.
 *
 * A panel does two things with a hit: it eats some of it, and it hands the rest
 * to whatever it is bolted to. On the HP term alone the thickness slider had
 * exactly one right answer. Hold the armour *mass* fixed and the plated area
 * falls as `1/t`, so `armorHp = area * t^1.15 * toughness` still grows as
 * `t^0.15` — thicker is free HP, and the only reason to run thin plate was to
 * cover more of the shell.
 *
 * That is not what thick plate does in the sport. A thin panel is compliant: it
 * dishes, and spreading the same impulse over a longer contact time is exactly
 * what keeps the peak force out of the standoffs. A thick one is a rigid beam
 * that hands the whole spike to the frame rails behind it. Modelled as the
 * transmitted share rising with the square root of thickness, which puts a
 * `t^0.5` penalty against a `t^0.15` gain and gives the slider a genuine
 * interior optimum: thick plate buys panels that survive and a frame that does
 * not, thin plate the reverse, and where the balance sits depends on how ductile
 * the material is. Clamped at both ends so neither extreme is degenerate.
 */
export function plateStiffness(thicknessMm: number): number {
  const t = clamp(thicknessMm, 1, 40) / NOMINAL_PLATE_MM;
  return clamp(t ** 0.5, 0.45, 1.7);
}

/**
 * Fraction of the incoming energy that couples into the target.
 *
 * Slippery, ductile armour (UHMW, HDPE) sheds a glancing weapon; hard brittle
 * armour (tool steel, carbon) has nowhere to put the energy and takes it all.
 */
export function transferFraction(
  squareness: number,
  targetMaterial: MaterialSpec,
  bite: number,
): number {
  const grabbiness = clamp(targetMaterial.friction * 1.45, 0.18, 1);
  const brittleness = 1 - targetMaterial.ductility * 0.62;
  // A hard face is one a tooth cannot get into. Without this term the model had
  // no way to tell hardened steel from titanium at all — the two differ mostly in
  // hardness, not toughness — and every steel in the catalogue was dominated.
  const bitesIn = 1 - 0.45 * clamp01(targetMaterial.hardness);
  const square = clamp01(squareness);
  return clamp(
    0.06 + 0.52 * square * grabbiness * brittleness * bitesIn * clamp(bite, 0.1, 2),
    0.03,
    0.68,
  );
}

/**
 * Apply one strike to one part. Mutates the part and reports what happened.
 *
 * Damage is the energy that actually coupled into the part, full stop. `bite` is
 * already inside `transferFraction` — it is the term that decides how much of the
 * incoming energy a sharp tooth gets *into* the target instead of skating off it —
 * and multiplying by it a second time here let a bite-2.0 weapon remove twice as
 * many armour-joules as the joules it delivered. Part HP is denominated in
 * absorbed joules, so that is not a balance knob, it is a broken accounting
 * identity: the panel was losing energy that the strike never carried.
 */
export function resolveHit(input: HitInput): HitResult {
  const { energy, bite, squareness, targetMaterial, plateThicknessMm, part } = input;
  const fraction = transferFraction(squareness, targetMaterial, bite);
  const energyTransferred = Math.max(0, energy) * fraction;
  const damage = energyTransferred;

  const before = part.hp;
  part.hp = Math.max(0, part.hp - damage);
  part.absorbed += energyTransferred;
  const consumed = before - part.hp;
  const destroyed = !part.destroyed && part.hp <= 0;
  if (destroyed) part.destroyed = true;

  // Severity is what the audience feels: a hit that eats a big slice of what was
  // left is a big hit, regardless of the absolute joules.
  const severity = clamp01(consumed / Math.max(1, part.maxHp * 0.28));

  // Ductility squared: compliance is what concentrates the load on the mountings,
  // and it does so faster than linearly.
  const rebuffed = Math.max(0, Math.max(0, energy) - energyTransferred);
  const shock =
    rebuffed * SHOCK_COUPLING * targetMaterial.ductility ** 2 * plateStiffness(plateThicknessMm);

  return {
    energyTransferred,
    damage: consumed,
    destroyed,
    severity,
    shock,
    shockConsumed: 0,
    part,
  };
}

// ---------------------------------------------------------------------------
// Whole-bot damage state
// ---------------------------------------------------------------------------

/** Seconds of no meaningful movement before the referee counts a bot out. */
export const IMMOBILITY_COUNT_SECONDS = 10;

/** A bot moving slower than this is considered not moving. */
export const IMMOBILE_SPEED = 0.35;

export interface BotDamageSnapshot {
  /** 0-1 across every part, weighted by max HP. */
  integrity: number;
  /** 0-1 fraction of drive still working. */
  mobility: number;
  /** 0-1 weapon condition; 0 means the weapon is dead. */
  weaponCondition: number;
  frameIntegrity: number;
  armorIntegrity: number;
  destroyedParts: string[];
  immobileFor: number;
  countedOut: boolean;
}

export class BotDamage {
  readonly parts: PartState[] = [];
  private byId = new Map<string, PartState>();
  private immobileTimer = 0;
  private _countedOut = false;
  private _totalDamageTaken = 0;

  constructor(stats: DerivedStats) {
    const { chassis } = stats.parts;

    this.add({
      id: 'frame',
      kind: 'frame',
      label: 'Frame',
      hp: stats.frameHp,
      maxHp: stats.frameHp,
      destroyed: false,
      absorbed: 0,
      detachable: false,
    });

    // Armour HP is split across faces. The front takes the beating in a real
    // fight, so it gets the biggest share of the plate.
    const faceShare: Record<ArmorFace, number> = {
      front: 0.3,
      left: 0.18,
      right: 0.18,
      rear: 0.14,
      top: 0.12,
      bottom: 0.08,
    };
    for (const [face, share] of Object.entries(faceShare) as [ArmorFace, number][]) {
      const hp = stats.armorHp * share;
      this.add({
        id: `armor-${face}`,
        kind: 'armor',
        label: `${face[0]!.toUpperCase()}${face.slice(1)} armour`,
        hp,
        maxHp: hp,
        destroyed: false,
        absorbed: 0,
        face,
        detachable: true,
      });
    }

    const wheelHp = stats.parts.wheel.toughness;
    for (let i = 0; i < stats.wheelCount; i++) {
      this.add({
        id: `wheel-${i}`,
        kind: 'wheel',
        label: `Wheel ${i + 1}`,
        hp: wheelHp,
        maxHp: wheelHp,
        destroyed: false,
        absorbed: 0,
        wheelIndex: i,
        detachable: true,
      });
    }

    // The weapon assembly is as tough as the frame it is bolted to, scaled by
    // how much metal is actually in it.
    const weaponHp = Math.max(4000, stats.weaponMass * 900 + stats.frameHp * 0.25);
    this.add({
      id: 'weapon',
      kind: 'weapon',
      label: stats.parts.weapon.name,
      hp: weaponHp,
      maxHp: weaponHp,
      destroyed: false,
      absorbed: 0,
      detachable: false,
    });

    if (stats.hasSrimech) {
      const hp = chassis.frameIntegrity * 0.18;
      this.add({
        id: 'srimech',
        kind: 'srimech',
        label: 'Self-righter',
        hp,
        maxHp: hp,
        destroyed: false,
        absorbed: 0,
        detachable: false,
      });
    }
  }

  private add(part: PartState): void {
    this.parts.push(part);
    this.byId.set(part.id, part);
  }

  get(id: string): PartState | undefined {
    return this.byId.get(id);
  }

  get totalDamageTaken(): number {
    return this._totalDamageTaken;
  }

  /** Armour on the given face, falling back to the frame once that panel is gone. */
  partForFace(face: ArmorFace): PartState {
    const armor = this.byId.get(`armor-${face}`);
    if (armor && !armor.destroyed) return armor;
    return this.byId.get('frame')!;
  }

  hit(input: Omit<HitInput, 'part'> & { part: PartState }): HitResult {
    const result = resolveHit(input);
    this._totalDamageTaken += result.damage;

    // Shock passes through the panel into the frame. Never enough on its own to
    // count as destroying the machine — a bent frame is a bound drivetrain, not a
    // knockout — so it floors at 1 rather than reaching zero.
    if (result.shock > 0 && result.part.kind === 'armor') {
      const frame = this.byId.get('frame');
      if (frame) {
        const before = frame.hp;
        frame.hp = Math.max(1, frame.hp - result.shock);
        const consumed = before - frame.hp;
        frame.absorbed += consumed;
        this._totalDamageTaken += consumed;
        // Reported back so the attacker can be charged for it, in both joules and
        // judges' points. Without this the shock was structural damage nobody
        // paid for and nobody was credited with.
        result.shockConsumed = consumed;
      }
    }
    return result;
  }

  /**
   * Blunt the machine's own weapon on a hard target.
   *
   * A spinner that hits hardened plate loses teeth; the same tooth in UHMW just
   * gouges a channel and comes out fine. This is what a dense, hard armour
   * package actually buys in the real sport — your plate is heavy and it is going
   * to get chewed, but their weapon is getting chewed at the same time. Without
   * it the only thing armour did was survive, and the lightest tough material won
   * by construction.
   */
  wearWeapon(joules: number): void {
    if (joules <= 0) return;
    const weapon = this.byId.get('weapon');
    if (!weapon || weapon.destroyed) return;
    weapon.hp = Math.max(0, weapon.hp - joules);
    weapon.absorbed += joules;
    if (weapon.hp <= 0) weapon.destroyed = true;
  }

  /**
   * Fraction of drive still turning. Losing wheels on one side hurts more.
   *
   * A folded frame binds the drivetrain: the wheels foul the armour, the gearbox
   * mounts go out of line, and the machine crawls long before it has lost a
   * wheel. That is what makes shock through the panels matter, and it is the
   * reason a plastic-armoured bot loses on a count-out with its armour intact.
   */
  get mobility(): number {
    const wheels = this.parts.filter((p) => p.kind === 'wheel');
    const drive = wheels.length === 0 ? 1 : wheels.filter((w) => !w.destroyed).length / wheels.length;
    return clamp01(drive * (0.3 + 0.7 * this.frameIntegrity));
  }

  get weaponCondition(): number {
    const weapon = this.byId.get('weapon');
    if (!weapon) return 0;
    return weapon.destroyed ? 0 : clamp01(weapon.hp / weapon.maxHp);
  }

  get srimechWorks(): boolean {
    const s = this.byId.get('srimech');
    return !!s && !s.destroyed;
  }

  get frameIntegrity(): number {
    const frame = this.byId.get('frame')!;
    return clamp01(frame.hp / frame.maxHp);
  }

  get armorIntegrity(): number {
    const panels = this.parts.filter((p) => p.kind === 'armor');
    if (panels.length === 0) return 0;
    const max = panels.reduce((s, p) => s + p.maxHp, 0);
    const hp = panels.reduce((s, p) => s + p.hp, 0);
    return max > 0 ? clamp01(hp / max) : 0;
  }

  /** Weighted health across the whole machine, 0-1. */
  get integrity(): number {
    const max = this.parts.reduce((s, p) => s + p.maxHp, 0);
    if (max <= 0) return 0;
    const hp = this.parts.reduce((s, p) => s + p.hp, 0);
    return clamp01(hp / max);
  }

  get countedOut(): boolean {
    return this._countedOut;
  }

  get immobileFor(): number {
    return this.immobileTimer;
  }

  /**
   * Advance the referee's immobility count. `speed` is the bot's ground speed and
   * `weaponActive` covers the rule that visible weapon movement keeps you alive.
   */
  tickMobility(dt: number, speed: number, weaponActive: boolean): void {
    const showingMovement = speed > IMMOBILE_SPEED || weaponActive;
    if (showingMovement) {
      this.immobileTimer = 0;
    } else {
      this.immobileTimer += dt;
      if (this.immobileTimer >= IMMOBILITY_COUNT_SECONDS) this._countedOut = true;
    }
  }

  /** Force the count, e.g. when a bot leaves the box or the frame folds. */
  countOut(): void {
    this._countedOut = true;
    this.immobileTimer = IMMOBILITY_COUNT_SECONDS;
  }

  /**
   * Physically wrecked: no drive left and no weapon left.
   *
   * Deliberately independent of the referee's count. `isDead` folds the two
   * together because most callers only want "is this machine finished", but the
   * knockout announcement has to tell them apart — a machine that stopped moving
   * and got counted out is a very different television moment from one that was
   * taken to pieces, and asking `isDead` there could only ever answer "destroyed".
   */
  get wrecked(): boolean {
    return this.mobility <= 0 && this.weaponCondition <= 0;
  }

  /** A bot with no drive and no weapon is done, count or no count. */
  get isDead(): boolean {
    return this._countedOut || this.wrecked;
  }

  snapshot(): BotDamageSnapshot {
    return {
      integrity: this.integrity,
      mobility: this.mobility,
      weaponCondition: this.weaponCondition,
      frameIntegrity: this.frameIntegrity,
      armorIntegrity: this.armorIntegrity,
      destroyedParts: this.parts.filter((p) => p.destroyed).map((p) => p.id),
      immobileFor: this.immobileTimer,
      countedOut: this._countedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

/**
 * Judges score damage, aggression and control. This mirrors the real 5-3-3 split:
 * damage is worth the most, then aggression and control equally.
 */
export interface JudgeTally {
  damage: number;
  aggression: number;
  control: number;
}

export const JUDGE_WEIGHTS = { damage: 5, aggression: 3, control: 3 } as const;

export interface JudgeCard {
  damage: [number, number];
  aggression: [number, number];
  control: [number, number];
  total: [number, number];
  winner: 0 | 1;
  unanimous: boolean;
  /** Both machines scored identically — the judges cannot separate them. */
  draw: boolean;
}

const splitPoints = (a: number, b: number, points: number): [number, number] => {
  const total = a + b;
  if (total <= 1e-6) {
    const half = points / 2;
    return [half, half];
  }
  // The category is never a straight ratio: a clear edge takes almost all of it.
  const share = a / total;
  const skewed = share ** 1.6 / (share ** 1.6 + (1 - share) ** 1.6);
  return [points * skewed, points * (1 - skewed)];
};

export function scoreJudges(a: JudgeTally, b: JudgeTally): JudgeCard {
  const damage = splitPoints(a.damage, b.damage, JUDGE_WEIGHTS.damage);
  const aggression = splitPoints(a.aggression, b.aggression, JUDGE_WEIGHTS.aggression);
  const control = splitPoints(a.control, b.control, JUDGE_WEIGHTS.control);

  const total: [number, number] = [
    damage[0] + aggression[0] + control[0],
    damage[1] + aggression[1] + control[1],
  ];
  const winner: 0 | 1 = total[0] >= total[1] ? 0 : 1;
  /*
   * A category only counts as won if it was actually won. Scoring `>=` for bot 0
   * meant a fight in which neither machine landed anything — both tallies zero,
   * so every category splits exactly down the middle — came back as a *unanimous
   * decision for bot 0*, which is the one verdict a 0-0 fight definitely is not.
   */
  const draw = Math.abs(total[0] - total[1]) < 1e-6;
  const categoriesWonByWinner = [damage, aggression, control].filter((c) =>
    winner === 0 ? c[0] > c[1] : c[1] > c[0],
  ).length;

  return {
    damage,
    aggression,
    control,
    total,
    winner,
    unanimous: !draw && categoriesWonByWinner === 3,
    draw,
  };
}
