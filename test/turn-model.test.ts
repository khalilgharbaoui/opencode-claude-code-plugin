/**
 * The progress estimate's model (h #g251): the normal curve's two
 * approximations; what a fit recovers from turns drawn from a known
 * log-normal; the conditioning on elapsed time and on the turn's calls; the
 * effort ratio, the prompt-length kernel and recency; the three shrinkage
 * levels (the agent's other models, the key, the session); the calibration,
 * its blending and its table; the band; the `over` state; and the doctor's
 * leave-one-out assessment. Turns are built from exact quantiles, never from
 * a random draw, so every expectation is the distribution's own number.
 */
import "./isolate.js"
import assert from "node:assert/strict"
import { test } from "node:test"

import type { TurnHistory, TurnSample } from "../src/turn-history.js"
import {
  CALIBRATION_PRIOR_RESIDUALS,
  MIN_TURN_SAMPLES,
  NORMAL_CALIBRATION,
  RECENCY_HALF_LIFE_MS,
  buildTurnModel,
  calibrationFrom,
  estimateTurn,
  normalCdf,
  normalQuantile,
  type TurnEstimate,
} from "../src/turn-model.js"

const NOW = 1_800_000_000_000
const sample = (ms: number, over: Partial<TurnSample> = {}): TurnSample => ({ ms, at: NOW, ...over })
const seconds = (value: number) => value * 1000

function close(actual: number | undefined, expected: number, relative: number, message = ""): void {
  assert.ok(actual !== undefined, `${message}: no value`)
  assert.ok(
    Math.abs(actual - expected) <= relative * Math.abs(expected),
    `${message}: ${actual} is not within ${relative * 100}% of ${expected}`,
  )
}

/**
 * Turns drawn from a log-normal with this median and spread, as its exact
 * quantiles, in an order that is not sorted: the model assesses the newest
 * turns, and sorted ones would make the newest the longest. Needs n coprime
 * with 17.
 */
function logNormalTurns(medianMs: number, sigma: number, n: number, over: Partial<TurnSample> = {}): TurnSample[] {
  return Array.from({ length: n }, (_, index) =>
    sample(medianMs * Math.exp(sigma * normalQuantile((((index * 17) % n) + 0.5) / n)), over),
  )
}

/** The band's own invariants: the total inside it, the sure share under the fill and the maybe share over it. */
function assertBandHolds(estimate: TurnEstimate | undefined, elapsedMs: number, message: string): void {
  assert.ok(estimate?.band, `${message}: a band`)
  const { band } = estimate
  assert.ok(band.lowMs <= estimate.totalMs && estimate.totalMs <= band.highMs, `${message}: the total inside the band`)
  assert.ok(band.lowMs >= elapsedMs, `${message}: the band starts no earlier than now`)
  assert.ok(band.sure <= estimate.fill && estimate.fill <= band.maybe && band.maybe <= 1, `${message}: sure <= fill <= maybe <= 1`)
}

test("the normal curve's two approximations agree with known values and invert each other", () => {
  close(normalCdf(0), 0.5, 1e-8, "Φ(0)")
  close(normalCdf(1.959964), 0.975, 1e-6, "Φ(1.96)")
  close(normalCdf(-1), 0.158655, 1e-5, "Φ(-1)")
  close(normalQuantile(0.975), 1.959964, 1e-6, "Φ⁻¹(0.975)")
  close(normalQuantile(0.25), -0.67449, 1e-5, "Φ⁻¹(0.25)")
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-12)
  for (const p of [0.001, 0.02, 0.3, 0.5, 0.8, 0.99, 0.9999]) {
    assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-6, `round trip at ${p}`)
  }
  assert.equal(normalCdf(Number.POSITIVE_INFINITY), 1)
  assert.equal(normalCdf(Number.NEGATIVE_INFINITY), 0)
  assert.ok(Number.isFinite(normalQuantile(0)) && Number.isFinite(normalQuantile(1)), "the ends are clamped, not infinite")
})

