// Story lab for the 45 s take: evaluates candidate operator sequences headlessly (voltages, trips, win time).
// usage: npx tsx tests/story_lab.ts
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, type PlanStep } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const plan = buildGuidedPlan(sc);

function log(sim: Simulation, from: number, filter?: RegExp) { for (let i = from; i < sim.log.length; i++) { const e = sim.log[i]; if (!filter || filter.test(e.text) || e.level === "trip" || e.level === "alarm") console.log(`    [${fmtClock(e.t)}] ${e.level.padEnd(5)} ${e.text}`); } return sim.log.length; }
function vmaxOf(sim: Simulation) { let m = 0, at = -1; sim.buses.forEach((b, i) => { if (b.energized && b.Vm > m) { m = b.Vm; at = i; } }); return `${m.toFixed(3)} pu at ${at >= 0 ? `${at + 1} ${sc.buses[at].name}` : "—"}`; }
function adv(sim: Simulation, sec: number) { sim.advance(Math.round(sec / DT)); }

/** Emulates the app's guide in "Run automatically" mode from the current state; returns sim seconds until the win. */
function autoRun(sim: Simulation, startT: number) {
  let idx = 0, enteredAt = sim.t, guard = 0;
  const cmdDone = (c: any, expectBlocks?: number): boolean => {
    switch (c.type) {
      case "start": return sim.units[c.unit].status === "starting" || sim.units[c.unit].status === "online";
      case "stop": return sim.units[c.unit].status === "off";
      case "close": return sim.branches[c.branch].closed;
      case "open": return !sim.branches[c.branch].closed;
      case "pickup": return sim.buses[c.bus].blocks >= (expectBlocks ?? 1);
      case "drop": return true;
      case "reactor": return sim.buses[c.bus].reactorOn === c.on;
      case "avr": return Math.abs(sim.buses[c.bus].vset - c.vg) < 1e-6;
      case "limit": return Math.round(sim.buses[c.bus].plimit) === Math.round(c.mw);
    }
    return false;
  };
  const stepDone = (s: PlanStep) => s.kind === "wait" ? sim.t - enteredAt >= s.seconds - 1e-9 : s.kind === "until" ? s.cond(sim) : cmdDone(s.cmd, s.expectBlocks) && (s.also ?? []).every((c) => cmdDone(c));
  const refusals: string[] = [];
  while (idx < plan.length && guard++ < 2e6) {
    const s = plan[idx];
    if (stepDone(s)) { idx++; enteredAt = sim.t; continue; }
    if (s.kind === "act") { let r = sim.apply(s.cmd); for (const c of s.also ?? []) { if (!r.ok) break; r = sim.apply(c); } if (!r.ok) { refusals.push(`[${fmtClock(sim.t)}] #${idx} ${s.text} -> ${r.reason}`); adv(sim, 450); } else sim.advance(1); continue; }
    sim.advance(1);
  }
  for (let i = 0; i < 480 && !sim.stats.won; i++) sim.advance(1);
  return { refusals, idx };
}

function scenario(name: string, fn: (sim: Simulation) => void) {
  console.log(`\n=== ${name}`);
  const sim = new Simulation(sc);
  fn(sim);
  return sim;
}

// A: default setpoint (1.05 from the case), no 0.98 step
scenario("A: default 1.05 setpoint, close 21-22, 17-22, 16-17 at ~3 s film spacing (10x)", (sim) => {
  let p = 0;
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 610); p = log(sim, p, /on line/);
  console.log("  vset Aubrey", sim.buses[B(22)].vset, "V", vmaxOf(sim));
  for (const [f, t] of [[21, 22], [17, 22], [16, 17]]) { const r = sim.apply({ type: "close", branch: BR(f, t) }); console.log(`  close ${f}-${t}: ${r.ok ? "ok" : r.reason}`); for (let i = 0; i < 120; i++) { sim.advance(1); if (i % 20 === 0) console.log(`     +${(i * DT).toFixed(1)} s  Vmax ${vmaxOf(sim)}  plant ${sim.buses[B(22)].Vm.toFixed(3)}`); } p = log(sim, p, /trip|energiz|de-energ/); }
});

