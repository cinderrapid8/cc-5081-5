/**
 * Deterministic chain-reaction engine. No DOM, no rendering, no wall clock.
 *
 * TIME MODEL
 * Time is an integer tick. Each tick runs, in order:
 *   1. world changes  (scripted moves / kills / departures / faction changes)
 *   2. propagation    (each due action filters + ranks candidates, locks hops)
 *   3. hit            (each due hop re-validates its endpoints, then damages)
 *
 * Propagation and hit are separate actions with separate ticks and separate
 * event types. A hop is locked at propagation time and resolves at hit time.
 * Selection never implies a guaranteed hit.
 *
 * STALE-STATE POLICY (explicit; never continues from cached state):
 *   - At hit time both endpoints are re-checked against live state:
 *       target: present, onField, alive, eligible faction
 *       origin: present, onField, alive, and (unless the origin is the caster)
 *               eligible faction
 *     Any failure logs hopInterrupted with a reason and deals zero damage.
 *     Damage is applied at the target's *current* position, never a cached one.
 *   - At propagation time the origin is re-checked. If unusable, the action
 *     logs chainAborted and selects nothing.
 *   - A hop that is interrupted still consumed budget: the selection happened.
 *   - Scheduled selections are not retroactively cancelled by a later failed
 *     hit. Each action validates only at its own execution time; a future
 *     propagation from a dead/departed/re-factioned node aborts (chainAborted).
 *
 * TARGETING
 *   Filter order: origin -> visited -> dead -> departed -> faction -> source.
 *   Strategies (tie-break is fixed and reported on every propagate event):
 *     distance : Manhattan distance ascending, then id ascending
 *     lowestHp : effective hp ascending, then id ascending
 *   `visited` is per effect and grows at lock time; an interrupted target
 *   stays visited. `fanout > 1` branches the chain; every branch draws from one
 *   shared hop budget. All subchain events carry the cast's `sourceEventId`.
 *   Nothing is random: identical inputs reproduce identical paths.
 */

export const STRATEGIES = Object.freeze(['distance', 'lowestHp']);

export const TIE_BREAK = Object.freeze({
  distance: 'equal distance -> natural id ascending',
  lowestHp: 'equal hp -> natural id ascending',
});

export const REASON = Object.freeze({
  ORIGIN: 'origin',
  VISITED: 'visited',
  DEAD: 'dead',
  DEPARTED: 'departed',
  FACTION: 'faction',
  SOURCE: 'source',
  NOT_CHOSEN: 'notChosen',
  BUDGET: 'budget',
});

const DEFAULT_EFFECT = {
  strategy: 'distance',
  maxHops: 4,
  fanout: 1,
  damage: 10,
  propDelayTicks: 2,
  hitDelayTicks: 3,
  filters: { factions: 'all', allowSource: false },
};

/**
 * Natural id order used for every tie-break: digit runs compare numerically
 * (E2 < E10), non-digit runs compare lexicographically, digit runs sort before
 * non-digit runs at the same position. Total and stable.
 */
