/**
 * The estimate behind the sidebar's progress bar (h #g247, h #g250, h #g251):
 * what a running turn is expected to take in all, and the band it is expected
 * to end in, read off this install's own record of finished turns
 * (`src/turn-history.ts`). Pure, and imported by the TUI bundle, so nothing
 * here logs or throws (h #g193).
 *
 * ## The model
 *
 * A turn's length is modelled as log-normal per agent and model: ln T is
 * normal with a mean μ and a spread σ. That is what a duration that runs from
 * thirty seconds to forty minutes under one key looks like, and it makes "a
 * factor of two either way" the natural unit of error. Both are the weighted
 * moments of the key's recorded turns in log space, each turn weighed by how
 * much it resembles this one:
 *
 *   - a Gaussian kernel on the log of the prompt's length (`CHARS_BANDWIDTH`:
 *     a prompt four times longer or shorter weighs e^-1/2, sixteen times e^-2);
 *   - `OTHER_EFFORT_WEIGHT` for a turn at another effort, whose duration is
 *     first scaled by the measured ratio between the two efforts' typical
 *     durations once the key holds `MIN_EFFORT_RATIO_SAMPLES` turns at each,
 *     because effort multiplies the thinking a turn does (h #g250);
 *   - recency, halving every `RECENCY_HALF_LIFE_MS`, so a CLI update or a
 *     machine change fades in days rather than the store's month.
 *
 * **Shrinkage, three levels with one rule.** A key with few turns borrows
 * from the same agent under other models: its mean and variance are pulled
 * toward that pool's with the weight of `SHRINKAGE_KAPPA` pseudo-turns, so a
 * new model under a known agent has a bar from its first turn, and a key with
 * a dozen turns of its own is nearly all its own. The pool's pull on the mean
 * is discounted by the pool's own size, κ·n/(n + κ), because a prior read off
 * one turn of another model is worth less than one read off forty: pulled
 * undiscounted, a single 200 s turn under another model put a five-turn key
 * of 40 s turns at 63 s, and the calibration carried that error on to every
 * other key's bar. With no pool the variance
 * alone is pulled toward `DEFAULT_LOG_SIGMA`, so three turns that happened to
 * agree do not claim a certainty they have not earned. Below the key, the
 * conversation: turns in one session resemble each other more than turns
 * across sessions (one session is a long refactor, another quick questions),
 * so the key's turns from THIS session are fitted on their own and shrunk
 * toward the key's fit by the same rule. One earlier turn of its own moves a
 * session's estimate a third of the way; a dozen make it nearly its own.
 * `MIN_TURN_SAMPLES` turns between the key and its pool are needed for a bar
 * at all, and a new agent waits for them: an agent is a kind of task and a
 * model a speed, and the record of a different kind of task says nothing a
 * spinner does not.
 *
 * **Conditioning.** At elapsed t the turn is known to be longer than t, so
 * every quantile is read off the distribution truncated there: with
 * F = C((ln t − μ)/σ) the share of such turns already over, the total's
 * quantile q is exp(μ + σ·C⁻¹(F + q·(1 − F))). Its median is the total
 * shown, its quarter and three-quarter points are the band. The total rises
 * as the turn outlasts more of the record instead of the bar sitting full;
 * past the key's longest recorded turn the estimate is `over`, the bar is
 * full in the warning colour and the total shown is the usual one. The
 * turn's progress so far narrows the record the same way: its tool calls
 * (h #g250), which the TUI counts off opencode's store, and the output
 * tokens its finished API calls have generated, which only the server half
 * can see and writes to a live channel as each call ends
 * (`src/turn-progress-store.ts`). The fit is redone over the recorded turns
 * that did at least as much of both, shrunk toward the unconditioned fit
 * with `CONDITIONED_KAPPA` pseudo-turns, fewer than the levels above use,
 * because that prior is known to run short for them: it holds the turns that
 * ended sooner. Output is compared only between turns at the same effort,
 * because effort is mostly how much a turn thinks, so a `low` turn's whole
 * output can be less than a `high` one's first call. A cut that would leave
 * no turn is not applied, so a turn on its fifth call on a key whose record
 * stops at four is still estimated from time rather than declared over at
 * ten seconds, which the h #g250 version did.
 *
 * **Calibration.** C is not the normal curve but the distribution of the
 * model's own standardized errors: every recorded turn estimated from the
 * rest of its key at its start (leave-one-out) gives a residual
 * (ln T − μ)/σ, and since residuals are dimensionless they pool across every
 * key, so a dozen turns anywhere in the store calibrate every bar. Each is
 * weighed by its turn's recency, as the fit weighs the turn: measured, the
 * misses on month-old turns, which the fit has moved away from, otherwise
 * pulled an estimate 15% under its own fit's median. The
 * measured distribution is smoothed with a Gaussian kernel (Silverman's
 * width), because a dozen raw residuals are a staircase with ties in it, and
 * it is blended with the normal curve, which counts as
 * `CALIBRATION_PRIOR_RESIDUALS` residuals: no threshold, the measured shape
 * takes over as the errors accrue. Whatever the log-normal gets wrong about
 * turn lengths, a bias, a spread or a skew, the band then shows what was
 * measured rather than what was assumed. The same leave-one-out estimates
 * are what `/claude-code-doctor` reports as the estimate's accuracy
 * (`assess`).
 *
 * What is NOT read: no model call, nothing from the prompt but its length,
 * and no token count from a finish, whose mid-turn usage repeats the previous
 * turn's reading (h #g169, h #g324): the output count comes through its own file.
 * A turn that ended on a failed tool result is skipped: its length says
 * nothing about a served turn's.
 */
