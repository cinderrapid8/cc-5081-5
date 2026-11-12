/**
 * Canvas view. Draws only replay data: world positions, locked/pending/
 * resolved edges, and rejected candidates. No decorative paths.
 */
import { REASON } from '../src/sim.js';

const FACTION_COLORS = {
  ally: '#4f9cf9',
  enemy: '#f27059',
  hostile: '#f27059',
  neutral: '#98a4b3',
};

const EDGE_COLORS = {
  applied: '#4ec9a8',
  interrupted: '#d65757',
  pending: '#e0a84c',
};

const REASON_SHORT = {
  origin: '起点',
  visited: '已访问',
  dead: '已死亡',
  departed: '已离场',
  faction: '阵营不符',
  source: '源对象',
  notChosen: '未被选中',
  budget: '预算不足',
};

const ABORT_SHORT = {
  targetDead: '目标死亡',
  targetDeparted: '目标离场',
  targetRemoved: '目标移除',
  targetFactionChanged: '阵营改变',
  originDead: '起点死亡',
  originDeparted: '起点离场',
  originRemoved: '起点移除',
  originFactionChanged: '起点阵营改变',
  originDeadProp: '起点死亡',
};

function REASON_SHORT_ABORT(reason) {
  return ABORT_SHORT[reason] ?? (reason ?? '失效');
}