test("a fit recovers a known log-normal's median and quartiles from turns drawn from it", () => {
  // A minute, a factor of e^0.5 either way: quartiles at 42.8 s and 84.1 s.
  const minute = estimateTurn(logNormalTurns(seconds(60), 0.5, 40), { elapsedMs: 0, now: NOW })
  close(minute?.totalMs, seconds(60), 0.05, "the median")
  close(minute?.band?.lowMs, seconds(60) * Math.exp(-0.6745 * 0.5), 0.08, "the lower quartile")
  close(minute?.band?.highMs, seconds(60) * Math.exp(0.6745 * 0.5), 0.08, "the upper quartile")
  assert.equal(minute?.fill, 0)
  assert.equal(minute?.over, false)
  // Five minutes, a factor of e either way: quartiles at 2m33s and 9m49s.
  const wide = estimateTurn(logNormalTurns(seconds(300), 1, 41), { elapsedMs: 0, now: NOW })
  close(wide?.totalMs, seconds(300), 0.08, "the wide median")
  close(wide?.band?.lowMs, seconds(300) * Math.exp(-0.6745), 0.12, "the wide lower quartile")
  close(wide?.band?.highMs, seconds(300) * Math.exp(0.6745), 0.12, "the wide upper quartile")
})

test("the estimate is conditioned on how long the turn has run, and past the longest recorded turn it is over", () => {
  assert.equal(MIN_TURN_SAMPLES, 3)
  const samples = [sample(seconds(20)), sample(seconds(60)), sample(seconds(100))]
  // At the start, the log-normal's median: the geometric mean, 49.3 s.
  const start = estimateTurn(samples, { elapsedMs: 0, now: NOW })
  close(start?.totalMs, Math.cbrt(20 * 60 * 100) * 1000, 0.02, "the median at the start")
  assertBandHolds(start, 0, "at the start")
  // As the turn runs, the total rises and stays ahead of the elapsed, and the
  // bar fills without ever being full.
  let previous = 0
  for (const elapsed of [10, 30, 70, 99].map(seconds)) {
    const estimate = estimateTurn(samples, { elapsedMs: elapsed, now: NOW })
    assert.equal(estimate?.over, false, `not over at ${elapsed}`)
    assert.ok(estimate!.totalMs > elapsed, `the total is ahead of the elapsed at ${elapsed}`)
    assert.ok(estimate!.totalMs >= previous, `the total never falls: ${estimate!.totalMs} after ${previous}`)
    assert.ok(estimate!.fill > 0 && estimate!.fill < 1)
    assertBandHolds(estimate, elapsed, `at ${elapsed}`)
    previous = estimate!.totalMs
  }
  // Past the longest recorded turn there is nothing left to condition on:
  // full, over, the usual duration shown, no band.
  const over = estimateTurn(samples, { elapsedMs: seconds(120), now: NOW })
  assert.equal(over?.over, true)
  assert.equal(over?.fill, 1)
  assert.equal(over?.band, undefined)
  close(over?.totalMs, start!.totalMs, 1e-9, "the usual duration")
  // A negative or unusable elapsed is the start.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: -5, now: NOW }), start)
  assert.deepEqual(estimateTurn(samples, { elapsedMs: Number.NaN, now: NOW }), start)
})

test("fewer than MIN_TURN_SAMPLES usable turns is no estimate, and a turn that ended on a failed tool is neither counted nor read", () => {
  const samples = [sample(seconds(20)), sample(seconds(60)), sample(seconds(100))]
  assert.equal(estimateTurn(samples.slice(0, 2), { elapsedMs: 0, now: NOW }), undefined)
  assert.equal(estimateTurn([...samples.slice(0, 2), sample(Number.NaN)], { elapsedMs: 0, now: NOW }), undefined)
  assert.equal(estimateTurn([...samples.slice(0, 2), sample(seconds(6), { failed: true })], { elapsedMs: 0, now: NOW }), undefined)
  assert.deepEqual(
    estimateTurn([sample(seconds(6), { failed: true }), ...samples], { elapsedMs: seconds(10), now: NOW }),
    estimateTurn(samples, { elapsedMs: seconds(10), now: NOW }),
  )
})