import type { TurnHistory, TurnSample } from "./turn-history.js"

/** Turns between a key and its agent's pool before there is an estimate at all. */
export const MIN_TURN_SAMPLES = 3
/** The prompt-length kernel's bandwidth, in log-length: a factor of four is one standard deviation. */
export const CHARS_BANDWIDTH = Math.log(4)
/** What a sample at another effort weighs against one at the same. */
export const OTHER_EFFORT_WEIGHT = 0.5
/** Turns at each of two efforts before the ratio of their durations is measured and the other effort's scaled by it. */
export const MIN_EFFORT_RATIO_SAMPLES = 2
/** A sample's weight halves every week. */
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000
/** Recorded turns a progress cut (the calls so far) must leave before it is applied. */
export const MIN_CONDITIONED_SAMPLES = 1
/** The pseudo-turns a prior weighs against a key's own: with two of its own, a key is half its own. */
export const SHRINKAGE_KAPPA = 2
/** The same for a progress cut's prior, the unconditioned fit, which runs short for the turns the cut keeps. */
export const CONDITIONED_KAPPA = 1
/** The spread a key with no pool is pulled toward, in log space: a factor of about 2.2 either way. */
export const DEFAULT_LOG_SIGMA = 0.8
/** The narrowest and widest spread a fit may claim, in log space: about ×1.2 and ×5 either way. */
export const MIN_LOG_SIGMA = 0.2
export const MAX_LOG_SIGMA = 1.6
/** What the normal curve weighs in the calibration, in residuals: with twelve measured, the measured shape is half. */
export const CALIBRATION_PRIOR_RESIDUALS = 12
/** Leave-one-out estimates per key, the newest: enough to calibrate on and to judge by. */
export const MAX_ASSESSED_PER_KEY = 16
/** Residuals the calibration is fitted on at most, the newest keys' first. */
const MAX_CALIBRATION_RESIDUALS = 512
/** The calibration is tabulated on this grid of standardized errors; beyond it, it is the edge's value. */
const GRID_LOW = -8
const GRID_HIGH = 8
const GRID_STEP = 0.04
/** Added to both lengths before the log, so a one-word prompt is not infinitely far from an empty one. */
const CHARS_FLOOR = 50

export interface TurnEstimateBand {
  /** The total's quarter point: half the time the turn ends after this. */
  lowMs: number
  /** The total's three-quarter point: half the time the turn ends before this. */
  highMs: number
  /** Elapsed over `highMs`: the share of the bar the turn has surely covered. */
  sure: number
  /** Elapsed over `lowMs`, at most 1: the share it may have covered. */
  maybe: number
}

export interface TurnEstimate {
  /** What the whole turn is expected to take, elapsed included; once `over`, the usual duration. */
  totalMs: number
  /** Elapsed over that total, 0 to 1; 1 once past every recorded turn. */
  fill: number
  /** The turn has outlasted every recorded one of its key: nothing is left to condition on. */
  over: boolean
  /** Where the turn is expected to end, around the total; absent once over. */
  band?: TurnEstimateBand
}

