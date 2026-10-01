---
title: 'Measurement culture'
description: 'Every rule in this project was learned from a measurement, and says which one.'
sidebar:
  order: 4
---

The engineering rules for this repository live in [`AGENTS.md`](../../AGENTS.md), and they
are not opinions. Each one names the probe, the version and the number that produced it, and
the test that keeps it true. The evidence itself, including the dates, the superseded
corrections and the probes that produced each verdict, lives in
[`docs/agents-history.md`](../agents-history.md), and every rule carries an `(h #gNN)` marker
pointing at the section that holds it.

That file is deliberately not a page on this site. It is the maintainer's internal log, it is
addressed to maintainers and to agents working in the repository rather than to users, and
rendering it here would mean rewriting it. Read it on GitHub.

Three rules, quoted as they stand, to show the shape:

> **An abort that lands while a turn is being PREPARED must stop it, and the only thing that
> can see it is a watch created before the prologue's first await** (`watchTurnAbort`,
> `src/turn-abort.ts`): `addEventListener("abort")` on a signal that already aborted never
> fires, so the stream's own handler, which cannot exist until the prologue has finished,
> missed every stop in that window and the turn spawned, wrote and billed anyway (measured: a
> turn alive at 5,874 ms against a 5,000 ms signal). (h #g182)

> **A finish's usage is context occupancy to opencode, so its input side is the turn's LAST
> real API call, never `result.usage`**, which sums every call: a 14-call turn at 180K real
> context reported 2,050,806 cache read and opencode auto-compacted. (h #g169)

> **LRU eviction must never take a process that is mid-turn**: `evictIfNeeded` walks insertion
> order for the first with `turnInFlight !== true`, and when all are busy evicts **nothing**
> and warns. Do not "restore" the one-liner. (h #g62, #g179)

The practical consequence for anyone reading this site: where a page states a number, a
version or a date, it is there because someone measured it on that version on that date. Where
a page says something is not verified, that is not hedging, it means nobody has run it yet.