export function compareId(a, b) {
  const sa = String(a);
  const sb = String(b);
  const chunksA = sa.match(/\d+|[^\d]+/g) ?? [''];
  const chunksB = sb.match(/\d+|[^\d]+/g) ?? [''];
  const n = Math.min(chunksA.length, chunksB.length);
  for (let i = 0; i < n; i++) {
    const ca = chunksA[i];
    const cb = chunksB[i];
    const aNum = /^\d+$/.test(ca);
    const bNum = /^\d+$/.test(cb);
    if (aNum !== bNum) return aNum ? -1 : 1;
    if (aNum) {
      const na = Number(ca);
      const nb = Number(cb);
      if (na !== nb) return na - nb;
    } else if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
  }
  if (chunksA.length !== chunksB.length) return chunksA.length - chunksB.length;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

const snapshotUnit = (unit) => ({
  id: unit.id,
  faction: unit.faction,
  x: unit.x,
  y: unit.y,
  hp: unit.hp,
  maxHp: unit.maxHp,
  alive: unit.alive,
  onField: unit.onField,
});

export class Simulation {
  constructor(scenario) {
    if (!scenario || !scenario.cast) throw new Error('scenario.cast is required');
    this.scenario = scenario;
    this.currentTick = 0;
    this.seq = 0;
    this.events = [];
    this.actions = [];
    this.hops = new Map();
    this.effects = new Map();
    this.units = new Map();
    this.initialUnits = [];

    for (const spec of scenario.units ?? []) {
      const unit = {
        id: spec.id,
        faction: spec.faction ?? 'neutral',
        x: spec.x ?? 0,
        y: spec.y ?? 0,
        hp: spec.hp ?? 100,
        maxHp: spec.maxHp ?? spec.hp ?? 100,
        alive: spec.alive ?? true,
        onField: spec.onField ?? true,
      };
      this.units.set(unit.id, unit);
      this.initialUnits.push(snapshotUnit(unit));
    }
    this.changes = [...(scenario.changes ?? [])];
    this._cast(scenario.cast);
  }

  // -- setup ----------------------------------------------------------------

  _cast(cast) {
    const effect = {
      ...DEFAULT_EFFECT,
      ...cast,
      filters: { ...DEFAULT_EFFECT.filters, ...(cast.filters ?? {}) },
      id: cast.id ?? 'fx',
    };
    if (!STRATEGIES.includes(effect.strategy)) {
      throw new Error(`unknown strategy: ${effect.strategy}`);
    }
    if (!Number.isInteger(effect.fanout) || effect.fanout < 1) {
      throw new Error(`fanout must be a positive integer: ${effect.fanout}`);
    }
    if (!Number.isInteger(effect.maxHops) || effect.maxHops < 0) {
      throw new Error(`maxHops must be a non-negative integer: ${effect.maxHops}`);
    }
    if (!Number.isInteger(effect.propDelayTicks) || effect.propDelayTicks < 1) {
      throw new Error(`propDelayTicks must be a positive integer: ${effect.propDelayTicks}`);
    }
    if (!Number.isInteger(effect.hitDelayTicks) || effect.hitDelayTicks < 1) {
      throw new Error(`hitDelayTicks must be a positive integer: ${effect.hitDelayTicks}`);
    }
    effect.sourceUnitId = cast.sourceUnitId;
    effect.originUnitId = cast.originUnitId ?? cast.sourceUnitId;
    const source = this.units.get(effect.sourceUnitId);
    if (!source) throw new Error(`missing source unit: ${effect.sourceUnitId}`);

    effect.state = {
      budget: effect.maxHops,
      visited: new Set([effect.originUnitId]),
      exhaustedLogged: false,
    };
    this.effects.set(effect.id, effect);

    this._emit('cast', {
      effectId: effect.id,
      sourceEventId: effect.id,
      sourceUnitId: effect.sourceUnitId,
      originId: effect.originUnitId,
      strategy: effect.strategy,
      tieBreak: TIE_BREAK[effect.strategy],
      maxHops: effect.maxHops,
      fanout: effect.fanout,
      damage: effect.damage,
      propDelayTicks: effect.propDelayTicks,
      hitDelayTicks: effect.hitDelayTicks,
      filters: { ...effect.filters },
      originPos: this._pos(effect.originUnitId),
    });

    if (effect.maxHops <= 0) {
      this._noteExhausted(effect);
      return;
    }
    this.actions.push({
      kind: 'propagate',
      tick: this.currentTick + 1,
      seq: this._nextSeq(),
      effectId: effect.id,
      chainId: 'c0',
      depth: 0,
      originId: effect.originUnitId,
      fromHopId: null,
    });
  }

  _noteExhausted(effect) {
    if (effect.state.exhaustedLogged) return;
    effect.state.exhaustedLogged = true;
    this._emit('budgetExhausted', {
      effectId: effect.id,
      used: effect.maxHops - effect.state.budget,
      maxHops: effect.maxHops,
    });
  }

  // -- driver ---------------------------------------------------------------

  get idle() {
    return this.actions.length === 0;
  }

  /** Execute exactly one tick; returns the events produced by it. */
  step() {
    const t = this.currentTick;
    const produced = [];
    this._applyWorldChanges(t, produced);

    const due = this.actions
      .filter((a) => a.tick === t)
      .sort((a, b) =>
        a.kind === b.kind ? a.seq - b.seq : (a.kind === 'propagate' ? -1 : 1));
    this.actions = this.actions.filter((a) => a.tick !== t);

    for (const action of due) {
      if (action.kind === 'propagate') produced.push(...this._propagate(action));
      else produced.push(...this._hit(action));
    }
    this.currentTick = t + 1;
    return produced;
  }

  runUntilIdle(maxTicks = 10000) {
    let steps = 0;
    while (!this.idle && steps < maxTicks) {
      this.step();
      steps++;
    }
    if (!this.idle) throw new Error(`simulation did not settle in ${maxTicks} ticks`);
    return this.events;
  }

  _applyWorldChanges(t, produced) {
    for (const change of this.changes) {
      if (change.tick !== t) continue;
      const unit = this.units.get(change.id);
      const event = this._emit('worldChange', {
        change: change.type,
        unitId: change.id,
        applied: Boolean(unit),
        detail: { x: change.x, y: change.y, faction: change.faction },
      });
      if (unit) {
        switch (change.type) {
          case 'move':
            unit.x = change.x;
            unit.y = change.y;
            break;
          case 'kill':
            unit.alive = false;
            unit.hp = 0;
            break;
          case 'depart':
            unit.onField = false;
            break;
          case 'setFaction':
            unit.faction = change.faction;
            break;
          case 'remove':
            this.units.delete(change.id);
            break;
          default:
            throw new Error(`unknown world change: ${change.type}`);
        }
      }
      produced.push(event);
    }
  }

  // -- propagation ----------------------------------------------------------

  _propagate(action) {
    const effect = this.effects.get(action.effectId);
    const state = effect.state;
    const t = this.currentTick;
    const origin = this.units.get(action.originId);
    const isSourceOrigin = action.originId === effect.sourceUnitId;

    const abort = this._originAbortReason(origin, effect, isSourceOrigin);
    if (abort) {
      return [this._emit('chainAborted', {
        effectId: effect.id,
        chainId: action.chainId,
        depth: action.depth,
        originId: action.originId,
        originPos: this._pos(action.originId),
        reason: abort,
        fromHopId: action.fromHopId,
      })];
    }

    const slots = Math.min(effect.fanout, state.budget);
    const { candidates, ranked } = this._rank(effect, action, slots);
    const chosen = ranked.slice(0, slots);
    const budgetBefore = state.budget;
    const originPos = this._pos(action.originId);

    const events = [this._emit('propagate', {
      effectId: effect.id,
      chainId: action.chainId,
      depth: action.depth,
      originId: action.originId,
      originPos,
      candidates,
      chosen: chosen.map((u) => u.id),
      budgetBefore,
      budgetAfter: budgetBefore - chosen.length,
      skipped: slots === 0 ? REASON.BUDGET : null,
      strategy: effect.strategy,
      tieBreak: TIE_BREAK[effect.strategy],
    })];

    for (let i = 0; i < chosen.length; i++) {
      const target = chosen[i];
      state.budget--;
      state.visited.add(target.id);
      const hopId = `${effect.id}:${action.chainId}:${i}`;
      const childChainId = `${action.chainId}/${i}`;
      const hop = {
        hopId,
        effectId: effect.id,
        chainId: action.chainId,
        childChainId,
        depth: action.depth + 1,
        fromId: action.originId,
        toId: target.id,
        fromIsSource: isSourceOrigin,
        lockedTick: t,
        hitTick: t + effect.hitDelayTicks,
        fromPos: { ...originPos },
        toPos: { x: target.x, y: target.y },
        status: 'pending',
        reason: null,
        resolvedTick: null,
      };
      this.hops.set(hopId, hop);
      events.push(this._emit('hopLocked', {
        effectId: effect.id,
        hopId,
        chainId: action.chainId,
        childChainId,
        depth: hop.depth,
        fromId: hop.fromId,
        toId: hop.toId,
        fromPos: { ...hop.fromPos },
        toPos: { ...hop.toPos },
        lockedTick: t,
        hitTick: hop.hitTick,
        fromIsSource: isSourceOrigin,
        budgetRemaining: state.budget,
      }));
      this.actions.push({
        kind: 'hit', tick: hop.hitTick, seq: this._nextSeq(),
        effectId: effect.id, hopId,
      });
      // Always schedule the follow-up selection even at zero budget: the
      // zero-budget decision is still a real decision and is logged with its
      // candidate list (every row marked "budget"). It deliberately does NOT
      // schedule further selections, so a dry branch records one terminal
      // decision instead of an endless chain of empty ones.
      if (state.budget > 0) {
        this.actions.push({
          kind: 'propagate',
          tick: t + effect.propDelayTicks,
          seq: this._nextSeq(),
          effectId: effect.id,
          chainId: childChainId,
          depth: hop.depth,
          originId: target.id,
          fromHopId: hopId,
        });
      } else {
        this.actions.push({
          kind: 'propagate',
          tick: t + effect.propDelayTicks,
          seq: this._nextSeq(),
          effectId: effect.id,
          chainId: childChainId,
          depth: hop.depth,
          originId: target.id,
          fromHopId: hopId,
          terminal: true,
        });
      }
      if (state.budget === 0) this._noteExhausted(effect);
    }
    return events;
  }

  _originAbortReason(origin, effect, isSourceOrigin) {
    if (!origin) return 'originRemoved';
    if (!origin.alive) return 'originDead';
    if (!origin.onField) return 'originDeparted';
    if (!isSourceOrigin && !this._factionAllowed(effect, origin)) return 'originFactionChanged';
    return null;
  }

  _factionAllowed(effect, unit) {
    const allowed = effect.filters.factions;
    return allowed === 'all' || allowed.includes(unit.faction);
  }

  _rank(effect, action, slots) {
    const originPos = this._pos(action.originId);
    const state = effect.state;
    const rows = [];
    const survivors = [];

    for (const unit of [...this.units.values()].sort((a, b) => compareId(a.id, b.id))) {
      let reason = null;
      if (unit.id === action.originId) reason = REASON.ORIGIN;
      else if (state.visited.has(unit.id)) reason = REASON.VISITED;
      else if (!unit.alive) reason = REASON.DEAD;
      else if (!unit.onField) reason = REASON.DEPARTED;
      else if (!this._factionAllowed(effect, unit)) reason = REASON.FACTION;
      else if (!effect.filters.allowSource && unit.id === effect.sourceUnitId) reason = REASON.SOURCE;

      const row = {
        id: unit.id,
        faction: unit.faction,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        alive: unit.alive,
        onField: unit.onField,
        distance: originPos ? manhattan(originPos, unit) : null,
        eligible: reason === null,
        reason,
        state: reason,
      };
      rows.push(row);
      if (reason === null) survivors.push({ unit, row });
    }

    const ranked = survivors.slice().sort((a, b) =>
      effect.strategy === 'distance'
        ? (a.row.distance - b.row.distance) || compareId(a.unit.id, b.unit.id)
        : (a.row.hp - b.row.hp) || compareId(a.unit.id, b.unit.id));

    ranked.forEach((entry, index) => {
      entry.row.state = index < slots ? 'chosen' : (slots === 0 ? REASON.BUDGET : REASON.NOT_CHOSEN);
    });
    return { candidates: rows, ranked: ranked.map((e) => e.unit) };
  }

  // -- hits -----------------------------------------------------------------

  _hit(action) {
    const hop = this.hops.get(action.hopId);
    if (!hop || hop.status !== 'pending') return [];
    const effect = this.effects.get(hop.effectId);
    const t = this.currentTick;
    const target = this.units.get(hop.toId);
    const origin = this.units.get(hop.fromId);

    const reason = this._hitAbortReason(origin, target, effect, hop);
    if (reason) {
      hop.status = 'interrupted';
      hop.reason = reason;
      hop.resolvedTick = t;
      return [this._emit('hopInterrupted', {
        effectId: effect.id,
        hopId: hop.hopId,
        chainId: hop.chainId,
        childChainId: hop.childChainId,
        depth: hop.depth,
        fromId: hop.fromId,
        toId: hop.toId,
        reason,
        lockedTick: hop.lockedTick,
        hitTick: hop.hitTick,
        fromPos: { ...hop.fromPos },
        lockedToPos: { ...hop.toPos },
        targetPos: target ? this._pos(target.id) : null,
        damage: 0,
      })];
    }

    const hpBefore = target.hp;
    const damage = Math.max(0, Math.min(effect.damage, hpBefore));
    const hpAfter = hpBefore - damage;
    target.hp = hpAfter;
    if (hpAfter <= 0) {
      target.alive = false;
      target.hp = 0;
    }
    hop.status = 'applied';
    hop.reason = null;
    hop.resolvedTick = t;

    return [this._emit('hit', {
      effectId: effect.id,
      hopId: hop.hopId,
      chainId: hop.chainId,
      childChainId: hop.childChainId,
      depth: hop.depth,
      fromId: hop.fromId,
      toId: hop.toId,
      damage,
      requestedDamage: effect.damage,
      hpBefore,
      hpAfter: target.hp,
      killed: !target.alive,
      lockedTick: hop.lockedTick,
      hitTick: hop.hitTick,
      position: this._pos(target.id),
      lockedToPos: { ...hop.toPos },
    })];
  }

  _hitAbortReason(origin, target, effect, hop) {
    if (!target) return 'targetRemoved';
    if (!target.onField) return 'targetDeparted';
    if (!target.alive) return 'targetDead';
    if (!this._factionAllowed(effect, target)) return 'targetFactionChanged';
    if (!origin) return 'originRemoved';
    if (!origin.onField) return 'originDeparted';
    if (!origin.alive) return 'originDead';
    if (!hop.fromIsSource && !this._factionAllowed(effect, origin)) return 'originFactionChanged';
    return null;
  }

  // -- utils ----------------------------------------------------------------

  _pos(id) {
    const unit = this.units.get(id);
    return unit ? { x: unit.x, y: unit.y } : null;
  }

  _nextSeq() {
    return this.seq++;
  }

  _emit(type, data) {
    const event = {
      type,
      seq: this._nextSeq(),
      tick: this.currentTick,
      sourceEventId: data.sourceEventId ?? data.effectId ?? null,
      ...data,
    };
    this.events.push(event);
    return event;
  }
}

export function simulate(scenario, maxTicks = 10000) {
  const sim = new Simulation(scenario);
  sim.runUntilIdle(maxTicks);
  return sim;
}

/**
 * Consolidated replay view. The UI consumes only this object.
 */
export function buildReport(sim) {
  const fx = sim.events.filter((e) => e.sourceEventId);
  const cast = fx.find((e) => e.type === 'cast') ?? null;
  const propagations = fx.filter((e) => e.type === 'propagate');
  const locks = fx.filter((e) => e.type === 'hopLocked');
  const hits = fx.filter((e) => e.type === 'hit');
  const interrupted = fx.filter((e) => e.type === 'hopInterrupted');
  const aborted = fx.filter((e) => e.type === 'chainAborted');
  const budget = fx.filter((e) => e.type === 'budgetExhausted');

  const edges = locks.map((lock) => {
    const hop = sim.hops.get(lock.hopId);
    const hit = hits.find((h) => h.hopId === lock.hopId);
    return {
      hopId: lock.hopId,
      chainId: lock.chainId,
      childChainId: lock.childChainId,
      depth: lock.depth,
      fromId: lock.fromId,
      toId: lock.toId,
      fromPos: lock.fromPos,
      toPos: lock.toPos,
      lockedTick: lock.lockedTick,
      hitTick: lock.hitTick,
      status: hop?.status ?? 'pending',
      reason: hop?.reason ?? null,
      resolvedTick: hop?.resolvedTick ?? null,
      damage: hit?.damage ?? 0,
      killed: hit?.killed ?? false,
      position: hit?.position ?? null,
      sourceEventId: lock.sourceEventId,
    };
  });

  const rejected = [];
  for (const prop of propagations) {
    for (const cand of prop.candidates ?? []) {
      if (cand.state === 'chosen') continue;
      rejected.push({
        tick: prop.tick,
        chainId: prop.chainId,
        originId: prop.originId,
        originPos: prop.originPos,
        candidateId: cand.id,
        candidatePos: { x: cand.x, y: cand.y },
        reason: cand.state ?? REASON.NOT_CHOSEN,
        distance: cand.distance,
        hp: cand.hp,
        faction: cand.faction,
      });
    }
  }

  const effect = [...sim.effects.values()][0];
  const lastTick = fx.reduce((m, e) => Math.max(m, e.tick), 0);

  // A "branch" is a final subchain leaf: a propagation path that spawned no
  // further propagation. One fanout=1 run yields one leaf; every split adds
  // leaves. This is the only honest way to count fan-out.
  const chainIds = new Set(propagations.map((p) => p.chainId));
  const hasChild = new Set();
  for (const id of chainIds) {
    const slash = id.lastIndexOf('/');
    if (slash > 0) hasChild.add(id.slice(0, slash));
  }
  const leaves = [...chainIds].filter((id) => !hasChild.has(id));
  const branches = leaves.length;
  const fanoutSplits = propagations.filter((p) => p.chosen.length > 1).length;

  return {
    cast,
    strategy: cast?.strategy ?? null,
    tieBreak: cast?.tieBreak ?? null,
    lastTick,
    initialUnits: sim.initialUnits.map((u) => ({ ...u })),
    events: sim.events,
    effectEvents: fx,
    propagations,
    locks,
    hits,
    interrupted,
    aborted,
    budget,
    edges,
    rejected,
    units: [...sim.units.values()].map(snapshotUnit),
    summary: {
      sourceEventId: cast?.sourceEventId ?? null,
      maxHops: effect?.maxHops ?? 0,
      fanout: effect?.fanout ?? 1,
      damage: effect?.damage ?? 0,
      hopsLocked: edges.length,
      hopsApplied: edges.filter((e) => e.status === 'applied').length,
      hopsInterrupted: edges.filter((e) => e.status === 'interrupted').length,
      totalDamage: hits.reduce((sum, h) => sum + h.damage, 0),
      aborted: aborted.length,
      budgetUsed: effect ? effect.maxHops - effect.state.budget : 0,
      budgetExhausted: budget.length > 0,
      branches,
      fanoutSplits,
      leaves,
      visited: effect ? [...effect.state.visited] : [],
      path: edges.map((e) => `${e.fromId}>${e.toId}`),
      lastTick,
    },
  };
}

export function runScenario(scenario, maxTicks = 10000) {
  return buildReport(simulate(scenario, maxTicks));
}