export interface TurnEstimateInput {
  elapsedMs: number
  chars?: number
  effort?: string
  /** Tool calls the turn has made so far. */
  calls?: number
  /** Output tokens the turn's finished API calls have generated so far (the live channel). */
  out?: number
  /** The session's tag (`sessionTag`), so its own earlier turns weigh as the session level. */
  session?: string
  /** The clock the recency weights are read against; the model's build time by default. */
  now?: number
}

// ---------------------------------------------------------------------------
// The normal curve
// ---------------------------------------------------------------------------

/** Φ(z), Abramowitz and Stegun 26.2.17: within 7.5e-8 everywhere. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  const x = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * x)
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const tail = (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly
  return z >= 0 ? 1 - tail : tail
}

/** Φ⁻¹(p), Acklam's rational approximation: relative error under 1.2e-9. */
export function normalQuantile(p: number): number {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p))
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (q < low || q > 1 - low) {
    const r = Math.sqrt(-2 * Math.log(q < low ? q : 1 - q))
    const x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
    return q < low ? x : -x
  }
  const r = q - 0.5
  const s = r * r
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

// ---------------------------------------------------------------------------
// Weights, and the samples as the fit sees them
// ---------------------------------------------------------------------------

function charsWeight(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return 1
  const distance = Math.log((a + CHARS_FLOOR) / (b + CHARS_FLOOR)) / CHARS_BANDWIDTH
  return Math.exp(-0.5 * distance * distance)
}

function effortWeight(a: string | undefined, b: string | undefined): number {
  return a === undefined || b === undefined || a === b ? 1 : OTHER_EFFORT_WEIGHT
}

function recencyWeight(now: number, at: number): number {
  const age = Math.max(0, now - at)
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
}

/** The value at which the cumulative weight first reaches half the total. */
function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b])
  const total = order.reduce((sum, index) => sum + weights[index], 0)
  let cumulative = 0
  for (const index of order) {
    cumulative += weights[index]
    if (cumulative >= total / 2) return values[index]
  }
  return values[order[order.length - 1]]
}

/**
 * The factor each other effort's durations are scaled by before the fit: the
 * weighted median of this effort's turns over the weighted median of that
 * effort's, measured only once both groups hold `MIN_EFFORT_RATIO_SAMPLES`
 * (a ratio of one turn to one turn is noise), with the kernel and recency
 * weights on both medians so a group of long prompts is not read as a slow
 * effort. An effort with no measurable ratio is left as recorded, at
 * `OTHER_EFFORT_WEIGHT`; a sample with no effort is never scaled.
 */
function effortScales(samples: readonly TurnSample[], weights: readonly number[], effort: string | undefined): Map<string, number> {
  const scales = new Map<string, number>()
  if (effort === undefined) return scales
  const groups = new Map<string, number[]>()
  samples.forEach((sample, index) => {
    if (sample.effort === undefined) return
    const group = groups.get(sample.effort) ?? []
    group.push(index)
    groups.set(sample.effort, group)
  })
  const own = groups.get(effort)
  if (!own || own.length < MIN_EFFORT_RATIO_SAMPLES) return scales
  const medianOf = (indices: readonly number[]) =>
    weightedMedian(
      indices.map((index) => samples[index].ms),
      indices.map((index) => weights[index]),
    )
  const ownMedian = medianOf(own)
  for (const [other, indices] of groups) {
    if (other === effort || indices.length < MIN_EFFORT_RATIO_SAMPLES) continue
    const otherMedian = medianOf(indices)
    if (ownMedian > 0 && otherMedian > 0) scales.set(other, ownMedian / otherMedian)
  }
  return scales
}

interface Prepared {
  /** The duration, scaled to this turn's effort. */
  ms: number
  /** Its log, the model's unit. */
  y: number
  weight: number
  calls?: number
  out?: number
  /** Recorded at this turn's effort, or either effort unknown: its output count is comparable. */
  sameEffort: boolean
  session?: string
}

/** The samples the model reads: a usable duration, and not a turn that ended on a failure. */
function usableSamples(samples: readonly TurnSample[]): TurnSample[] {
  return samples.filter((sample) => Number.isFinite(sample.ms) && sample.ms >= 0 && !sample.failed)
}

