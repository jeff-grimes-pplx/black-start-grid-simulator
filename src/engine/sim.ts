import { solvePowerFlow, type Network, type SolveResult } from "../solver/powerflow";
import { frequencyRideThrough, voltageRideThrough, BANDS } from "./protection";
import type { Action, Command, BranchState, BusState, GameEvent, IslandState, LoadBlock, Scenario, ScenarioUnit, UnitState } from "./types";

export const DT = 0.25; // physics step, sim seconds
const DROOP = 0.05;
const DEADBAND = 0.036; // Hz
const GOV_CAP = 0.3; // fraction of rating
const LOAD_D = 1.0; // % load change per % frequency change
const T_SECONDARY = 60; // s
const CRANK_RAMP_S = 300;
const CRANK_PF = 0.85;
const STE_TRIP_S = 60;
const LTE_TRIP_S = 900;
const WIN_HOLD_S = 60;
export const BLOCK_FRACTIONS = [0.05, 0.1, 0.2, 0.3, 0.35];
const GOV_LAG: Record<string, number> = { hydro: 1.0, ct: 0.6, steam: 2.5, nuclear: 4.0, syncon: 1 };

export interface Snapshot {
  t: number; step: number; buses: BusState[]; branches: BranchState[]; units: UnitState[]; islands: IslandState[];
  log: GameEvent[]; stats: Stats;
}
export interface Stats {
  servedMW: number; totalMW: number; blocksOn: number; blocksTotal: number; onlineMW: number; onlineCap: number;
  energizedBuses: number; islands: number; won: boolean; winAt: number; trips: number; sheds: number; collapses: number;
  solves: number; nrIterations: number; lastIterations: number; lastSolveMs: number; worstLoading: number; vMin: number; vMax: number;
  violations: string[];
}

export class Simulation {
  readonly sc: Scenario;
  readonly net: Network;
  readonly blocks: LoadBlock[][]; // per bus
  t = 0; step = 0;
  units: UnitState[]; branches: BranchState[]; buses: BusState[]; islands: IslandState[] = [];
  log: GameEvent[] = []; actions: Action[] = [];
  stats: Stats;
  private dirty = true;
  private lastSolveStep = -100;
  private lossesByIsland = new Map<number, number>();
  private nextIslandId = 1;
  private winTimer = 0;
  private uflsCooldown = new Map<number, number>();
  private pickupOrder: { bus: number; step: number }[] = [];

  constructor(sc: Scenario, opts: { damaged?: number[] } = {}) {
    this.sc = sc;
    this.net = {
      baseMVA: sc.baseMVA, nb: sc.buses.length,
      busType: sc.buses.map(() => 1 as 1 | 2 | 3),
      Pd: sc.buses.map(() => 0), Qd: sc.buses.map(() => 0), Gs: sc.buses.map(() => 0), Bs: sc.buses.map(() => 0),
      Vmax: sc.buses.map((b) => b.vmax), Vmin: sc.buses.map((b) => b.vmin), baseKV: sc.buses.map((b) => b.kv),
      branches: sc.branches.map((b) => ({ f: b.f, t: b.t, r: b.r, x: b.x, b: b.b, ratio: b.ratio, shift: b.shift, rateA: b.con, rateB: b.lte, rateC: b.ste, status: 0 })),
      gens: sc.units.map((u) => ({ bus: u.bus, Pg: 0, Qg: 0, Qmax: u.qmax, Qmin: u.qmin, Vg: u.vg, status: 0, Pmax: u.pmax, Pmin: u.pmin, Xd: (u.xd * sc.baseMVA) / u.mvaBase })),
    };
    this.blocks = sc.buses.map((b) => b.pd > 0 ? BLOCK_FRACTIONS.map((fr, i) => ({ bus: b.idx, mw: round3(b.pd * fr), mvar: round3(b.qd * fr), label: `Feeder ${i + 1}` })) : []);
    this.units = sc.units.map(() => ({ status: "off", startedAt: 0, syncAt: 0, crank: 0, loading: false, Pset: 0, Pgov: 0, P: 0, Q: 0, tripReason: "", uvTimer: 0, ovTimer: 0, ufTimer: 0, ofTimer: 0 }));
    this.branches = sc.branches.map((b) => ({ closed: false, damaged: (opts.damaged ?? []).includes(b.idx), tripped: false, loading: 0, Smax: 0, Pf: 0, Qf: 0, Pt: 0, Qt: 0, steTimer: 0, lteTimer: 0, energized: false }));
    this.buses = sc.buses.map((b) => ({ energized: false, island: 0, Vm: 0, Va: 0, blocks: 0, Pd: 0, Qd: 0, qLimit: 0, reactorOn: false, uvTimer: 0, vset: sc.units.find((u) => u.bus === b.idx)?.vg ?? 1, plimit: sc.units.filter((u) => u.bus === b.idx && u.available).reduce((a, u) => a + u.pmax, 0) }));
    const totalMW = sc.buses.reduce((s, b) => s + b.pd, 0);
    this.stats = { servedMW: 0, totalMW: round3(totalMW), blocksOn: 0, blocksTotal: this.blocks.reduce((s, b) => s + b.length, 0), onlineMW: 0, onlineCap: 0, energizedBuses: 0, islands: 0, won: false, winAt: -1, trips: 0, sheds: 0, collapses: 0, solves: 0, nrIterations: 0, lastIterations: 0, lastSolveMs: 0, worstLoading: 0, vMin: 0, vMax: 0, violations: [] };
    for (const k of opts.damaged ?? []) this.event("alarm", `${this.brName(k)} is damaged and cannot be returned to service.`, { branch: k });
  }

