import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const plan = buildGuidedPlan(sc);
const stopIdx = plan.findIndex((p) => p.kind === "act" && p.cmd.type === "reactor");
function runTo(idx: number) {
  const sim = new Simulation(sc);
  for (const [n, step] of plan.entries()) {
    if (n === idx) break;
    if (step.kind === "act") { sim.apply(step.cmd); sim.advance(1); }
    else if (step.kind === "wait") sim.advance(Math.round(step.seconds / DT));
    else { let w = 0; while (!step.cond(sim) && w < step.timeout) { sim.advance(1); w += DT; } }
  }
  return sim;
}
const prof = (sim: Simulation) => sim.buses.map((b, i) => `${i + 1}:${b.Vm.toFixed(3)}`).join(" ");
const BR = (f: number, t: number) => sc.branches.find((b) => b.f === f - 1 && b.t === t - 1)!.idx;
let sim = runTo(stopIdx);
console.log(fmtClock(sim.t), "before:", prof(sim));
sim.apply({ type: "reactor", bus: 5, on: true }); sim.advance(1);
console.log("reactor in, cable open:", prof(sim));
sim.advanceSeconds(10); console.log("  +10 s:", prof(sim), "trips", sim.stats.trips);
sim.apply({ type: "close", branch: BR(6, 10) }); sim.advance(1);
console.log("cable closed:", prof(sim));
sim = runTo(stopIdx);
sim.apply({ type: "close", branch: BR(6, 10) }); sim.advance(1);
console.log("cable closed, no reactor:", prof(sim));
sim.advanceSeconds(10); console.log("  +10 s:", prof(sim), "trips", sim.stats.trips);
sim.apply({ type: "reactor", bus: 5, on: true }); sim.advance(1);
console.log("then reactor in:", prof(sim));
// alternative: lower Abel/Adams setpoints too
sim = runTo(stopIdx);
sim.apply({ type: "avr", bus: 0, vg: 0.98 }); sim.apply({ type: "avr", bus: 1, vg: 0.98 }); sim.advance(1);
sim.apply({ type: "close", branch: BR(6, 10) }); sim.advance(1);
console.log("cable closed, no reactor, Abel/Adams 0.98:", prof(sim));
