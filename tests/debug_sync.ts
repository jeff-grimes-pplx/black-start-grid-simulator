import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const plan = buildGuidedPlan(sc);
const sim = new Simulation(sc);
const stopAt = Number(process.argv[2] ?? 95);
for (const [n, step] of plan.entries()) {
  if (n === stopAt) break;
  if (step.kind === "act") { sim.apply(step.cmd); sim.advance(1); }
  else if (step.kind === "wait") sim.advance(Math.round(step.seconds / DT));
  else { let w = 0; while (!step.cond(sim) && w < step.timeout) { sim.advance(1); w += DT; } }
}
console.log(fmtClock(sim.t), "next:", plan[stopAt].kind === "act" ? plan[stopAt].text : plan[stopAt].kind);
for (const isl of sim.islands) {
  console.log(`island ${isl.id} buses ${isl.buses.map((b) => b + 1).join(",")} f=${isl.f.toFixed(3)} Pgen=${isl.Pgen.toFixed(1)} Pload=${isl.Pload.toFixed(1)} H=${isl.Hsum.toFixed(0)} K=${isl.droopK.toFixed(1)}`, sim.headroom(isl.id));
  for (let g = 0; g < sc.units.length; g++) { const u = sc.units[g], s = sim.units[g]; if (s.status !== "off" && sim.buses[u.bus].island === isl.id) console.log(`   ${u.code}#${u.num}@${u.bus + 1} ${s.status} Pset=${s.Pset.toFixed(2)} Pgov=${s.Pgov.toFixed(2)} P=${s.P.toFixed(2)} Q=${s.Q.toFixed(1)} crank=${s.crank.toFixed(2)} cap=${sim.unitCap(g).toFixed(1)}`); }
}
console.log("recent f trace island 2:", sim.islands[1]?.fTrace.slice(-40).map((f) => f.toFixed(2)).join(" "));