export class StageView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { minX: -6, maxX: 6, minY: -5, maxY: 5 };
    this.showRejected = true;
    this.showLabels = true;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setView(view) {
    this.view = view;
    this._resize();
  }

  setOptions({ showRejected, showLabels }) {
    if (showRejected !== undefined) this.showRejected = showRejected;
    if (showLabels !== undefined) this.showLabels = showLabels;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
  }

  /** World -> canvas, preserving aspect ratio and leaving margins. */
  project(x, y) {
    const { minX, maxX, minY, maxY } = this.view;
    const ww = maxX - minX;
    const wh = maxY - minY;
    const pad = 46;
    const scale = Math.min((this.cssW - pad * 2) / ww, (this.cssH - pad * 2) / wh);
    const ox = (this.cssW - ww * scale) / 2;
    const oy = (this.cssH - wh * scale) / 2;
    return {
      x: ox + (x - minX) * scale,
      y: oy + (maxY - y) * scale,
      scale,
    };
  }

  /**
   * @param {object} frame   from Replay#frameAt
   * @param {object} report  full report (for units' maxHp and summary)
   * @param {object} extra   { tick, phaseText, compareUnits? }
   */
  draw(frame, report, extra = {}) {
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    ctx.clearRect(0, 0, W, H);

    this._drawGrid(ctx, W, H);

    // 1. Rejected candidates (draw first, under the edges and units).
    if (this.showRejected) this._drawRejections(ctx, frame);

    // 2. Edges actually selected/executed by the engine.
    const labels = this._drawEdges(ctx, frame, extra.tick);

    // 3. Units.
    this._drawUnits(ctx, frame, report);

    // 4. Edge badges on top of units, so a badge near a unit stays legible.
    this._drawEdgeLabels(ctx, labels);

    // 5. Selected targets pulse.
    this._drawHighlights(ctx, frame, extra.tick);
  }

  _drawGrid(ctx, W, H) {
    const { minX, maxX, minY, maxY } = this.view;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,140,170,.10)';
    ctx.lineWidth = 1;
    for (let x = minX; x <= maxX; x++) {
      const a = this.project(x, minY);
      const b = this.project(x, maxY);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let y = minY; y <= maxY; y++) {
      const a = this.project(minX, y);
      const b = this.project(maxX, y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  _drawRejections(ctx, frame) {
    ctx.save();
    // Group identical (candidate, reason) decisions made in this tick so a
    // fan-out with several propagations does not draw the same label N times.
    const groups = new Map();
    for (const r of frame.rejections) {
      if (!r.originPos) continue;
      if (r.reason === REASON.ORIGIN) continue; // the origin itself is never a target
      const key = `${r.candidateId}|${r.reason}|${r.candidatePos.x},${r.candidatePos.y}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        g.origins.push(r.originPos);
      } else {
        groups.set(key, {
          candId: r.candidateId,
          reason: r.reason,
          pos: r.candidatePos,
          count: 1,
          origins: [r.originPos],
        });
      }
    }

    // Centroid of the visible scene, used to push labels outward where there
    // is room instead of stacking them on the crowded inner ring.
    let cx = 0; let cy = 0;
    for (const u of frame.units) {
      const q = this.project(u.x, u.y);
      cx += q.x; cy += q.y;
    }
    cx /= Math.max(frame.units.length, 1);
    cy /= Math.max(frame.units.length, 1);

    const placed = [];
    for (const g of groups.values()) {
      const p = this.project(g.pos.x, g.pos.y);

      // thin dashed rays from each origin that considered this candidate
      ctx.strokeStyle = 'rgba(122,134,152,.30)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1;
      for (const o of g.origins) {
        const op = this.project(o.x, o.y);
        ctx.beginPath(); ctx.moveTo(op.x, op.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      ctx.setLineDash([]);

      // diamond marker on the candidate
      const size = 3.2;
      ctx.fillStyle = 'rgba(150,162,180,.9)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - size);
      ctx.lineTo(p.x + size, p.y);
      ctx.lineTo(p.x, p.y + size);
      ctx.lineTo(p.x - size, p.y);
      ctx.closePath(); ctx.fill();

      if (!this.showLabels) continue;

      const label = (REASON_SHORT[g.reason] ?? g.reason) +
        (g.count > 1 ? ` ×${g.count}` : '');
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dx / len) * 20;
      const oy = (dy / len) * 16;

      // try outward first, then nudge around until the pill box is free
      let lx = p.x + ox;
      let ly = p.y + oy;
      for (let k = 0; k < 6; k++) {
        const box = this._roughBox(lx, ly, label);
        const hit = placed.find((b) => !(box.x2 < b.x1 || box.x1 > b.x2 ||
          box.y2 < b.y1 || box.y1 > b.y2));
        if (!hit) { placed.push(box); break; }
        const ang = Math.atan2(oy, ox) + ((k + 1) % 2 ? 1 : -1) * 0.9 * Math.ceil((k + 1) / 2);
        const rad = 24 + k * 8;
        lx = p.x + Math.cos(ang) * rad;
        ly = p.y + Math.sin(ang) * rad;
        if (k === 5) placed.push(this._roughBox(lx, ly, label));
      }
      this._pillLabel(ctx, label, lx, ly, { align: 'center' });
    }
    ctx.restore();
  }

  _roughBox(cx, cy, text) {
    const w = text.length * 6.4 + 10;
    return { x1: cx - w / 2, x2: cx + w / 2, y1: cy - 8, y2: cy + 8 };
  }

  /** Small dark pill so labels stay legible over units and edges. */
  _pillLabel(ctx, text, x, y, { align = 'left', color = '#a6b3c4', bg = 'rgba(10,15,21,.78)' } = {}) {
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 8;
    const h = 14;
    let left = x;
    if (align === 'center') left = x - w / 2;
    if (align === 'right') left = x - w;
    ctx.fillStyle = bg;
    roundRect(ctx, left, y - h / 2, w, h, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, left + 4, y + 0.5);
    ctx.restore();
  }

  _drawEdges(ctx, frame, currentTick) {
    const byId = new Map(frame.units.map((u) => [u.id, u]));
    ctx.save();

    // scene centroid so edge labels can be pushed to the outward side
    let cx = 0; let cy = 0;
    for (const u of frame.units) {
      const q = this.project(u.x, u.y);
      cx += q.x; cy += q.y;
    }
    cx /= Math.max(frame.units.length, 1);
    cy /= Math.max(frame.units.length, 1);

    const placed = [];
    const out = [];
    const obstacles = frame.units.map((u) => {
      const q = this.project(u.x, u.y);
      return { x1: q.x - 15, x2: q.x + 15, y1: q.y - 15, y2: q.y + 15 };
    });
    for (const edge of frame.locked) {
      // Endpoints come from the positions recorded at lock time; the target's
      // current position is also drawn via the unit itself, so a diverging
      // position is visible (that is real state, not decoration).
      const from = this.project(edge.fromPos.x, edge.fromPos.y);
      const to = this.project(edge.toPos.x, edge.toPos.y);
      const resolved = edge.resolvedTick !== null && edge.resolvedTick <= currentTick;

      let color;
      let dash = [];
      let width = 2;
      if (!resolved) {
        color = EDGE_COLORS.pending;
        dash = [7, 5];
        width = 1.8;
      } else if (edge.status === 'applied') {
        color = EDGE_COLORS.applied;
        width = 2.4;
      } else {
        color = EDGE_COLORS.interrupted;
        dash = [3, 4];
        width = 2;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.globalAlpha = resolved ? 0.95 : 0.85;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      if (resolved) this._arrow(ctx, from, to, color);

      // If the target's current position differs from the locked position, draw
      // a hollow marker at the locked point and a dotted connector. This is the
      // only place a cached position is shown, and it is shown *as cached*.
      const live = byId.get(edge.toId);
      if (live) {
        const cur = this.project(live.x, live.y);
        if (Math.hypot(cur.x - to.x, cur.y - to.y) > 2) {
          ctx.strokeStyle = 'rgba(224,168,76,.6)';
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(to.x, to.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(224,168,76,.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(to.x, to.y, 5, 0, Math.PI * 2); ctx.stroke();
        }
      }

      const text = !resolved
        ? { label: `命中@t=${edge.hitTick}`, color: '#e6c07a', bg: 'rgba(10,15,21,.78)' }
        : edge.status === 'applied'
          ? { label: `-${edge.damage}`, color: '#8fe3c6', bg: 'rgba(10,15,21,.78)' }
          : { label: `✕ ${REASON_SHORT_ABORT(edge.reason)}`, color: '#ff9b9b', bg: 'rgba(40,12,12,.82)' };

      // Collect the badge instead of painting it now; units are drawn after
      // edges, so painting here would hide labels under unit discs.
      const fresh = resolved && edge.resolvedTick === currentTick;
      if (!resolved || fresh) {
        const anchor = this._labelSpot(from, to, cx, cy, text.label, placed, obstacles);
        placed.push(anchor.box);
        out.push({ x: anchor.x, y: anchor.y, ...text });
      }
    }
    ctx.restore();
    return out;
  }

  _drawEdgeLabels(ctx, labels) {
    for (const l of labels) {
      this._pillLabel(ctx, l.label, l.x, l.y, { align: 'center', color: l.color, bg: l.bg });
    }
  }

  /** Find a free spot near the edge for its label, biased outward from centre. */
  _labelSpot(from, to, cx, cy, text, placed, obstacles = []) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    const mx0 = from.x + dx * 0.55;
    const my0 = from.y + dy * 0.55;
    if ((mx0 - cx) * nx + (my0 - cy) * ny < 0) { nx = -nx; ny = -ny; }

    const w = text.length * 6.4 + 10;
    const boxOf = (x, y) => ({ x1: x - w / 2, x2: x + w / 2, y1: y - 8, y2: y + 8 });
    const hits = (b) => placed.some((p) =>
      !(b.x2 < p.x1 || b.x1 > p.x2 || b.y2 < p.y1 || b.y1 > p.y2)) ||
      obstacles.some((o) =>
        !(b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2));

    // Try several points along the edge, and for each of them push the label
    // further and further along the outward normal. This gives a long
    // horizontal chain room to hang its labels above or below the line.
    const ts = [0.55, 0.5, 0.62, 0.45, 0.7, 0.38, 0.78, 0.3, 0.85];
    const dists = [22, 30, 38, 46, 54, 62, 70];
    let last = null;
    for (const d of dists) {
      for (const tt of ts) {
        const px = from.x + dx * tt;
        const py = from.y + dy * tt;
        const c = { x: px + nx * d, y: py + ny * d };
        const box = boxOf(c.x, c.y);
        last = { x: c.x, y: c.y, box };
        if (!hits(box)) return last;
        // mirrored side of the line
        const c2 = { x: px - nx * d, y: py - ny * d };
        const box2 = boxOf(c2.x, c2.y);
        last = { x: c2.x, y: c2.y, box: box2 };
        if (!hits(box2)) return last;
      }
    }
    return last;
  }

  _arrow(ctx, from, to, color) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = to.x - ux * 18;
    const tipY = to.y - uy * 18;
    const size = 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.7, tipY - uy * size + ux * size * 0.7);
    ctx.lineTo(tipX - ux * size + uy * size * 0.7, tipY - uy * size - ux * size * 0.7);
    ctx.closePath(); ctx.fill();
  }

  _drawUnits(ctx, frame, report) {
    const maxHpById = new Map(report.units.map((u) => [u.id, u.maxHp]));
    for (const unit of frame.units) {
      const p = this.project(unit.x, unit.y);
      const r = unit.id === report.cast?.sourceUnitId ? 17 : 13;
      const color = FACTION_COLORS[unit.faction] ?? '#98a4b3';
      const faded = !unit.alive || !unit.onField;

      ctx.save();
      ctx.globalAlpha = faded ? 0.34 : 1;

      // outer ring marks the effect source
      if (unit.id === report.cast?.sourceUnitId) {
        ctx.strokeStyle = 'rgba(110,168,254,.55)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();

      // health arc
      const maxHp = maxHpById.get(unit.id) ?? unit.maxHp ?? unit.hp;
      const ratio = Math.max(0, Math.min(1, unit.hp / (maxHp || 1)));
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, r - 1, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = ratio > 0.5 ? '#9be6c8' : ratio > 0.25 ? '#e0c060' : '#f08383';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.stroke();

      // symbol for state changes
      if (!unit.alive) {
        ctx.strokeStyle = '#ffb0b0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - r * 0.5, p.y - r * 0.5);
        ctx.lineTo(p.x + r * 0.5, p.y + r * 0.5);
        ctx.moveTo(p.x + r * 0.5, p.y - r * 0.5);
        ctx.lineTo(p.x - r * 0.5, p.y + r * 0.5);
        ctx.stroke();
      } else if (!unit.onField) {
        ctx.strokeStyle = '#ffb0b0';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }

      // labels
      ctx.globalAlpha = faded ? 0.5 : 1;
      ctx.fillStyle = '#dfe8f3';
      ctx.font = '600 11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(unit.id, p.x, p.y + r + 6);
      ctx.fillStyle = 'rgba(220,230,240,.7)';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(`${unit.hp}/${maxHp}`, p.x, p.y + r + 19);
      if (!unit.onField) {
        ctx.fillStyle = '#ff9d9d';
        ctx.fillText('离场', p.x, p.y + r + 32);
      } else if (!unit.alive) {
        ctx.fillStyle = '#ff9d9d';
        ctx.fillText('阵亡', p.x, p.y + r + 32);
      }
      ctx.restore();
    }
  }

  _drawHighlights(ctx, frame, currentTick) {
    ctx.save();
    for (const prop of frame.propagations) {
      if (!prop.originPos) continue;
      const p = this.project(prop.originPos.x, prop.originPos.y);
      ctx.strokeStyle = 'rgba(110,168,254,.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Flash units that were hit in the current frame's tick.
    for (const edge of frame.resolved) {
      if (edge.resolvedTick !== currentTick) continue;
      const unit = frame.units.find((u) => u.id === edge.toId);
      if (!unit) continue;
      const p = this.project(unit.x, unit.y);
      ctx.strokeStyle = edge.status === 'applied' ? 'rgba(78,201,168,.9)' : 'rgba(214,87,87,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 23, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

export { REASON, REASON_SHORT };

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
