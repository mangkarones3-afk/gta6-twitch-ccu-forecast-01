// gta6-twitch-ccu-forecast-01 — comparable-anchored quantile forecast of a launch day's hourly Twitch viewers.
//
// Method (fitted by leave-one-out over the comparable library inside each case; no practice outcome is used
// anywhere — the practice cases only sanity-check format and scale):
//
//   - Every comparable in the case is a past big launch with hourly counts from 14 days before its release day.
//     Its transferable object is its release-day ratio curve r_c(h) = ln y_c(h) - ln y_c(1), h = 2..24, in the
//     same UTC release-day coordinates the target is scored in. The launches share the rolling-midnight-local
//     unlock pattern (NZ wave the day before, UK at 00:00Z, US East at 05:00Z, US West at 08:00Z), so the waves
//     sit at the same day hours across launches; comparables whose unlock pattern differs (a single global
//     unlock time inside the day, or an early-access-contaminated release day) are classified from their
//     `unlock` research note and their day shape, and down-weighted when the target's pattern is not theirs.
//   - Location: L(h) = similarity-weighted median of {r_c(h)}, lightly smoothed across hours.
//   - Spread: the five levels are L(h) + offsets, where each offset blends the weighted empirical quantile of
//     the centred residuals {r_c(h) - L(h)} with a normal shape z_tau * sigma(h), sigma(h) the residuals'
//     IQR-implied scale smoothed across hours. A global spread multiplier and per-level offsets, fitted on
//     leave-one-out, correct the residual calibration.
//   - The forecast anchors on the case's own hour-1 print p: q_tau(h) = p * exp(L(h) + offset_tau(h)),
//     defended before writing: clamped into (0, 1e9], forced non-decreasing, exactly 23 rows.
//   - Any failure anywhere in the model falls back to the persistence baseline for that case, so a case is
//     never lost to a crash.
//
// Deterministic: no clock, no randomness, iteration only over input-order arrays and hour-sorted maps; two
// runs of a case write the same bytes. Node 22, standard library only, offline.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);
const HOUR_MS = 3_600_000;

/** Global calibration knobs, fitted by leave-one-out over the comparable library (see the build notes). */
export interface Knobs {
  /** Weight of a comparable whose unlock pattern is a single global unlock, when the target's is not. */
  kappaGlobal: number;
  /** Weight of an early-access-contaminated comparable, when the target is not one. */
  kappaEarly: number;
  /** Multiplier on the four outer levels' offsets. */
  spreadMult: number;
  /** Blend of the residuals' empirical quantiles vs the smooth normal shape: 1 = empirical only. */
  shrink: number;
  /** Per-level additive offsets in log space (the median's is fixed at 0). */
  delta: [number, number, number, number, number];
  /** Location smoothing across hours: 1 = none, 3 = [1,2,1]/4 moving average. */
  smoothL: number;
  /** Location estimator: 'median' (weighted median of ratios) or 'tmean' (10% trimmed weighted mean). */
  loc: 'median' | 'tmean';
  /** log(h1 / day peak) below which a comparable's day shape counts as a single-global-unlock shape. */
  psiGlobal: number;
  /** Bandwidth for down-weighting comparables far from the target's hour-1 scale; 0 = off. */
  scaleS: number;
}

export const KNOBS: Knobs = {
  kappaGlobal: 0.3,
  kappaEarly: 0.4,
  spreadMult: 0.85,
  shrink: 0.35,
  delta: [0.1, 0.05, 0, 0.05, 0.3],
  smoothL: 3,
  loc: 'median',
  psiGlobal: -3.2,
  scaleS: 0.75,
};

type UnlockClass = 'rolling' | 'global' | 'early';

interface HourlyRow {
  from: string;
  viewers: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  hourly: HourlyRow[];
}

interface CaseLike {
  levels?: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
  notes?: string;
}

/** One comparable's release day, extracted: hour (1..24) -> viewers, plus shape statistics. */
export interface DayCurve {
  /** viewers by hour 1..24; index 0 unused. Missing hours are interpolated in log space where possible. */
  y: Array<number | null>;
  h1: number;
  peak: number;
  /** log(h1 / peak): near 0 when the launch was already live at day start, very negative after a mid-day unlock. */
  psi: number;
  present: number;
}

const isPos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Extract a comparable's release-day curve. A comparable counts as a launch only when its hourly span starts
 * at least a week before its day_start (launch comparables carry about two weeks of pre-history; the case's
 * own target-history comparable, whose span starts on its first day, fails this by a wide margin) and the
 * day itself is nearly complete with a positive hour 1 to anchor on.
 */