test("the estimate weighs toward turns whose prompt was about this long", () => {
  const samples = [
    sample(seconds(10), { chars: 10 }),
    sample(seconds(10), { chars: 10 }),
    sample(seconds(100), { chars: 10_000 }),
    sample(seconds(100), { chars: 10_000 }),
  ]
  const short = estimateTurn(samples, { elapsedMs: 0, chars: 10, now: NOW })!.totalMs
  const long = estimateTurn(samples, { elapsedMs: 0, chars: 10_000, now: NOW })!.totalMs
  const unknown = estimateTurn(samples, { elapsedMs: 0, now: NOW })!.totalMs
  assert.ok(short < seconds(15), `a short prompt reads the short turns: ${short}`)
  assert.ok(long > seconds(66), `a long prompt reads the long turns: ${long}`)
  // A prompt of unknown length weighs every turn alike: the geometric mean.
  close(unknown, seconds(Math.sqrt(10 * 100)), 0.1, "an unknown length")
  // A turn of unknown length weighs like a match.
  const unrecorded = [sample(seconds(10)), sample(seconds(10)), sample(seconds(100), { chars: 10 })]
  close(
    estimateTurn(unrecorded, { elapsedMs: 0, chars: 10, now: NOW })?.totalMs,
    estimateTurn(unrecorded, { elapsedMs: 0, now: NOW })!.totalMs,
    1e-9,
    "an unrecorded length",
  )
})

test("another effort weighs half, and once two turns at each effort are on record its durations are scaled by the measured ratio", () => {
  // A key full of `low` turns and two `high` ones: the `low` durations are
  // stretched by the measured ratio (100 s over 10 s), so a `high` turn is
  // expected to take about 100 s, and a `low` one about 10 s.
  const mostlyLow = [
    ...Array.from({ length: 6 }, () => sample(seconds(10), { effort: "low" })),
    sample(seconds(100), { effort: "high" }),
    sample(seconds(100), { effort: "high" }),
  ]
  close(estimateTurn(mostlyLow, { elapsedMs: 0, effort: "high", now: NOW })?.totalMs, seconds(100), 0.05, "a high turn")
  close(estimateTurn(mostlyLow, { elapsedMs: 0, effort: "low", now: NOW })?.totalMs, seconds(10), 0.05, "a low turn")
  // One `low` turn is no ratio: the `high` turns count at half weight, as
  // recorded, and pull a `low` turn's estimate up from its one sample.
  const oneLow = [sample(seconds(10), { effort: "low" }), sample(seconds(100), { effort: "high" }), sample(seconds(100), { effort: "high" })]
  const lowTurn = estimateTurn(oneLow, { elapsedMs: 0, effort: "low", now: NOW })!.totalMs
  const highTurn = estimateTurn(oneLow, { elapsedMs: 0, effort: "high", now: NOW })!.totalMs
  assert.ok(lowTurn > seconds(10) && lowTurn < highTurn && highTurn < seconds(100), `${lowTurn} < ${highTurn}`)
  // An unknown effort scales nothing and weighs every turn alike.
  const unknown = estimateTurn(mostlyLow, { elapsedMs: 0, now: NOW })!.totalMs
  assert.ok(unknown > seconds(10) && unknown < seconds(40), `an unknown effort: ${unknown}`)
})

test("the turn's tool calls narrow the record, and a turn past every recorded count is estimated from time alone", () => {
  const samples = [sample(seconds(20), { calls: 1 }), sample(seconds(60), { calls: 3 }), sample(seconds(100), { calls: 8 })]
  const byTime = estimateTurn(samples, { elapsedMs: seconds(10), now: NOW })!
  // No call yet, or none counted: time alone.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(10), calls: 0, now: NOW }), byTime)
  // On its fourth call only the eight-call turn is left to be like: the
  // estimate moves toward it, shrunk toward the unconditioned fit.
  const fourth = estimateTurn(samples, { elapsedMs: seconds(10), calls: 4, now: NOW })!
  assert.ok(fourth.totalMs > byTime.totalMs && fourth.totalMs < seconds(100), `${fourth.totalMs} between ${byTime.totalMs} and 100 s`)
  assert.equal(fourth.over, false)
  // Past every recorded count is not over (the h #g250 version said over at
  // ten seconds): nothing narrows, so the estimate is time's.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(10), calls: 9, now: NOW }), byTime)
  // A turn recorded before calls were counted survives every cut.
  const older = [sample(seconds(20)), sample(seconds(60), { calls: 3 }), sample(seconds(100), { calls: 8 })]
  const olderFourth = estimateTurn(older, { elapsedMs: seconds(10), calls: 4, now: NOW })!
  const olderByTime = estimateTurn(older, { elapsedMs: seconds(10), now: NOW })!
  assert.ok(olderFourth.totalMs > olderByTime.totalMs, "the 20 s turn of unknown count is kept, the 60 s one cut")
})