  // ---------- naming helpers ----------
  busName(i: number) { const b = this.sc.buses[i]; return `${b.id} ${b.name}`; }
  brName(k: number) { const b = this.sc.branches[k]; return `${b.kind === "transformer" ? "Transformer" : "Line"} ${this.sc.buses[b.f].id}–${this.sc.buses[b.t].id}${b.circuits > 1 ? ` (circuit ${b.circuit})` : ""}`; }
  unitName(g: number) { const u = this.sc.units[g]; return `${u.code}${u.kind === "syncon" ? "" : ` #${u.num}`} at ${this.busName(u.bus)}`; }

  event(level: GameEvent["level"], text: string, ref: Partial<GameEvent> = {}) { this.log.push({ t: this.t, level, text, ...ref }); if (this.log.length > 400) this.log.splice(0, this.log.length - 400); }

  // ---------- operator actions ----------
  /** Validate and apply an action now. Returns {ok, reason}. Accepted actions are appended to the action log with the current step. */
  apply(a: Command): { ok: boolean; reason?: string } {
    const res = this.doAction(a);
    if (res.ok) { this.actions.push({ ...a, t: this.step } as Action); this.dirty = true; }
    return res;
  }

  private doAction(a: Command): { ok: boolean; reason?: string } {
    switch (a.type) {
      case "start": return this.startUnit(a.unit);
      case "stop": return this.stopUnit(a.unit);
      case "close": return this.closeBranch(a.branch);
      case "open": return this.openBranch(a.branch);
      case "pickup": return this.pickup(a.bus);
      case "drop": return this.drop(a.bus);
      case "reactor": return this.reactor(a.bus, a.on);
      case "avr": return this.avr(a.bus, a.vg);
      case "limit": return this.limit(a.bus, a.mw);
    }
  }

  private startUnit(g: number) {
    const u = this.sc.units[g], s = this.units[g];
    if (!u.available) return { ok: false, reason: "Nuclear units need several days to return; they are not available in this restoration." };
    if (s.status === "starting") return { ok: false, reason: "Unit is already starting." };
    if (s.status === "online") return { ok: false, reason: "Unit is already online." };
    const bus = this.buses[u.bus];
    if (!u.blackStart) {
      if (!bus.energized) return { ok: false, reason: `${this.busName(u.bus)} is dead. A ${u.kind === "syncon" ? "condenser" : "steam unit"} needs station service from an energized bus before it can start.` };
      if (bus.Vm < 0.9) return { ok: false, reason: `Bus voltage ${bus.Vm.toFixed(3)} pu is below 0.90. Raise voltage before cranking auxiliaries.` };
      const isl = this.islands.find((i) => i.id === bus.island);
      if (isl && (isl.f < BANDS.fShed || isl.f > 60.5)) return { ok: false, reason: `Island frequency ${isl.f.toFixed(2)} Hz is outside 59.5–60.5 Hz. Stabilize frequency before cranking.` };
    }
    s.status = "starting"; s.startedAt = this.t; s.syncAt = this.t + (u.startMin ?? 0) * 60; s.crank = 0; s.Pset = 0; s.Pgov = 0; s.tripReason = "";
    s.uvTimer = s.ovTimer = s.ufTimer = s.ofTimer = 0;
    const mins = u.startMin ?? 0;
    this.event("info", u.blackStart ? `${this.unitName(g)} black-start sequence begun. Synchronizes in ${mins} min.` : u.kind === "syncon" ? `${this.unitName(g)} starting as a motor; on line in ${mins} min.` : `${this.unitName(g)} cranking: ${u.crankMW.toFixed(1)} MW of auxiliaries ramp in over 5 min; hot start takes ${mins / 60} h.`, { unit: g });
    return { ok: true };
  }

  private stopUnit(g: number) {
    const s = this.units[g];
    if (s.status === "off" || s.status === "tripped") return { ok: false, reason: "Unit is not running." };
    const was = s.status;
    s.status = "off"; s.crank = 0; s.Pset = 0; s.Pgov = 0; s.P = 0; s.Q = 0;
    this.event("warn", was === "starting" ? `${this.unitName(g)} start cancelled.` : `${this.unitName(g)} taken off line by the operator.`, { unit: g });
    return { ok: true };
  }

  private closeBranch(k: number) {
    const br = this.sc.branches[k], s = this.branches[k];
    if (s.damaged) return { ok: false, reason: `${this.brName(k)} is damaged; crews have not released it.` };
    if (s.closed) return { ok: false, reason: "Breaker is already closed." };
    const bf = this.buses[br.f], bt = this.buses[br.t];
    if (bf.energized && bt.energized) {
      if (bf.island !== bt.island) {
        const If = this.islands.find((i) => i.id === bf.island)!, It = this.islands.find((i) => i.id === bt.island)!;
        const df = Math.abs(If.f - It.f), dv = Math.abs(bf.Vm - bt.Vm);
        if (df > BANDS.syncDf) return { ok: false, reason: `Sync check blocked the close: Δf = ${df.toFixed(2)} Hz between the two islands (limit ${BANDS.syncDf} Hz).` };
        if (dv > BANDS.syncDv) return { ok: false, reason: `Sync check blocked the close: ΔV = ${dv.toFixed(3)} pu across the breaker (limit ${BANDS.syncDv} pu).` };
        s.closed = true; s.tripped = false;
        this.event("ok", `${this.brName(k)} closed — islands synchronized (Δf ${df.toFixed(2)} Hz, ΔV ${dv.toFixed(3)} pu).`, { branch: k });
        return { ok: true };
      }
      const ang = Math.abs(((bf.Va - bt.Va) * 180) / Math.PI);
      if (ang > BANDS.loopAngleDeg) return { ok: false, reason: `Standing angle ${ang.toFixed(1)}° across the open breaker exceeds ${BANDS.loopAngleDeg}°. Shift generation or load to reduce flow on the parallel path first.` };
      s.closed = true; s.tripped = false;
      this.event("ok", `${this.brName(k)} closed — loop completed (standing angle ${ang.toFixed(1)}°).`, { branch: k });
      return { ok: true };
    }
    s.closed = true; s.tripped = false;
    if (bf.energized || bt.energized) {
      const dead = bf.energized ? br.t : br.f;
      this.event("ok", `${this.brName(k)} closed — energizing ${this.busName(dead)}${br.kind === "line" ? ` (${br.miles} mi, ${(br.b * this.sc.baseMVA).toFixed(0)} Mvar charging at 1 pu)` : ""}.`, { branch: k });
    } else this.event("info", `${this.brName(k)} closed (both ends dead).`, { branch: k });
    return { ok: true };
  }

  private openBranch(k: number) {
    const s = this.branches[k];
    if (!s.closed) return { ok: false, reason: "Breaker is already open." };
    s.closed = false; s.steTimer = s.lteTimer = 0;
    this.event("info", `${this.brName(k)} opened by the operator.`, { branch: k });
    return { ok: true };
  }

  private pickup(i: number) {
    const b = this.buses[i], blocks = this.blocks[i];
    if (!blocks.length) return { ok: false, reason: `${this.busName(i)} has no load.` };
    if (!b.energized) return { ok: false, reason: `${this.busName(i)} is dead; energize it before picking up load.` };
    if (b.blocks >= blocks.length) return { ok: false, reason: "All feeders at this bus are already in service." };
    const blk = blocks[b.blocks];
    b.blocks++;
    this.pickupOrder.push({ bus: i, step: this.step });
    this.event("ok", `${this.busName(i)}: ${blk.label} picked up (+${blk.mw.toFixed(1)} MW, +${blk.mvar.toFixed(1)} Mvar).`, { bus: i });
    return { ok: true };
  }

  private drop(i: number) {
    const b = this.buses[i];
    if (b.blocks <= 0) return { ok: false, reason: "No feeders are in service at this bus." };
    b.blocks--;
    const blk = this.blocks[i][b.blocks];
    this.event("warn", `${this.busName(i)}: ${blk.label} dropped by the operator (−${blk.mw.toFixed(1)} MW).`, { bus: i });
    return { ok: true };
  }

  private reactor(i: number, on: boolean) {
    const r = this.sc.reactors.find((r) => r.bus === i);
    if (!r) return { ok: false, reason: "No shunt reactor at this bus." };
    if (this.buses[i].reactorOn === on) return { ok: false, reason: on ? "Reactor already in service." : "Reactor already out." };
    this.buses[i].reactorOn = on;
    this.event("info", `${this.busName(i)}: ${r.mvar.toFixed(0)} Mvar shunt reactor ${on ? "switched in (absorbs line charging)" : "switched out"}.`, { bus: i });
    return { ok: true };
  }

  private avr(i: number, vg: number) {
    if (!this.sc.units.some((u) => u.bus === i && u.available)) return { ok: false, reason: "No generating plant at this bus." };
    const v = Math.round(vg * 1000) / 1000;
    if (v < 0.95 || v > 1.05) return { ok: false, reason: "Voltage setpoint must stay between 0.95 and 1.05 pu." };
    if (Math.abs(this.buses[i].vset - v) < 1e-9) return { ok: false, reason: "Setpoint unchanged." };
    this.buses[i].vset = v;
    this.event("info", `${this.busName(i)}: plant voltage setpoint ${v.toFixed(3)} pu.`, { bus: i });
    return { ok: true };
  }

  private limit(i: number, mw: number) {
    const cap = this.sc.units.filter((u) => u.bus === i && u.available).reduce((a, u) => a + u.pmax, 0);
    if (cap <= 0) return { ok: false, reason: "No generating plant at this bus." };
    const v = Math.round(mw);
    if (v < 0 || v > cap) return { ok: false, reason: `Plant limit must be between 0 and ${cap} MW.` };
    if (v === Math.round(this.buses[i].plimit)) return { ok: false, reason: "Limit unchanged." };
    this.buses[i].plimit = v;
    this.event("info", `${this.busName(i)}: plant dispatch limit ${v} MW${v < cap ? ` (of ${cap} MW installed)` : " (no limit)"}.`, { bus: i });
    return { ok: true };
  }

  /** Dispatch ceiling for a unit: its rating scaled by the plant's dispatch limit. */
  unitCap(g: number) {
    const u = this.sc.units[g], b = this.buses[u.bus];
    const cap = this.sc.units.filter((x) => x.bus === u.bus && x.available).reduce((a, x) => a + x.pmax, 0);
    return cap > 0 ? Math.min(u.pmax, (u.pmax * b.plimit) / cap) : u.pmax;
  }

  // ---------- time ----------
  /** Advance by a number of whole physics steps. */
  advance(steps: number) { for (let i = 0; i < steps; i++) this.physicsStep(); }
  /** Advance by sim seconds (rounded to whole steps). */
  advanceSeconds(sec: number) { this.advance(Math.round(sec / DT)); }

  private physicsStep() {
    const t = this.t;
    // 1. unit start / sync timers. Black-start units of one plant started within 10 s of each other come on line together
    //    when the first is ready, so a single machine never energizes the plant's closed network alone.
    const plantDue = new Map<number, number>();
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (s.status === "starting" && u.blackStart && !this.buses[u.bus].energized) plantDue.set(u.bus, Math.min(plantDue.get(u.bus) ?? Infinity, s.syncAt));
    }
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (s.status !== "starting") continue;
      const bus = this.buses[u.bus];
      const due = plantDue.get(u.bus); if (due !== undefined && u.blackStart && t + 1e-9 >= due && s.syncAt <= due + 10) s.syncAt = Math.min(s.syncAt, t);
      if (!u.blackStart) {
        if (!bus.energized) { s.status = "off"; s.crank = 0; this.event("alarm", `${this.unitName(g)} start aborted — station service lost.`, { unit: g }); this.dirty = true; continue; }
        const target = u.crankMW * Math.min(1, (t - s.startedAt) / CRANK_RAMP_S);
        if (Math.abs(target - s.crank) > 1e-6) { s.crank = target; this.dirty = true; }
      }
      if (t + 1e-9 >= s.syncAt) {
        s.status = "online"; s.loading = true; s.Pset = 0; s.Pgov = 0; this.dirty = true; // auxiliaries transfer to the unit's own output over the next minutes
        this.event("ok", bus.energized ? `${this.unitName(g)} synchronized to the ${u.kind === "syncon" ? "system" : "island"}.` : `${this.unitName(g)} on line — energizing ${this.busName(u.bus)} at ${bus.vset.toFixed(3)} pu.`, { unit: g });
      }
    }
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (s.status === "online" && s.crank > 0) { s.crank = Math.max(0, s.crank - (u.crankMW * DT) / CRANK_RAMP_S); this.dirty = true; }
    }
    // 2. topology / islands
    this.rebuildIslands();
    // 3. per-island frequency dynamics (uses losses from the last power flow)
    for (const isl of this.islands) this.frequencyStep(isl);
    // 4. power flow when needed
    const periodic = this.step - this.lastSolveStep >= 8;
    if (this.dirty || periodic) { this.solveAll(); this.lastSolveStep = this.step; this.dirty = false; }
    // 5. protection
    this.protectionStep();
    // 6. bookkeeping
    this.t = round3(this.t + DT); this.step++;
    this.updateStats();
    for (const isl of this.islands) { isl.fTrace.push(isl.f); if (isl.fTrace.length > 480) isl.fTrace.shift(); }
  }

  private rebuildIslands() {
    const nb = this.sc.buses.length;
    const adj: number[][] = Array.from({ length: nb }, () => []);
    for (let k = 0; k < this.sc.branches.length; k++) {
      const s = this.branches[k]; if (!s.closed || s.damaged) continue;
      const b = this.sc.branches[k]; adj[b.f].push(b.t); adj[b.t].push(b.f);
    }
    const comp = new Int32Array(nb).fill(-1); const comps: number[][] = [];
    for (let i = 0; i < nb; i++) {
      if (comp[i] >= 0) continue;
      const q = [i]; comp[i] = comps.length; const list: number[] = [];
      while (q.length) { const x = q.pop()!; list.push(x); for (const y of adj[x]) if (comp[y] < 0) { comp[y] = comps.length; q.push(y); } }
      comps.push(list);
    }
    const onlineGenBuses = new Set<number>();
    for (let g = 0; g < this.sc.units.length; g++) if (this.units[g].status === "online" && this.sc.units[g].kind !== "syncon") onlineGenBuses.add(this.sc.units[g].bus);
    const next: IslandState[] = [];
    for (const list of comps) {
      if (!list.some((b) => onlineGenBuses.has(b))) continue;
      // inherit identity (and frequency) from the previous island holding most of these buses, weighted by inertia
      const prev = new Map<number, number>();
      for (const b of list) { const id = this.buses[b].island; if (id) prev.set(id, (prev.get(id) ?? 0) + 1); }
      let fsum = 0, wsum = 0, bestId = 0, bestN = 0;
      for (const [id, n] of prev) { const p = this.islands.find((i) => i.id === id); if (!p) continue; const w = Math.max(p.Hsum, 1); fsum += p.f * w; wsum += w; if (n > bestN) { bestN = n; bestId = id; } }
      const f = wsum > 0 ? fsum / wsum : this.sc.f0;
      const old = this.islands.find((i) => i.id === bestId);
      const id = bestId && !next.some((i) => i.id === bestId) ? bestId : this.nextIslandId++;
      next.push({ id, buses: list, f, slackBus: -1, Pgen: 0, Pload: 0, Hsum: 0, converged: true, iterations: 0, collapsed: false, genCap: 0, droopK: 0, fTrace: old && id === bestId ? old.fTrace : [] });
    }
    const alive = new Set<number>();
    for (const isl of next) for (const b of isl.buses) { alive.add(b); this.buses[b].island = isl.id; }
    for (let b = 0; b < nb; b++) {
      const bs = this.buses[b];
      if (alive.has(b)) { if (!bs.energized) { bs.energized = true; this.dirty = true; } continue; }
      if (bs.energized || bs.island) {
        // bus went dead: loads are lost, cranking stops
        if (bs.blocks > 0) { const lost = this.blocks[b].slice(0, bs.blocks).reduce((s, x) => s + x.mw, 0); this.event("alarm", `${this.busName(b)} de-energized — ${lost.toFixed(0)} MW of load lost.`, { bus: b }); bs.blocks = 0; }
        bs.energized = false; bs.island = 0; bs.Vm = 0; bs.Va = 0; bs.Pd = bs.Qd = 0; bs.qLimit = 0; bs.uvTimer = 0; this.dirty = true;
      }
    }
    this.islands = next;
    // wire island aggregates (capacity, inertia, droop gain)
    for (const isl of this.islands) {
      let H = 0, cap = 0, K = 0;
      for (let g = 0; g < this.sc.units.length; g++) {
        const u = this.sc.units[g], s = this.units[g];
        if (s.status !== "online" || this.buses[u.bus].island !== isl.id) continue;
        H += u.H * u.pmax; if (u.kind !== "syncon") { cap += u.pmax; K += u.pmax / (DROOP * this.sc.f0); }
      }
      isl.Hsum = H; isl.genCap = cap; isl.droopK = K;
    }
  }

  private frequencyStep(isl: IslandState) {
    const f0 = this.sc.f0;
    const df = isl.f - f0;
    const units: number[] = [];
    for (let g = 0; g < this.sc.units.length; g++) if (this.units[g].status === "online" && this.buses[this.sc.units[g].bus].island === isl.id && this.sc.units[g].kind !== "syncon") units.push(g);
    if (!units.length) return;
    // electrical demand: served load with frequency sensitivity + cranking + network losses from the last solve
    let Pload = 0;
    for (const b of isl.buses) {
      const bs = this.buses[b];
      let p = 0; for (let i = 0; i < bs.blocks; i++) p += this.blocks[b][i].mw;
      Pload += p * (1 + (LOAD_D * df) / f0);
      for (let g = 0; g < this.sc.units.length; g++) if (this.sc.units[g].bus === b && this.units[g].crank > 0) Pload += this.units[g].crank;
    }
    Pload += this.lossesByIsland.get(isl.id) ?? 0;
    // governors: droop with deadband, first-order turbine lag, capped at 30 % of rating and by headroom
    let e = df; if (Math.abs(e) < DEADBAND) e = 0; else e -= Math.sign(e) * DEADBAND;
    // minimum stable generation applies once the island carries enough load for it; below that the minimums scale down
    let pminSum = 0; for (const g of units) pminSum += this.sc.units[g].pmin;
    const minScale = pminSum > 0 ? Math.min(1, Pload / pminSum) : 0;
    let Pm = 0, govSum = 0;
    for (const g of units) {
      const u = this.sc.units[g], s = this.units[g];
      const low = Math.min(u.pmin * minScale, this.unitCap(g));
      let target = -((u.pmax / DROOP) * e) / f0;
      target = Math.max(-GOV_CAP * u.pmax, Math.min(GOV_CAP * u.pmax, target));
      target = Math.max(-s.Pset, Math.min(u.pmax - s.Pset, target));
      if (s.loading) { if (s.Pset >= low - 1e-9) s.loading = false; else target = Math.min(0, target); } // loading up to minimum: no upward primary response yet
      const a = 1 - Math.exp(-DT / (GOV_LAG[u.kind] ?? 2));
      s.Pgov += (target - s.Pgov) * a;
      Pm += s.Pset + s.Pgov; govSum += s.Pgov;
    }
    // secondary control: move setpoints to take over the governor contribution (shared by rating, limited by AGC ramp and
    // by each plant's dispatch limit); units below their minimum keep ramping up at their AGC rate regardless.
    const correction = (govSum * DT) / T_SECONDARY;
    let shareCap = 0;
    for (const g of units) { const u = this.sc.units[g], s = this.units[g]; const cap = this.unitCap(g); if (s.Pset >= Math.min(u.pmin * minScale, cap) - 1e-9 && (correction <= 0 ? s.Pset > 0 : s.Pset < cap - 1e-9)) shareCap += u.pmax; }
    for (const g of units) {
      const u = this.sc.units[g], s = this.units[g];
      const ramp = (u.agcRampMWmin * DT) / 60, cap = this.unitCap(g), low = Math.min(u.pmin * minScale, cap);
      if (s.Pset > cap + 1e-9) { s.Pset = Math.max(cap, s.Pset - ramp); continue; }
      if (s.Pset < low - 1e-9) { s.Pset = Math.min(low, s.Pset + ramp); continue; }
      if (shareCap <= 0) continue;
      if (correction <= 0 ? s.Pset <= 0 : s.Pset >= cap - 1e-9) continue;
      let d = (correction * u.pmax) / shareCap;
      d = Math.max(-ramp, Math.min(ramp, d));
      s.Pset = Math.max(low, Math.min(cap, s.Pset + d));
    }
    // swing equation on the island's aggregate inertia
    const M = (2 * Math.max(isl.Hsum, 1)) / f0; // MW·s per Hz
    const acc = (Pm - Pload) / M;
    isl.f += acc * DT;
    isl.Pgen = Pm; isl.Pload = Pload;
    if (Math.abs(Pm - Pload) > 0.5) this.dirty = true;
  }

  private solveAll() {
    const net = this.net, sc = this.sc;
    for (let i = 0; i < sc.buses.length; i++) { net.busType[i] = 1; net.Pd[i] = 0; net.Qd[i] = 0; net.Bs[i] = 0; }
    for (let k = 0; k < sc.branches.length; k++) { const s = this.branches[k]; net.branches[k].status = s.closed && !s.damaged ? 1 : 0; }
    for (let g = 0; g < sc.units.length; g++) net.gens[g].status = 0;
    const t0 = performance.now();
    for (const isl of this.islands) this.solveIsland(isl);
    this.stats.lastSolveMs = performance.now() - t0;
    // branch results
    for (let k = 0; k < sc.branches.length; k++) {
      const s = this.branches[k];
      if (!s.closed || s.damaged || !this.buses[sc.branches[k].f].energized) { s.loading = 0; s.Smax = 0; s.Pf = s.Qf = s.Pt = s.Qt = 0; s.energized = false; s.steTimer = s.lteTimer = 0; }
    }
  }

  private solveIsland(isl: IslandState) {
    const net = this.net, sc = this.sc, f0 = sc.f0;
    const df = isl.f - f0;
    const online: number[] = [];
    for (let g = 0; g < sc.units.length; g++) if (this.units[g].status === "online" && this.buses[sc.units[g].bus].island === isl.id) online.push(g);
    // choose slack: bus with the largest online capacity
    const capByBus = new Map<number, number>();
    for (const g of online) if (sc.units[g].kind !== "syncon") capByBus.set(sc.units[g].bus, (capByBus.get(sc.units[g].bus) ?? 0) + sc.units[g].pmax);
    let slack = -1, best = -1; for (const [b, c] of capByBus) if (c > best) { best = c; slack = b; }
    isl.slackBus = slack;
    for (const b of isl.buses) {
      const bs = this.buses[b];
      let p = 0, q = 0; for (let i = 0; i < bs.blocks; i++) { p += this.blocks[b][i].mw; q += this.blocks[b][i].mvar; }
      p *= 1 + (LOAD_D * df) / f0;
      let crank = 0; for (let g = 0; g < sc.units.length; g++) if (sc.units[g].bus === b && this.units[g].crank > 0) crank += this.units[g].crank;
      net.Pd[b] = p + crank; net.Qd[b] = q + crank * Math.tan(Math.acos(CRANK_PF));
      bs.Pd = net.Pd[b]; bs.Qd = net.Qd[b];
      const r = sc.reactors.find((r) => r.bus === b); net.Bs[b] = r && bs.reactorOn ? -r.mvar : 0;
      net.busType[b] = capByBus.has(b) || online.some((g) => sc.units[g].bus === b) ? 2 : 1;
    }
    if (slack < 0) return;
    net.busType[slack] = 3;
    let Hsum = 0; for (const g of online) Hsum += sc.units[g].H * sc.units[g].pmax;
    const setPg = (fn: (g: number) => number) => { for (const g of online) { net.gens[g].status = 1; net.gens[g].Vg = this.buses[sc.units[g].bus].vset; net.gens[g].Pg = sc.units[g].kind === "syncon" ? 0 : fn(g); } };
    setPg((g) => this.units[g].Pset + this.units[g].Pgov);
    const Vm0 = isl.buses.map(() => 1), Va0 = isl.buses.map(() => 0);
    const warm = isl.buses.every((b) => this.buses[b].Vm > 0.5);
    const opts = { tol: 1e-8, maxIter: 25, enforceQLims: true, buses: isl.buses, Vm0: warm ? this.buses.map((b) => b.Vm) : undefined, Va0: warm ? this.buses.map((b) => b.Va) : undefined };
    void Vm0; void Va0;
    let res = solvePowerFlow(net, opts);
    if (!res.converged && warm) res = solvePowerFlow(net, { ...opts, Vm0: undefined, Va0: undefined });
    this.stats.solves++; this.stats.nrIterations += res.totalIterations; this.stats.lastIterations = res.totalIterations;
    if (res.converged) {
      // distribute the slack mismatch over all units in proportion to inertia and re-solve once (distributed slack)
      let slackPm = 0, slackP = 0;
      for (const g of online) if (sc.units[g].bus === slack && sc.units[g].kind !== "syncon") { slackPm += this.units[g].Pset + this.units[g].Pgov; slackP += res.genP[g]; }
      const imbalance = slackP - slackPm;
      if (Math.abs(imbalance) > 0.5 && Hsum > 0) {
        setPg((g) => this.units[g].Pset + this.units[g].Pgov + (imbalance * sc.units[g].H * sc.units[g].pmax) / Hsum);
        const res2 = solvePowerFlow(net, { ...opts, Vm0: res.Vm, Va0: res.Va });
        this.stats.solves++; this.stats.nrIterations += res2.totalIterations; this.stats.lastIterations += res2.totalIterations;
        if (res2.converged) res = res2;
      }
    }
    isl.converged = res.converged; isl.iterations = res.totalIterations;
    if (res.converged) for (const b of isl.buses) if (!(res.Vm[b] > 0.5 && res.Vm[b] < 1.5)) { isl.converged = false; res = { ...res, converged: false, reason: `voltage solution left the physical range (${res.Vm[b].toFixed(2)} pu at ${this.busName(b)})` }; break; }
    if (!isl.converged) { this.collapse(isl, res); return; }
    for (const b of isl.buses) { const bs = this.buses[b]; bs.Vm = res.Vm[b]; bs.Va = res.Va[b]; bs.qLimit = res.busQLimit[b]; }
    for (const g of online) { this.units[g].P = res.genP[g]; this.units[g].Q = res.genQ[g]; }
    this.lossesByIsland.set(isl.id, res.lossesMW);
    for (const fl of res.flows) {
      const s = this.branches[fl.idx]; const br = sc.branches[fl.idx];
      if (!fl.energized || this.buses[br.f].island !== isl.id) continue;
      s.energized = true; s.Smax = fl.Smax; s.loading = fl.Smax / br.con; s.Pf = fl.Pf; s.Qf = fl.Qf; s.Pt = fl.Pt; s.Qt = fl.Qt;
    }
  }

  private collapse(isl: IslandState, res: SolveResult) {
    isl.collapsed = true; this.stats.collapses++;
    let worstBus = -1, worstV = 9;
    for (const b of isl.buses) { const v = this.buses[b].Vm; if (v > 0 && v < worstV) { worstV = v; worstBus = b; } }
    const load = isl.buses.reduce((s, b) => s + this.net.Pd[b], 0), qload = isl.buses.reduce((s, b) => s + this.net.Qd[b], 0);
    let qcap = 0, qabs = 0; for (let g = 0; g < this.sc.units.length; g++) if (this.units[g].status === "online" && this.buses[this.sc.units[g].bus].island === isl.id) { qcap += this.sc.units[g].qmax; qabs += -this.sc.units[g].qmin; }
    let qcharge = 0; for (let k = 0; k < this.sc.branches.length; k++) { const s = this.branches[k], br = this.sc.branches[k]; if (s.closed && !s.damaged && isl.buses.includes(br.f)) qcharge += br.b * this.sc.baseMVA; }
    for (const b of isl.buses) qcharge += this.net.Bs[b];
    const surplus = qcharge > qload + qabs;
    const why = surplus
      ? `Reactive surplus: ${qcharge.toFixed(0)} Mvar of line charging against ${qload.toFixed(0)} Mvar of load and ${qabs.toFixed(0)} Mvar of absorbing capability. Voltage ran away upward${worstBus >= 0 ? ` (last solved: ${this.busName(worstBus)} ${worstV.toFixed(3)} pu)` : ""}.`
      : `Reactive deficit: ${load.toFixed(0)} MW / ${qload.toFixed(0)} Mvar of demand with ${qcap.toFixed(0)} Mvar of reactive capability on line; the network could not hold voltage${worstBus >= 0 ? ` (weakest bus ${this.busName(worstBus)} at ${worstV.toFixed(3)} pu)` : ""}.`;
    this.event("trip", `Voltage collapse in island ${isl.id}. ${why} Every unit in the island tripped and its load is lost. [solver: ${res.reason}]`);
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (this.buses[u.bus].island !== isl.id) continue;
      if (s.status === "online") { s.status = "tripped"; s.tripReason = "voltage collapse"; this.stats.trips++; }
      if (s.status === "starting") { s.status = "off"; }
      s.P = s.Q = s.Pset = s.Pgov = s.crank = 0;
    }
    for (const b of isl.buses) { const bs = this.buses[b]; bs.blocks = 0; bs.energized = false; bs.island = 0; bs.Vm = 0; bs.Va = 0; bs.Pd = bs.Qd = 0; }
    for (let k = 0; k < this.sc.branches.length; k++) { const br = this.sc.branches[k]; if (isl.buses.includes(br.f)) { const s = this.branches[k]; s.energized = false; s.loading = 0; s.Smax = 0; } }
    this.islands = this.islands.filter((i) => i !== isl);
    this.dirty = true;
  }

  private protectionStep() {
    const sc = this.sc;
    // branch thermal protection
    for (let k = 0; k < sc.branches.length; k++) {
      const s = this.branches[k], br = sc.branches[k];
      if (!s.energized) continue;
      if (s.Smax > br.ste) s.steTimer += DT; else s.steTimer = Math.max(0, s.steTimer - DT);
      if (s.Smax > br.lte) s.lteTimer += DT; else s.lteTimer = Math.max(0, s.lteTimer - DT);
      if (s.steTimer >= STE_TRIP_S || s.lteTimer >= LTE_TRIP_S) {
        s.closed = false; s.tripped = true; s.steTimer = s.lteTimer = 0; this.stats.trips++; this.dirty = true;
        this.event("trip", `${this.brName(k)} tripped on overload: ${s.Smax.toFixed(0)} MVA against a ${s.Smax > br.ste ? `${br.ste.toFixed(0)} MVA short-time` : `${br.lte.toFixed(0)} MVA long-time`} emergency rating (continuous ${br.con.toFixed(0)} MVA).`, { branch: k });
      }
    }
    // generator frequency / voltage protection (PRC-024-3 boundaries) and UFLS
    for (const isl of this.islands) {
      const tf = frequencyRideThrough(isl.f);
      const tripped: { g: number; reason: string }[] = [];
      for (let g = 0; g < sc.units.length; g++) {
        const u = sc.units[g], s = this.units[g];
        if (s.status !== "online" || this.buses[u.bus].island !== isl.id) continue;
        if (isl.f < 59.5) { s.ufTimer += tf === 0 ? 1 : DT / tf; s.ofTimer = 0; } else if (isl.f > 60.5) { s.ofTimer += tf === 0 ? 1 : DT / tf; s.ufTimer = 0; } else { s.ufTimer = Math.max(0, s.ufTimer - DT / 30); s.ofTimer = Math.max(0, s.ofTimer - DT / 30); }
        const v = this.buses[u.bus].Vm; const tv = voltageRideThrough(v);
        if (v < 0.9) { s.uvTimer += tv === 0 ? 1 : DT / tv; s.ovTimer = 0; } else if (v >= 1.1) { s.ovTimer += tv === 0 ? 1 : DT / tv; s.uvTimer = 0; } else { s.uvTimer = Math.max(0, s.uvTimer - DT / 10); s.ovTimer = Math.max(0, s.ovTimer - DT / 10); }
        let reason = "";
        if (s.ufTimer >= 1) reason = `under-frequency (${isl.f.toFixed(2)} Hz is outside the PRC-024 no-trip zone)`;
        else if (s.ofTimer >= 1) reason = `over-frequency (${isl.f.toFixed(2)} Hz is outside the PRC-024 no-trip zone)`;
        else if (s.uvTimer >= 1) reason = tv === 0 ? `under-voltage (${v.toFixed(3)} pu at the plant bus, below the 0.45 pu instantaneous PRC-024 boundary)` : `under-voltage (${v.toFixed(3)} pu at the plant bus for longer than PRC-024 allows)`;
        else if (s.ovTimer >= 1) reason = tv === 0 ? `over-voltage (${v.toFixed(3)} pu at the plant bus, above the 1.20 pu instantaneous PRC-024 boundary)` : `over-voltage (${v.toFixed(3)} pu at the plant bus for longer than PRC-024 allows)`;
        if (reason) { s.status = "tripped"; s.tripReason = reason; s.P = s.Q = s.Pset = s.Pgov = 0; s.ufTimer = s.ofTimer = s.uvTimer = s.ovTimer = 0; this.stats.trips++; this.dirty = true; tripped.push({ g, reason }); }
      }
      // one log entry per plant and cause: units of one plant that trip in the same step for the same reason share it
      const groups = new Map<string, { g: number; reason: string }[]>();
      for (const t of tripped) { const u = sc.units[t.g], key = `${u.bus}|${u.code}|${t.reason}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(t); }
      for (const grp of groups.values()) {
        const u0 = sc.units[grp[0].g];
        if (grp.length === 1 || u0.kind === "syncon") { for (const t of grp) this.event("trip", `${this.unitName(t.g)} tripped on ${t.reason}.`, { unit: t.g }); continue; }
        const nums = grp.map((t) => `#${sc.units[t.g].num}`);
        this.event("trip", `${u0.code} ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]} at ${this.busName(u0.bus)} tripped on ${grp[0].reason}.`, { unit: grp[0].g });
      }
      // under-frequency load shedding: at 59.3 Hz the most recently picked-up feeder in the island is shed
      const cd = this.uflsCooldown.get(isl.id) ?? 0;
      if (isl.f <= BANDS.fUFLS && this.t >= cd) {
        for (let i = this.pickupOrder.length - 1; i >= 0; i--) {
          const po = this.pickupOrder[i];
          if (this.buses[po.bus].island !== isl.id || this.buses[po.bus].blocks <= 0) continue;
          const bs = this.buses[po.bus]; bs.blocks--; const blk = this.blocks[po.bus][bs.blocks];
          this.pickupOrder.splice(i, 1); this.stats.sheds++; this.dirty = true; this.uflsCooldown.set(isl.id, this.t + 1.0);
          this.event("trip", `Under-frequency load shedding at ${isl.f.toFixed(2)} Hz: ${blk.label} at ${this.busName(po.bus)} shed (−${blk.mw.toFixed(1)} MW). Generation could not follow the last pickup.`, { bus: po.bus });
          break;
        }
      }
    }
    // if units tripped, islands may have lost their last source; rebuild immediately so the display is consistent
    if (this.dirty) { this.rebuildIslands(); this.solveAll(); this.lastSolveStep = this.step; this.dirty = false; }
  }

  private updateStats() {
    const st = this.stats;
    let served = 0, blocksOn = 0, onlineMW = 0, cap = 0, eb = 0, worst = 0, vmin = 9, vmax = 0;
    for (let i = 0; i < this.sc.buses.length; i++) {
      const b = this.buses[i];
      for (let k = 0; k < b.blocks; k++) served += this.blocks[i][k].mw;
      blocksOn += b.blocks;
      if (b.energized) { eb++; vmin = Math.min(vmin, b.Vm); vmax = Math.max(vmax, b.Vm); }
    }
    for (let g = 0; g < this.sc.units.length; g++) if (this.units[g].status === "online" && this.sc.units[g].kind !== "syncon") { onlineMW += this.units[g].P; cap += this.sc.units[g].pmax; }
    for (const s of this.branches) worst = Math.max(worst, s.loading);
    st.servedMW = served; st.blocksOn = blocksOn; st.onlineMW = onlineMW; st.onlineCap = cap; st.energizedBuses = eb; st.islands = this.islands.length; st.worstLoading = worst; st.vMin = eb ? vmin : 0; st.vMax = eb ? vmax : 0;
    const viol: string[] = [];
    if (blocksOn < st.blocksTotal) viol.push(`${st.blocksTotal - blocksOn} feeders still dark`);
    if (eb < this.sc.buses.length) viol.push(`${this.sc.buses.length - eb} buses dead`);
    if (this.islands.length > 1) viol.push(`${this.islands.length} separate islands`);
    for (let i = 0; i < this.sc.buses.length; i++) { const b = this.buses[i]; if (b.energized && (b.Vm < this.sc.buses[i].vmin - 1e-6 || b.Vm > this.sc.buses[i].vmax + 1e-6)) viol.push(`${this.busName(i)} at ${b.Vm.toFixed(3)} pu`); }
    for (const isl of this.islands) if (isl.f < BANDS.fLow || isl.f > BANDS.fHigh) viol.push(`island ${isl.id} at ${isl.f.toFixed(2)} Hz`);
    for (let k = 0; k < this.sc.branches.length; k++) if (this.branches[k].loading > 1 + 1e-6) viol.push(`${this.brName(k)} at ${(this.branches[k].loading * 100).toFixed(0)} %`);
    st.violations = viol;
    if (!st.won) {
      if (viol.length === 0 && eb === this.sc.buses.length) { this.winTimer += DT; if (this.winTimer >= WIN_HOLD_S) { st.won = true; st.winAt = this.t; this.event("ok", `Restoration complete: ${served.toFixed(1)} MW on all ${this.sc.counts.loads} load buses, one synchronized system at ${this.islands[0].f.toFixed(2)} Hz, every bus between 0.95 and 1.05 pu, no branch above its continuous rating. Elapsed ${fmtClock(this.t)}.`); } }
      else this.winTimer = 0;
    }
  }

  snapshot(): Snapshot { return { t: this.t, step: this.step, buses: this.buses, branches: this.branches, units: this.units, islands: this.islands, log: this.log, stats: this.stats }; }

  /** Fraction of RTS minimum generation currently enforced in an island (see frequencyStep). */
  private minScale(islandId: number) {
    const isl = this.islands.find((i) => i.id === islandId); if (!isl) return 0;
    let pminSum = 0; for (let g = 0; g < this.sc.units.length; g++) { const u = this.sc.units[g]; if (this.units[g].status === "online" && u.kind !== "syncon" && this.buses[u.bus].island === islandId) pminSum += u.pmin; }
    return pminSum > 0 ? Math.min(1, isl.Pload / pminSum) : 0;
  }

  /** Governor headroom guide plus the dispatch room secondary control still has in an island (both MW). */
  headroom(islandId: number) {
    const ms = this.minScale(islandId);
    let agcRoom = 0;
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (s.status !== "online" || u.kind === "syncon" || this.buses[u.bus].island !== islandId) continue;
      const cap = this.unitCap(g), low = Math.min(u.pmin * ms, cap);
      if (!s.loading || s.Pset >= low - 1e-9) agcRoom += Math.max(0, cap - s.Pset);
    }
    return { guide: this.pickupGuide(islandId), agcRoom };
  }

  /** Headroom guide: load step (MW) that would settle the island at the 59.5 Hz shed threshold under 5 % droop. */
  pickupGuide(islandId: number): number {
    const isl = this.islands.find((i) => i.id === islandId); if (!isl) return 0;
    let head = 0, lagW = 0, capW = 0;
    for (let g = 0; g < this.sc.units.length; g++) {
      const u = this.sc.units[g], s = this.units[g];
      if (s.status !== "online" || u.kind === "syncon" || this.buses[u.bus].island !== islandId) continue;
      const low = Math.min(u.pmin * this.minScale(islandId), this.unitCap(g));
      if (!s.loading || s.Pset >= low - 1e-9) head += Math.max(0, Math.min(GOV_CAP * u.pmax, u.pmax - s.Pset - s.Pgov));
      lagW += (GOV_LAG[u.kind] ?? 2) * u.pmax; capW += u.pmax;
    }
    // nadir/steady-state ratio of the first-order governor model, fitted on the engine itself (1.9 for 1 s lags, 2.5 for 2.5 s lags)
    const factor = 1.9 + 0.4 * (capW > 0 ? lagW / capW - 1 : 0);
    return Math.max(0, Math.min(head, (isl.droopK * (this.sc.f0 - BANDS.fShed - DEADBAND)) / factor));
  }
}

export function fmtClock(t: number) { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; }
function round3(x: number) { return Math.round(x * 1000) / 1000; }

/** Replay an action log deterministically on a fresh simulation. Returns the simulation after the final action plus `tailSteps`. */
export function replay(sc: Scenario, actions: Action[], opts: { damaged?: number[]; tailSteps?: number } = {}): Simulation {
  const sim = new Simulation(sc, { damaged: opts.damaged });
  const sorted = [...actions].sort((a, b) => a.t - b.t);
  for (const a of sorted) { if (a.t > sim.step) sim.advance(a.t - sim.step); sim.apply(a); }
  sim.advance(opts.tailSteps ?? 0);
  return sim;
}

export type { ScenarioUnit };