export function extractDay(comp: Comparable): DayCurve | null {
  const day0 = Date.parse(comp.day_start);
  if (!Number.isFinite(day0) || comp.hourly.length === 0) return null;
  const first = Date.parse(comp.hourly[0]!.from);
  if (!Number.isFinite(first) || day0 - first < 7 * 24 * HOUR_MS) return null;
  const byHour = new Map<number, number>();
  for (const row of comp.hourly) {
    const t = Date.parse(row.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor((t - day0) / HOUR_MS) + 1;
    if (h >= 1 && h <= 24 && isPos(row.viewers)) byHour.set(h, row.viewers);
  }
  const h1 = byHour.get(1);
  if (h1 === undefined || byHour.size < 20) return null;
  const y: Array<number | null> = new Array(25).fill(null);
  for (const [h, v] of byHour) y[h] = v;
  // Fill gaps by log-linear interpolation between the nearest present neighbours inside the day.
  for (let h = 2; h <= 24; h++) {
    if (y[h] !== null) continue;
    let a = h - 1;
    while (a >= 1 && y[a] === null) a--;
    let b = h + 1;
    while (b <= 24 && y[b] === null) b++;
    if (a >= 1 && b <= 24 && y[a] !== null && y[b] !== null) {
      y[h] = Math.exp(Math.log(y[a]!) + ((Math.log(y[b]!) - Math.log(y[a]!)) * (h - a)) / (b - a));
    }
  }
  let peak = 0;
  for (let h = 1; h <= 24; h++) if (y[h] !== null && y[h]! > peak) peak = y[h]!;
  if (!(peak > 0)) return null;
  return { y, h1, peak, psi: Math.log(h1 / peak), present: byHour.size };
}

const GLOBAL_TEXT = /single global|simultaneous global|single simultaneous|simultaneous across|one global|global unlock|simultaneous.*unlock|unlock.*simultaneous/;

/** Classify a comparable's unlock pattern from its research note and its day shape. */
export function classifyComparable(comp: Comparable, day: DayCurve, knobs: Knobs): UnlockClass {
  const text = comp.unlock.toLowerCase();
  if (text.includes('early-access-contaminated') || text.includes('early access contaminated')) return 'early';
  if (day.psi < knobs.psiGlobal) return 'global';
  if (GLOBAL_TEXT.test(text) && !text.includes('midnight local')) return 'global';
  return 'rolling';
}

/** Classify the target's unlock pattern from the case's notes; every known target is a rolling launch. */
export function classifyTarget(notes: string | undefined): UnlockClass {
  const text = (notes ?? '').toLowerCase();
  if (text.includes('early-access-contaminated')) return 'early';
  if (GLOBAL_TEXT.test(text) && !text.includes('rolling')) return 'global';
  return 'rolling';
}

/** Weight of a comparable for a target of the given class. */
function classWeight(compClass: UnlockClass, targetClass: UnlockClass, knobs: Knobs): number {
  if (compClass === targetClass) return 1;
  if (compClass === 'early') return knobs.kappaEarly;
  if (compClass === 'global') return knobs.kappaGlobal;
  // A rolling comparable for a non-rolling target: symmetric treatment with the reverse mismatch.
  return targetClass === 'global' ? knobs.kappaGlobal : knobs.kappaEarly;
}

/** Weighted quantile of values (sorted copy made inside) at level tau, linear in cumulative weight. */
function weightedQuantile(values: number[], weights: number[], tau: number): number {
  const pairs = values.map((v, i) => ({ v, w: weights[i]! })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  if (total <= 0) return pairs.length > 0 ? pairs[pairs.length - 1]!.v : 0;
  const target = tau * total;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const prev = cum;
    cum += pairs[i]!.w;
    if (cum >= target) {
      if (i === 0) return pairs[0]!.v;
      const frac = (target - prev) / pairs[i]!.w;
      return pairs[i - 1]!.v + frac * (pairs[i]!.v - pairs[i - 1]!.v);
    }
  }
  return pairs[pairs.length - 1]!.v;
}

/** 10% trimmed weighted mean of the values. */
function trimmedMean(values: number[], weights: number[]): number {
  const lo = weightedQuantile(values, weights, 0.1);
  const hi = weightedQuantile(values, weights, 0.9);
  let sw = 0;
  let sv = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! >= lo && values[i]! <= hi) {
      sw += weights[i]!;
      sv += weights[i]! * values[i]!;
    }
  }
  return sw > 0 ? sv / sw : weightedQuantile(values, weights, 0.5);
}

interface PoolEntry {
  /** r[h] for h = 2..24 (index by hour), null where the comparable has no usable value. */
  r: Array<number | null>;
  w: number;
}