test("the output the turn has generated narrows the record like its calls, together with them, and only against turns at the same effort", () => {
  const samples = [
    sample(seconds(20), { out: 1_000, effort: "high" }),
    sample(seconds(60), { out: 4_000, effort: "high" }),
    sample(seconds(100), { out: 12_000, effort: "high" }),
  ]
  const input = { elapsedMs: seconds(10), effort: "high", now: NOW }
  const byTime = estimateTurn(samples, input)!
  assert.deepEqual(estimateTurn(samples, { ...input, out: 0 }), byTime, "no output yet is time alone")
  // 5,000 tokens in, only the 12,000-token turn is left to be like.
  const busy = estimateTurn(samples, { ...input, out: 5_000 })!
  assert.ok(busy.totalMs > byTime.totalMs && busy.totalMs < seconds(100), `${busy.totalMs} between ${byTime.totalMs} and 100 s`)
  assert.deepEqual(estimateTurn(samples, { ...input, out: 50_000 }), byTime, "past every recorded output, time alone")
  // Calls and output cut together: a recorded turn must have done at least
  // as much of both. Here calls keep the 20 s and 100 s turns and output the
  // 60 s and 100 s ones, which leaves the one the 5,000-token cut left.
  const counted = samples.map((turn, index) => ({ ...turn, calls: [5, 1, 9][index] }))
  assert.deepEqual(estimateTurn(counted, { ...input, calls: 2, out: 2_000 }), busy)
  // Another effort's output is never compared: a `low` turn's whole output
  // can be less than a `high` turn's first call. Its turns stay in, exactly
  // as turns recorded before output was counted do.
  const low = [sample(seconds(20), { out: 1_000, effort: "low" }), sample(seconds(25), { out: 1_200, effort: "low" })]
  const uncounted = low.map(({ out: _out, ...turn }) => turn)
  assert.deepEqual(
    estimateTurn([...low, ...samples.slice(1)], { ...input, out: 5_000 }),
    estimateTurn([...uncounted, ...samples.slice(1)], { ...input, out: 5_000 }),
  )
})

test("recency: a turn from weeks ago weighs a fraction of one from today", () => {
  const old = Array.from({ length: 3 }, () => sample(seconds(10), { at: NOW - 4 * RECENCY_HALF_LIFE_MS }))
  const fresh = Array.from({ length: 3 }, () => sample(seconds(100)))
  const now = estimateTurn([...old, ...fresh], { elapsedMs: 0, now: NOW })!.totalMs
  const flat = estimateTurn([...old.map((turn) => ({ ...turn, at: NOW })), ...fresh], { elapsedMs: 0, now: NOW })!.totalMs
  // Four half-lives: the old turns weigh a sixteenth each.
  assert.ok(now > seconds(75), `today's turns dominate: ${now}`)
  close(flat, seconds(Math.sqrt(10 * 100)), 0.1, "with no age between them, the geometric mean")
})

