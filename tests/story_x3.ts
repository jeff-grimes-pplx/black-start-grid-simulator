// Story X3 for the 45 s take: 0.98 setpoint, only three of six hydro units started, three lines energized → over-voltage
// collapse; then restart all six and hand over to the guide. Reports every number the film will show.
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, type PlanStep } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const plan = buildGuidedPlan(sc);
const adv = (sim: Simulation, sec: number) => sim.advance(Math.round(sec / DT));
const vmaxOf = (sim: Simulation) => { let m = 0, at = -1; sim.buses.forEach((b, i) => { if (b.energized && b.Vm > m) { m = b.Vm; at = i; } }); return `${m.toFixed(3)} pu at ${at >= 0 ? `${at + 1} ${sc.buses[at].name}` : "—"}`; };
let p = 0; const show = (sim: Simulation) => { for (let i = p; i < sim.log.length; i++) { const e = sim.log[i]; console.log(`    [${fmtClock(e.t)}] ${e.level.padEnd(5)} ${e.text}`); } p = sim.log.length; };
const plant = (sim: Simulation) => { const b = sim.buses[B(22)]; return `${b.Vm.toFixed(3)} pu · ${b.Va.toFixed(1)}° · island ${b.island} · q${b.qLimit}`; };

const sim = new Simulation(sc);
const actions: any[] = []; const act = (c: any) => { const r = sim.apply(c); actions.push({ ...c, t: sim.step, ok: r.ok }); if (!r.ok) console.log("  REFUSED", JSON.stringify(c), r.reason); return r; };
// film-realistic timing: speed 1× for the first clicks (sim advances 1 s per film second)
act({ type: "avr", bus: B(22), vg: 0.98 }); adv(sim, 1.2);
act({ type: "start", unit: U(22, "U50", 1) }); adv(sim, 0.7);
act({ type: "start", unit: U(22, "U50", 2) }); adv(sim, 0.7);
act({ type: "start", unit: U(22, "U50", 3) }); adv(sim, 1.0);
console.log("after starts", fmtClock(sim.t)); show(sim);
// 300× until the units are on line (10 min) then 10×
adv(sim, 606 - sim.t); console.log("plant on line at", fmtClock(sim.t), plant(sim)); show(sim);
adv(sim, 12); // 10× for ~1.2 s film while pointer moves
for (const [f, t] of [[21, 22], [17, 22], [16, 17]]) {
  const r = act({ type: "close", branch: BR(f, t) });
  console.log(`  close ${f}-${t} at ${fmtClock(sim.t)}: ${r.ok ? "ok" : r.reason}`);
  for (let i = 0; i < 12; i++) { sim.advance(1); if (i < 3 || i % 4 === 3) console.log(`     +${((i + 1) * DT).toFixed(2)} s  Vmax ${vmaxOf(sim)}  plant ${plant(sim)}  trips ${sim.stats.trips}  energized ${sim.stats.energizedBuses}`); }
  show(sim);
  adv(sim, 12);
}
console.log("after collapse", fmtClock(sim.t), "energized", sim.stats.energizedBuses, "units", sim.units.slice(U(22, "U50", 1), U(22, "U50", 6) + 1).map((u) => u.status).join(","), "lines closed", [[21, 22], [17, 22], [16, 17]].map(([f, t]) => sim.branches[BR(f, t)].closed).join(","));
// recovery: restart all six (the guide's own steps 2–7) and hand over
adv(sim, 6);
for (let n = 1; n <= 6; n++) act({ type: "start", unit: U(22, "U50", n) });
show(sim);
const handover = sim.t; console.log("hand-over to auto at", fmtClock(handover), "manual actions", actions.length);
// emulate the app's guide in auto mode
let idx = 0, enteredAt = sim.t, guard = 0; const refusals: string[] = [];
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
let autoActs = 0; const firstAuto: string[] = [];
while (idx < plan.length && guard++ < 2e6) {
  const s = plan[idx];
  if (stepDone(s)) { idx++; enteredAt = sim.t; continue; }
  if (s.kind === "act") { let r = sim.apply(s.cmd); autoActs++; if (firstAuto.length < 12) firstAuto.push(`[${fmtClock(sim.t)}] ${s.text}`); for (const c of s.also ?? []) { if (!r.ok) break; r = sim.apply(c); } if (!r.ok) { refusals.push(`[${fmtClock(sim.t)}] #${idx} ${s.text} -> ${r.reason}`); adv(sim, 450); } else sim.advance(1); continue; }
  sim.advance(1);
}
for (let i = 0; i < 480 && !sim.stats.won; i++) sim.advance(1);
console.log("first auto steps:"); firstAuto.forEach((x) => console.log("   " + x));
console.log("refusals", refusals.length); refusals.slice(0, 5).forEach((x) => console.log("   " + x));
const st = sim.stats;
console.log(`won ${st.won} at ${fmtClock(st.winAt)} served ${st.servedMW} / ${st.totalMW} MW trips ${st.trips} sheds ${st.sheds} collapses ${st.collapses} blocks ${st.blocksOn}/${st.blocksTotal} actions ${actions.length + autoActs} sim-s after hand-over ${(st.winAt - handover).toFixed(0)}`);
const win = sim.log.filter((e) => /Restoration complete/.test(e.text)); win.forEach((e) => console.log(`    [${fmtClock(e.t)}] ${e.text}`));
console.log("islands", sim.islands.map((i) => `${i.id}: f ${i.f.toFixed(2)} buses ${i.buses.length}`).join(" | "));