/** The persistence baseline's rows for a case: the fallback when the model cannot run. */
export function baselineHours(p1: number): Array<{ hour: number; q: number[] }> {
  const round2 = (x: number): number => Math.round(x * 100) / 100;
  return HOURS.map((h) => ({ hour: h, q: Z.map((z) => round2(p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1)))) }));
}

/** The model forecast of one case. Throws on unusable input; the caller falls back to the baseline. */
export function forecastCase(c: CaseLike, knobs: Knobs = KNOBS): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined || !Number.isFinite(first.viewers)) throw new Error('no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const targetClass = classifyTarget(c.notes);

  const pool: PoolEntry[] = [];
  for (const comp of c.comparables) {
    const day = extractDay(comp);
    if (day === null) continue;
    const cls = classifyComparable(comp, day, knobs);
    const r: Array<number | null> = new Array(25).fill(null);
    const logH1 = Math.log(day.h1);
    for (let h = 2; h <= 24; h++) if (isPos(day.y[h])) r[h] = Math.log(day.y[h]!) - logH1;
    let w = classWeight(cls, targetClass, knobs);
    if (knobs.scaleS > 0) w *= Math.exp(-Math.abs(logH1 - Math.log(p1)) / knobs.scaleS);
    pool.push({ r, w });
  }
  if (pool.length < 5) throw new Error('comparable pool too small');

  // Location per hour.
  const L = new Array<number>(25).fill(0);
  for (const h of HOURS) {
    const vals: number[] = [];
    const wts: number[] = [];
    for (const e of pool) if (e.r[h] !== null) { vals.push(e.r[h]!); wts.push(e.w); }
    if (vals.length === 0) throw new Error(`no comparable covers hour ${h}`);
    L[h] = knobs.loc === 'median' ? weightedQuantile(vals, wts, 0.5) : trimmedMean(vals, wts);
  }
  if (knobs.smoothL === 3) {
    const S = L.slice();
    for (const h of HOURS) {
      const a = h > 2 ? L[h - 1]! : L[h]!;
      const b = h < 24 ? L[h + 1]! : L[h]!;
      S[h] = (a + 2 * L[h]! + b) / 4;
    }
    for (const h of HOURS) L[h] = S[h]!;
  }

  // Residual quantiles and a smooth spread curve per hour.
  const empOff: Array<number[]> = new Array(25);
  const rawSigma = new Array<number>(25).fill(0.5);
  for (const h of HOURS) {
    const resid: number[] = [];
    const wts: number[] = [];
    for (const e of pool) if (e.r[h] !== null) { resid.push(e.r[h]! - L[h]!); wts.push(e.w); }
    empOff[h] = LEVELS.map((tau) => weightedQuantile(resid, wts, tau));
    const iqr = weightedQuantile(resid, wts, 0.75) - weightedQuantile(resid, wts, 0.25);
    rawSigma[h] = Math.max(0.05, iqr / (Z[3]! - Z[1]!));
  }
  // Smooth sigma across hours ([1,2,1]/4), then blend empirical and normal offsets.
  const sigma = new Array<number>(25).fill(0.5);
  for (const h of HOURS) {
    const a = rawSigma[h > 2 ? h - 1 : h]!;
    const b = rawSigma[h]!;
    const d = rawSigma[h < 24 ? h + 1 : h]!;
    sigma[h] = (a + 2 * b + d) / 4;
  }

  const round2 = (x: number): number => Math.round(x * 100) / 100;
  return HOURS.map((h) => {
    const emp = empOff[h]!;
    const q: number[] = [];
    for (let j = 0; j < LEVELS.length; j++) {
      const blended = knobs.shrink * emp[j]! + (1 - knobs.shrink) * Z[j]! * sigma[h]!;
      const off = j === 2 ? blended + knobs.delta[2]! : knobs.spreadMult * blended + knobs.delta[j]!;
      q.push(round2(Math.min(1e9, Math.max(1e-6, p1 * Math.exp(L[h]! + off)))));
    }
    for (let j = 1; j < q.length; j++) if (q[j]! < q[j - 1]!) q[j] = q[j - 1]!;
    return { hour: h, q };
  });
}

/** One case's output text: the model's forecast, or the baseline's if the model cannot run on it. */
export function caseOutput(c: CaseLike): string {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && Number.isFinite(first.viewers) ? first.viewers : 1);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    hours = forecastCase(c);
  } catch {
    hours = baselineHours(p1);
  }
  return `${JSON.stringify({ hours })}\n`;
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseLike;
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), caseOutput(c));
  }
}

// Run only when executed as the entrypoint, not when imported by the validation harness.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