test("a new model under a known agent borrows the agent's other models, and a new agent waits", () => {
  const history: TurnHistory = new Map([["build/claude-opus-5-5", [30, 35, 40, 45, 50, 40].map((value) => sample(seconds(value)))]])
  const borrowed = buildTurnModel(history, NOW).estimate("build/claude-sonnet-5-5", { elapsedMs: 0 })
  close(borrowed?.totalMs, seconds(40), 0.1, "no turn of its own: the agent's other model")
  assert.equal(borrowed?.over, false, "with no turn of its own there is no longest turn to be over")
  // One turn of its own moves it toward that turn: the six-turn pool pulls
  // with 2·6/(6 + 2) = 1.5 pseudo-turns against its one, so 40% of the way
  // in log space, 40 s · 5^0.4 = 76 s, before the calibration.
  history.set("build/claude-sonnet-5-5", [sample(seconds(200))])
  const one = buildTurnModel(history, NOW).estimate("build/claude-sonnet-5-5", { elapsedMs: 0 })!.totalMs
  assert.ok(one > seconds(50) && one < seconds(120), `one turn of its own: ${one}`)
  // And the other model's one turn barely moves the six-turn key: the pool
  // of one turn pulls with 2·1/(1 + 2) = 0.67 pseudo-turns.
  const opus = buildTurnModel(history, NOW).estimate("build/claude-opus-5-5", { elapsedMs: 0 })!.totalMs
  assert.ok(opus < seconds(60), `a one-turn pool does not drag a six-turn key: ${opus}`)
  // An agent is a kind of task: another agent's record says nothing.
  assert.equal(buildTurnModel(history, NOW).estimate("plan/claude-opus-5-5", { elapsedMs: 0 }), undefined)
  assert.equal(buildTurnModel(new Map(), NOW).estimate("build/claude-opus-5-5", { elapsedMs: 0 }), undefined)
})

test("a session's own earlier turns pull its estimate, shrunk toward the key's", () => {
  const samples = [
    ...Array.from({ length: 10 }, () => sample(seconds(30), { session: "aaaaaaaa" })),
    ...Array.from({ length: 3 }, () => sample(seconds(120), { session: "bbbbbbbb" })),
  ]
  const mine = estimateTurn(samples, { elapsedMs: 0, session: "bbbbbbbb", now: NOW })!.totalMs
  const other = estimateTurn(samples, { elapsedMs: 0, session: "cccccccc", now: NOW })!.totalMs
  const none = estimateTurn(samples, { elapsedMs: 0, now: NOW })!.totalMs
  assert.ok(mine > seconds(60) && mine < seconds(120), `the session's own long turns pull it: ${mine}`)
  assert.ok(other < seconds(50), `a session with no turn of its own reads the key: ${other}`)
  assert.equal(other, none, "an unknown session is a session with no turn of its own")
})

test("the calibration: the normal curve with no errors, the measured shape blended in as they accrue, and lookups that invert each other", () => {
  assert.equal(calibrationFrom([]), NORMAL_CALIBRATION)
  assert.equal(calibrationFrom([Number.NaN]), NORMAL_CALIBRATION)
  assert.equal(CALIBRATION_PRIOR_RESIDUALS, 12)
  // Errors from a known distribution, N(0.5, 2²), as exact quantiles.
  const shifted = Array.from({ length: 200 }, (_, index) => 0.5 + 2 * normalQuantile((index + 0.5) / 200))
  const calibration = calibrationFrom(shifted)
  assert.equal(calibration.count, 200)
  close(calibration.weight, 200 / 212, 1e-12, "the weight")
  close(calibrationFrom(shifted.slice(0, 12)).weight, 0.5, 1e-12, "twelve errors weigh half")
  // The measured bias and spread carry through, a little short of them
  // because the normal curve still weighs 12 in 212.
  const median = calibration.quantile(0.5)
  assert.ok(median > 0.35 && median < 0.55, `the bias: ${median}`)
  const iqr = calibration.quantile(0.75) - calibration.quantile(0.25)
  assert.ok(iqr > 2.2 && iqr < 3, `the spread, the normal curve's being 1.35: ${iqr}`)
  // Increasing, and each lookup the other's inverse to the grid's resolution.
  let lastQuantile = Number.NEGATIVE_INFINITY
  for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
    const z = calibration.quantile(p)
    assert.ok(z > lastQuantile, `increasing at ${p}`)
    assert.ok(Math.abs(calibration.cdf(z) - p) < 1e-3, `cdf(quantile(${p})) = ${calibration.cdf(z)}`)
    lastQuantile = z
  }
  // The table's ends: beyond the grid a lookup is the edge's value, which for
  // errors twice the normal curve's spread is still near 0 and 1.
  assert.equal(calibration.quantile(0), -8)
  assert.equal(calibration.quantile(1), 8)
  assert.equal(calibration.cdf(-100), calibration.cdf(-8))
  assert.equal(calibration.cdf(100), calibration.cdf(8))
  assert.ok(calibration.cdf(-8) < 1e-3 && calibration.cdf(8) > 1 - 1e-3)
  assert.equal(calibration.cdf(Number.NaN), 0.5)
  // A weight per error is a weighted shape: errors weighing nothing are not
  // there, and the weight is the effective count's.
  const weighted = calibrationFrom([...shifted, 50, 50], [...shifted.map(() => 1), 0, 0])
  assert.equal(weighted.quantile(0.5), calibration.quantile(0.5))
  close(calibrationFrom([1, 2, 3, 4], [1, 1, 1, 1e-9]).weight, 3 / 15, 1e-6, "the effective count")
})