// B: 0.98, three lines, one feeder, then 1.05 and two unloaded lines
scenario("B: 0.98 → start → 3 lines → pickup 16 → 1.05 → 15-21 → 18-21", (sim) => {
  let p = 0;
  sim.apply({ type: "avr", bus: B(22), vg: 0.98 });
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 610); p = log(sim, p, /on line/);
  for (const [f, t] of [[21, 22], [17, 22], [16, 17]]) { sim.apply({ type: "close", branch: BR(f, t) }); adv(sim, 30); }
  p = log(sim, p, /closed/); console.log("  after 3 lines V", vmaxOf(sim));
  const r = sim.apply({ type: "pickup", bus: B(16) }); console.log("  pickup 16:", r.ok ? "ok" : r.reason); adv(sim, 40); p = log(sim, p, /Feeder|pick/);
  sim.apply({ type: "avr", bus: B(22), vg: 1.05 }); adv(sim, 30); console.log("  after 1.05 V", vmaxOf(sim));
  sim.apply({ type: "close", branch: BR(15, 21) }); adv(sim, 30); console.log("  after 15-21 V", vmaxOf(sim), "plant", sim.buses[B(22)].Vm.toFixed(3)); p = log(sim, p, /trip|closed/);
  sim.apply({ type: "close", branch: BR(18, 21) }); for (let i = 0; i < 40; i++) { sim.advance(1); if (i % 4 === 0) console.log(`     +${(i * DT).toFixed(2)} s  Vmax ${vmaxOf(sim)}  plant ${sim.buses[B(22)].Vm.toFixed(3)} trips ${sim.stats.trips}`); } p = log(sim, p, /trip|closed|de-energ/);
});

// C: like B without the feeder
scenario("C: 0.98 → start → 3 lines → 1.05 → 15-21 → 18-21 (no feeder)", (sim) => {
  let p = 0;
  sim.apply({ type: "avr", bus: B(22), vg: 0.98 });
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 610);
  for (const [f, t] of [[21, 22], [17, 22], [16, 17]]) { sim.apply({ type: "close", branch: BR(f, t) }); adv(sim, 30); }
  p = sim.log.length; console.log("  after 3 lines V", vmaxOf(sim));
  sim.apply({ type: "avr", bus: B(22), vg: 1.05 }); adv(sim, 30); console.log("  after 1.05 V", vmaxOf(sim));
  sim.apply({ type: "close", branch: BR(15, 21) }); adv(sim, 30); console.log("  after 15-21 V", vmaxOf(sim), "plant", sim.buses[B(22)].Vm.toFixed(3)); p = log(sim, p, /trip/);
  sim.apply({ type: "close", branch: BR(18, 21) }); adv(sim, 10); console.log("  after 18-21 V", vmaxOf(sim), "plant", sim.buses[B(22)].Vm.toFixed(3)); p = log(sim, p, /trip|de-energ/);
  // recovery + auto run
  sim.apply({ type: "open", branch: BR(18, 21) }); adv(sim, 20); sim.apply({ type: "open", branch: BR(15, 21) }); adv(sim, 20);
  sim.apply({ type: "avr", bus: B(22), vg: 0.98 }); adv(sim, 10);
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 30);
  const t0 = sim.t; console.log("  hand-over at", fmtClock(t0));
  const r = autoRun(sim, t0);
  console.log(`  auto: won=${sim.stats.won} at ${fmtClock(sim.stats.winAt)}, trips ${sim.stats.trips}, actions ${sim.actions.length}, refusals ${r.refusals.length}`); r.refusals.slice(0, 5).forEach((x) => console.log("    ", x));
});