function prepare(samples: readonly TurnSample[], input: { chars?: number; effort?: string }, now: number): Prepared[] {
  const usable = usableSamples(samples)
  const base = usable.map((sample) => charsWeight(input.chars, sample.chars) * recencyWeight(now, sample.at))
  const scales = effortScales(usable, base, input.effort)
  return usable.map((sample, index) => {
    const ms = sample.ms * (sample.effort !== undefined ? (scales.get(sample.effort) ?? 1) : 1)
    return {
      ms,
      y: Math.log(Math.max(1, ms)),
      weight: base[index] * effortWeight(input.effort, sample.effort),
      calls: sample.calls,
      out: sample.out,
      sameEffort: input.effort === undefined || sample.effort === undefined || input.effort === sample.effort,
      session: sample.session,
    }
  })
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

interface Moments {
  mean: number
  variance: number
  /** The effective count, (Σw)² / Σw²: six equal weights are six, one heavy and five light are nearer one. */
  n: number
}

function moments(set: readonly Prepared[]): Moments | undefined {
  let sumW = 0
  let sumW2 = 0
  let sumWY = 0
  for (const sample of set) {
    sumW += sample.weight
    sumW2 += sample.weight * sample.weight
    sumWY += sample.weight * sample.y
  }
  if (!(sumW > 0)) return undefined
  const mean = sumWY / sumW
  let sumWD = 0
  for (const sample of set) sumWD += sample.weight * (sample.y - mean) * (sample.y - mean)
  const n = (sumW * sumW) / sumW2
  const variance = n > 1 ? (sumWD / sumW) * (n / (n - 1)) : 0
  return { mean, variance, n }
}

export interface LogNormalFit {
  mu: number
  sigma: number
}

/**
 * A key's moments pulled toward a prior: the mean toward the prior's mean
 * (its own, with no prior) with `meanKappa` pseudo-turns, the variance toward
 * the prior's variance (`DEFAULT_LOG_SIGMA` squared, with none) with `kappa`,
 * σ then clamped. No moments at all is the prior alone.
 */
function shrink(
  own: Moments | undefined,
  prior: LogNormalFit | undefined,
  kappa = SHRINKAGE_KAPPA,
  meanKappa = kappa,
): LogNormalFit | undefined {
  if (!own) return prior
  const priorMu = prior?.mu ?? own.mean
  const priorVariance = prior ? prior.sigma * prior.sigma : DEFAULT_LOG_SIGMA * DEFAULT_LOG_SIGMA
  const mu = (own.n * own.mean + meanKappa * priorMu) / (own.n + meanKappa)
  const variance = (own.n * own.variance + kappa * priorVariance) / (own.n + kappa)
  return { mu, sigma: Math.min(MAX_LOG_SIGMA, Math.max(MIN_LOG_SIGMA, Math.sqrt(Math.max(0, variance)))) }
}

interface Pool {
  fit?: LogNormalFit
  count: number
  /** The pool's effective count, which discounts its pull on a key's mean. */
  n: number
}

/**
 * The same agent's turns under every other model, at this effort's scale and
 * weighed by recency, without the prompt-length kernel: the pool is a prior
 * worth `SHRINKAGE_KAPPA` turns, which the kernel's precision would not
 * change, and without it the pool depends on the effort alone and is built
 * once per key and effort (`buildTurnModel`) instead of once per estimate.
 */
function agentPool(history: TurnHistory, key: string, effort: string | undefined, now: number): Pool {
  const slash = key.indexOf("/")
  if (slash < 0) return { count: 0, n: 0 }
  const prefix = key.slice(0, slash + 1)
  const pool: Prepared[] = []
  for (const [other, samples] of history) {
    if (other === key || !other.startsWith(prefix)) continue
    pool.push(...prepare(samples, { effort }, now))
  }
  const measured = moments(pool)
  return { fit: shrink(measured, undefined), count: pool.length, n: measured?.n ?? 0 }
}

interface KeyFit {
  /** The fit the estimate is read from, the turn's progress conditioned in. */
  fit: LogNormalFit
  /** The session's (else the key's) unconditioned fit: what an `over` turn shows as the usual. */
  usual: LogNormalFit
  /** The key's longest recorded duration at this effort; infinite with no record of its own. */
  maxMs: number
}

function fitKey(
  own: readonly Prepared[],
  pool: Pool,
  input: { calls?: number; out?: number; session?: string },
): KeyFit | undefined {
  if (own.length + pool.count < MIN_TURN_SAMPLES) return undefined
  const poolPull = pool.fit ? (SHRINKAGE_KAPPA * pool.n) / (pool.n + SHRINKAGE_KAPPA) : SHRINKAGE_KAPPA
  const key = shrink(moments(own), pool.fit, SHRINKAGE_KAPPA, poolPull)
  if (!key) return undefined
  // The session level: this conversation's own turns, shrunk toward the key
  // by the same rule the key is shrunk toward its pool.
  const mine = input.session === undefined ? [] : own.filter((sample) => sample.session === input.session)
  const usual = mine.length > 0 ? (shrink(moments(mine), key) ?? key) : key
  // The turn's progress so far: a recorded turn that made fewer calls, or
  // generated less output at this effort, ended before this one could.
  const calls = input.calls !== undefined && input.calls > 0 ? input.calls : undefined
  const out = input.out !== undefined && input.out > 0 ? input.out : undefined
  let fit = usual
  if (calls !== undefined || out !== undefined) {
    const kept = own.filter(
      (sample) =>
        (calls === undefined || sample.calls === undefined || sample.calls >= calls) &&
        (out === undefined || sample.out === undefined || !sample.sameEffort || sample.out >= out),
    )
    if (kept.length < own.length && kept.length >= MIN_CONDITIONED_SAMPLES) {
      fit = shrink(moments(kept), usual, CONDITIONED_KAPPA) ?? usual
    }
  }
  const maxMs = own.length > 0 ? own.reduce((longest, sample) => Math.max(longest, sample.ms), 0) : Number.POSITIVE_INFINITY
  return { fit, usual, maxMs }
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface Calibration {
  /** Residuals it was fitted on; 0 for the normal curve itself. */
  readonly count: number
  /** What the measured shape weighs against the normal curve, 0 to 1. */
  readonly weight: number
  cdf(z: number): number
  quantile(p: number): number
}

export const NORMAL_CALIBRATION: Calibration = { count: 0, weight: 0, cdf: normalCdf, quantile: normalQuantile }

/**
 * The q-quantile of weighted values sorted by value: each value sits at the
 * middle of its own weight on the cumulative scale, linear between them.
 */
function weightedQuantile(sorted: ReadonlyArray<{ value: number; weight: number }>, total: number, q: number): number {
  let cumulative = 0
  let previous: { value: number; at: number } | undefined
  for (const entry of sorted) {
    const at = (cumulative + entry.weight / 2) / total
    cumulative += entry.weight
    if (at >= q) {
      if (!previous) return entry.value
      return previous.value + ((q - previous.at) / (at - previous.at)) * (entry.value - previous.value)
    }
    previous = { value: entry.value, at }
  }
  return sorted[sorted.length - 1].value
}

/**
 * The calibration from leave-one-out residuals: their distribution smoothed
 * with a Gaussian kernel of Silverman's width, 0.9 · min(sd, IQR/1.349) ·
 * n^(-1/5), blended with the normal curve weighing
 * `CALIBRATION_PRIOR_RESIDUALS`, and tabulated on a grid so a cdf or a
 * quantile is a lookup and the TUI's tick never sums the residuals. Each
 * residual may carry a weight, the recency of the turn it measured, because
 * the fit prefers recent turns and an old turn's miss says how the model did
 * on behaviour it has since moved away from; n is then the effective count.
 * Every term is an increasing curve and the normal one strictly so, which
 * makes the table strictly increasing and each lookup the other's inverse to
 * the grid's resolution. No residuals is the normal curve itself.
 */
export function calibrationFrom(residuals: readonly number[], weights?: readonly number[]): Calibration {
  const entries = residuals
    .map((value, index) => ({ value, weight: weights?.[index] ?? 1 }))
    .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0)
    .slice(-MAX_CALIBRATION_RESIDUALS)
  if (entries.length === 0) return NORMAL_CALIBRATION
  let total = 0
  let squares = 0
  let sum = 0
  for (const entry of entries) {
    total += entry.weight
    squares += entry.weight * entry.weight
    sum += entry.weight * entry.value
  }
  const n = (total * total) / squares
  const mean = sum / total
  let deviation = 0
  for (const entry of entries) deviation += entry.weight * (entry.value - mean) * (entry.value - mean)
  const sd = n > 1 ? Math.sqrt((deviation / total) * (n / (n - 1))) : 0
  const sorted = [...entries].sort((a, b) => a.value - b.value)
  const iqr = weightedQuantile(sorted, total, 0.75) - weightedQuantile(sorted, total, 0.25)
  const spreads = [sd, iqr / 1.349].filter((spread) => spread > 0)
  const spread = spreads.length > 0 ? Math.min(...spreads) : 1
  const width = Math.max(0.1, 0.9 * spread * Math.pow(n, -0.2))
  const weight = n / (n + CALIBRATION_PRIOR_RESIDUALS)
  const size = Math.round((GRID_HIGH - GRID_LOW) / GRID_STEP) + 1
  const table = new Float64Array(size)
  for (let index = 0; index < size; index += 1) {
    const z = GRID_LOW + index * GRID_STEP
    let kernel = 0
    for (const entry of entries) kernel += entry.weight * normalCdf((z - entry.value) / width)
    table[index] = weight * (kernel / total) + (1 - weight) * normalCdf(z)
  }
  return {
    count: entries.length,
    weight,
    cdf(z) {
      if (Number.isNaN(z)) return 0.5
      const position = (Math.min(GRID_HIGH, Math.max(GRID_LOW, z)) - GRID_LOW) / GRID_STEP
      const index = Math.min(size - 2, Math.floor(position))
      return table[index] + (position - index) * (table[index + 1] - table[index])
    },
    quantile(p) {
      if (!(p > table[0])) return GRID_LOW
      if (!(p < table[size - 1])) return GRID_HIGH
      // table[low] < p <= table[high], narrowed to one step.
      let low = 0
      let high = size - 1
      while (high - low > 1) {
        const mid = (low + high) >> 1
        if (table[mid] < p) low = mid
        else high = mid
      }
      const span = table[high] - table[low]
      return GRID_LOW + (low + (span > 0 ? (p - table[low]) / span : 1)) * GRID_STEP
    },
  }
}

/** The total's quantile q, given the turn has already run `truncatedAtMs`. */
function quantileMs(fit: LogNormalFit, calibration: Calibration, truncatedAtMs: number, q: number): number {
  const passed = truncatedAtMs > 0 ? calibration.cdf((Math.log(truncatedAtMs) - fit.mu) / fit.sigma) : 0
  return Math.exp(fit.mu + fit.sigma * calibration.quantile(passed + q * (1 - passed)))
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface TurnKeyAssessment {
  key: string
  /** Recorded turns the estimate reads, failed ones excluded. */
  turns: number
  failed: number
  /** The plain median of those turns. */
  typicalMs: number
  /** Turns estimated from the rest of their key at their start, the newest `MAX_ASSESSED_PER_KEY`. */
  assessed: number
  /** The median factor between the estimate and the actual, either way: ×1.6 means "typically off by 60%". */
  missFactor?: number
  /** The share of assessed turns that outran their estimate; one half is unbiased. */
  overShare?: number
  /** The share that ended inside the band; one half is calibrated. */
  inBandShare?: number
}

export interface TurnEstimateAssessment {
  /** Every key in the store, most turns first. */
  keys: TurnKeyAssessment[]
  /** Leave-one-out residuals the calibration was fitted on, over every key. */
  residuals: number
  /** What their measured shape weighs against the normal curve, 0 to 1. */
  calibrationWeight: number
}

export interface TurnModel {
  /** What a turn on `key` is expected to take, or undefined with too little record. */
  estimate(key: string, input: TurnEstimateInput): TurnEstimate | undefined
  readonly calibration: Calibration
  /** How the model has done on the turns it has, for `/claude-code-doctor`. */
  assess(): TurnEstimateAssessment
}

const EMPTY_HISTORY: TurnHistory = new Map()

/**
 * The model over a whole store, built once per change to it: the leave-one-out
 * estimates and the calibration are computed here, so an estimate is one
 * weighted fit and a few evaluations of the curve.
 */
export function buildTurnModel(history: TurnHistory = EMPTY_HISTORY, now: number = Date.now()): TurnModel {
  const pools = new Map<string, Pool>()
  const poolFor = (key: string, effort: string | undefined): Pool => {
    const id = `${key}\u0000${effort ?? ""}`
    let pool = pools.get(id)
    if (!pool) {
      pool = agentPool(history, key, effort, now)
      pools.set(id, pool)
    }
    return pool
  }
  const assessed = new Map<string, Array<{ ms: number; fit: LogNormalFit }>>()
  const residuals: number[] = []
  const residualWeights: number[] = []
  for (const [key, samples] of history) {
    const usable = usableSamples(samples)
    if (usable.length < 2) continue
    const rows: Array<{ ms: number; fit: LogNormalFit }> = []
    for (const held of usable.slice(-MAX_ASSESSED_PER_KEY)) {
      const input = { chars: held.chars, effort: held.effort, session: held.session }
      const own = prepare(
        usable.filter((sample) => sample !== held),
        input,
        now,
      )
      const fitted = fitKey(own, poolFor(key, held.effort), input)
      if (!fitted) continue
      rows.push({ ms: held.ms, fit: fitted.fit })
      residuals.push((Math.log(Math.max(1, held.ms)) - fitted.fit.mu) / fitted.fit.sigma)
      residualWeights.push(recencyWeight(now, held.at))
    }
    if (rows.length > 0) assessed.set(key, rows)
  }
  const calibration = calibrationFrom(residuals, residualWeights)

  const estimate = (key: string, input: TurnEstimateInput): TurnEstimate | undefined => {
    const at = input.now ?? now
    const own = prepare(history.get(key) ?? [], input, at)
    const fitted = fitKey(own, poolFor(key, input.effort), input)
    if (!fitted) return undefined
    const elapsed = Math.max(0, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0)
    if (elapsed > fitted.maxMs) {
      return { totalMs: quantileMs(fitted.usual, calibration, 0, 0.5), fill: 1, over: true }
    }
    const totalMs = Math.max(elapsed, quantileMs(fitted.fit, calibration, elapsed, 0.5))
    const lowMs = Math.min(totalMs, Math.max(elapsed, quantileMs(fitted.fit, calibration, elapsed, 0.25)))
    const highMs = Math.max(totalMs, quantileMs(fitted.fit, calibration, elapsed, 0.75))
    return {
      totalMs,
      fill: totalMs > 0 ? elapsed / totalMs : 0,
      over: false,
      band: {
        lowMs,
        highMs,
        sure: highMs > 0 ? elapsed / highMs : 0,
        maybe: lowMs > 0 ? Math.min(1, elapsed / lowMs) : 0,
      },
    }
  }

  const assess = (): TurnEstimateAssessment => {
    const keys: TurnKeyAssessment[] = []
    for (const [key, samples] of history) {
      const usable = usableSamples(samples)
      const failed = samples.filter((sample) => sample.failed).length
      if (usable.length === 0 && failed === 0) continue
      const durations = usable.map((sample) => sample.ms).sort((a, b) => a - b)
      const typicalMs = durations.length > 0 ? durations[Math.floor((durations.length - 1) / 2)] : 0
      const rows = assessed.get(key) ?? []
      const misses: number[] = []
      let over = 0
      let inBand = 0
      for (const row of rows) {
        const expected = Math.exp(row.fit.mu + row.fit.sigma * calibration.quantile(0.5))
        const low = Math.exp(row.fit.mu + row.fit.sigma * calibration.quantile(0.25))
        const high = Math.exp(row.fit.mu + row.fit.sigma * calibration.quantile(0.75))
        misses.push(Math.abs(Math.log(Math.max(1, row.ms) / expected)))
        if (row.ms > expected) over += 1
        if (row.ms >= low && row.ms <= high) inBand += 1
      }
      misses.sort((a, b) => a - b)
      keys.push({
        key,
        turns: usable.length,
        failed,
        typicalMs,
        assessed: rows.length,
        ...(rows.length > 0
          ? {
              missFactor: Math.exp(misses[Math.floor((misses.length - 1) / 2)]),
              overShare: over / rows.length,
              inBandShare: inBand / rows.length,
            }
          : {}),
      })
    }
    keys.sort((a, b) => b.turns - a.turns || a.key.localeCompare(b.key))
    return { keys, residuals: residuals.length, calibrationWeight: calibration.weight }
  }

  return { estimate, calibration, assess }
}

/**
 * What a turn that has run `elapsedMs` is expected to take in all, given the
 * recorded turns of its agent and model alone: the model over one key, which
 * has no pool to borrow from and calibrates only on itself. The TUI builds
 * the model over the whole store instead (`buildTurnModel`).
 */
export function estimateTurn(samples: readonly TurnSample[], input: TurnEstimateInput): TurnEstimate | undefined {
  return buildTurnModel(new Map([["turn/model", [...samples]]]), input.now ?? Date.now()).estimate("turn/model", input)
}