test("a calibration of tied errors still has a band, and one of skewed errors moves the band the skew's way", () => {
  // Twenty identical errors: a raw empirical curve would be flat there and
  // put the quartiles on the median. The kernel spreads them.
  const tied = calibrationFrom(Array.from({ length: 20 }, () => 0.3))
  assert.ok(tied.quantile(0.25) < tied.quantile(0.5) && tied.quantile(0.5) < tied.quantile(0.75))
  // Errors with a long right tail (exponential quantiles, centred): the
  // upper half of the band is wider than the lower.
  const skewed = calibrationFrom(Array.from({ length: 120 }, (_, index) => -Math.log(1 - (index + 0.5) / 120) - 1))
  const lower = skewed.quantile(0.5) - skewed.quantile(0.25)
  const upper = skewed.quantile(0.75) - skewed.quantile(0.5)
  assert.ok(upper > lower * 1.3, `the right tail: ${upper} against ${lower}`)
})

test("the model's errors are its own: a record drawn from a known distribution is assessed as unbiased and about half in band", () => {
  const history: TurnHistory = new Map([
    ["build/claude-opus-5-5", [...logNormalTurns(seconds(60), 0.5, 40), sample(seconds(5), { failed: true }), sample(seconds(4), { failed: true })]],
    ["explore/claude-haiku-5-5", [sample(seconds(20)), sample(seconds(25)), sample(seconds(30))]],
    ["plan/claude-opus-5-5", [sample(seconds(90))]],
  ])
  const assessment = buildTurnModel(history, NOW).assess()
  assert.deepEqual(
    assessment.keys.map((key) => key.key),
    ["build/claude-opus-5-5", "explore/claude-haiku-5-5", "plan/claude-opus-5-5"],
    "most turns first",
  )
  const [build, explore, plan] = assessment.keys
  assert.equal(build.turns, 40)
  assert.equal(build.failed, 2, "a failed turn is counted apart and never read")
  assert.equal(build.assessed, 16, "the newest sixteen")
  close(build.typicalMs, seconds(60), 0.05, "the typical turn")
  // A σ of 0.5 in log space: a turn is typically off by e^(0.674·0.5), about ×1.4.
  close(build.missFactor, Math.exp(0.6745 * 0.5), 0.2, "the typical miss")
  assert.ok(build.overShare! >= 0.25 && build.overShare! <= 0.75, `unbiased: ${build.overShare}`)
  assert.ok(build.inBandShare! >= 0.25 && build.inBandShare! <= 0.75, `about half in band: ${build.inBandShare}`)
  // Three turns leave two to estimate each from, under MIN_TURN_SAMPLES: none assessed.
  assert.equal(explore.turns, 3)
  assert.equal(explore.assessed, 0)
  assert.equal(explore.missFactor, undefined)
  assert.equal(plan.turns, 1)
  assert.equal(assessment.residuals, 16)
  close(assessment.calibrationWeight, 16 / 28, 1e-12, "the calibration's weight")
  assert.deepEqual(buildTurnModel(new Map(), NOW).assess(), { keys: [], residuals: 0, calibrationWeight: 0 })
})
