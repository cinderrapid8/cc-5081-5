/**
 * Replay state derived from the engine's event log.
 *
 * The UI never invents geometry. Everything it draws comes from events:
 *   - executed edges   <- hopLocked (locked) then hit / hopInterrupted (resolved)
 *   - rejected candidates <- propagate.candidates rows
 *   - live units       <- initial units + worldChange replay + hit damage
 *
 * `stateAtTick(t)` rebuilds the world by replaying events with tick <= t.
 * `frameAt(t)` additionally exposes per-tick edges, rejections and log lines.
 */

import { REASON } from './sim.js';

const clone = (u) => ({ ...u });

export class Replay {
  constructor(report) {
    this.report = report;
    this.lastTick = report.lastTick;

    this.initial = new Map(report.initialUnits.map((u) => [u.id, clone(u)]));

    // Precompute the change list index by tick for quick replay.
    this.worldChanges = report.events.filter((e) => e.type === 'worldChange');
    this.hitEvents = report.hits;
    this.propEvents = report.propagations;
    this.lockEvents = report.locks;
    this.interruptEvents = report.interrupted;
    this.abortEvents = report.aborted;
    this.budgetEvents = report.budget;
    this.castEvent = report.cast;
  }

  /**
   * Rebuild the visible world at the *end* of tick t:
   * world changes with tick <= t, hits with tick <= t, plus latest positions.
   */
  stateAtTick(t) {
    const units = new Map([...this.initial].map(([id, u]) => [id, clone(u)]));
    const removed = new Set();

    for (const ev of this.worldChanges) {
      if (ev.tick > t) break;
      const u = units.get(ev.unitId);
      if (!u) continue;
      switch (ev.change) {
        case 'move':
          u.x = ev.detail.x;
          u.y = ev.detail.y;
          u.movedAt = ev.tick;
          break;
        case 'kill':
          u.alive = false;
          u.hp = 0;
          u.diedAt = ev.tick;
          break;
        case 'depart':
          u.onField = false;
          u.departedAt = ev.tick;
          break;
        case 'setFaction':
          u.faction = ev.detail.faction;
          u.factionChangedAt = ev.tick;
          break;
        case 'remove':
          removed.add(ev.unitId);
          break;
        default:
          break;
      }
    }
    for (const ev of this.hitEvents) {
      if (ev.tick > t) break;
      const u = units.get(ev.toId);
      if (!u) continue;
      u.hp = ev.hpAfter;
      u.alive = ev.hpAfter > 0;
      u.lastHitTick = ev.tick;
      u.lastDamage = ev.damage;
    }
    for (const id of removed) units.delete(id);
    return units;
  }

  /** Edges that had been locked but not yet resolved at end of tick t. */
  pendingAt(t) {
    return this.report.edges.filter((e) => e.lockedTick <= t && e.resolvedTick > t);
  }

  /** Edges that have resolved (hit applied or interrupted) by end of tick t. */
  resolvedAt(t) {
    return this.report.edges.filter((e) => e.resolvedTick !== null && e.resolvedTick <= t);
  }

  /** Edges locked by end of tick t (including pending). */
  lockedAt(t) {
    return this.report.edges.filter((e) => e.lockedTick <= t);
  }

  /** Rejections recorded at exactly tick t (propagation fired then). */
  rejectionsAt(t) {
    return this.report.rejected.filter((r) => r.tick === t);
  }

  /** Propagation decisions at exactly tick t. */
  propagationsAt(t) {
    return this.report.propagations.filter((p) => p.tick === t);
  }

  /** Chronological log lines for events with tick <= t. */
  logAt(t) {
    const lines = [];
    for (const ev of this.report.effectEvents) {
      if (ev.tick > t) break;
      const line = describe(ev);
      if (line) lines.push(line);
    }
    for (const ev of this.worldChanges) {
      if (ev.tick > t) break;
      lines.push({
        tick: ev.tick, seq: ev.seq, kind: 'world',
        text: `${ev.change} ${ev.unitId}` +
          (ev.detail?.x !== undefined ? ` -> (${ev.detail.x},${ev.detail.y})` : '') +
          (ev.detail?.faction ? ` -> ${ev.detail.faction}` : ''),
      });
    }
    return lines.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Full frame for tick t. `upper` is exclusive upper bound used by the UI
   * scrubber; `t` may be -1 to mean "only the cast has happened".
   */
  frameAt(t) {
    if (t < 0) t = 0;
    const state = this.stateAtTick(t);
    return {
      tick: t,
      units: [...state.values()],
      locked: this.lockedAt(t),
      pending: this.pendingAt(t),
      resolved: this.resolvedAt(t),
      rejections: this.rejectionsAt(t),
      propagations: this.propagationsAt(t),
      log: this.logAt(t),
      budgetUsed: this.report.edges.filter((e) => e.lockedTick <= t).length,
      budgetMax: this.report.summary.maxHops,
    };
  }
}

export function describe(ev) {
  const base = { tick: ev.tick, seq: ev.seq };
  switch (ev.type) {
    case 'cast':
      return { ...base, kind: 'cast',
        text: `cast ${ev.originId} strategy=${ev.strategy} budget=${ev.maxHops}` };
    case 'propagate':
      return { ...base, kind: 'propagate',
        text: `propagate @${ev.originId} budget ${ev.budgetBefore}->${ev.budgetAfter} ` +
          `chosen [${ev.chosen.join(',') || 'none'}]` +
          (ev.skipped ? ` (${ev.skipped})` : '') };
    case 'hopLocked':
      return { ...base, kind: 'lock',
        text: `lock ${ev.fromId}->${ev.toId} t=${ev.lockedTick} hit@t=${ev.hitTick}` };
    case 'hit':
      return { ...base, kind: 'hit',
        text: `hit ${ev.fromId}->${ev.toId} -${ev.damage} hp ${ev.hpBefore}->${ev.hpAfter}` +
          (ev.killed ? ' KILL' : '') };
    case 'hopInterrupted':
      return { ...base, kind: 'interrupt',
        text: `interrupt ${ev.fromId}->${ev.toId} ${ev.reason} damage=0` };
    case 'chainAborted':
      return { ...base, kind: 'abort',
        text: `abort chain ${ev.chainId} at ${ev.originId} ${ev.reason}` };
    case 'budgetExhausted':
      return { ...base, kind: 'budget',
        text: `budget used ${ev.used}/${ev.maxHops} — stop selecting` };
    default:
      return null;
  }
}

export { REASON };
