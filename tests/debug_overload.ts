import { readFileSync } from "node:fs";
import { Simulation, replay, fmtClock, DT } from "../src/engine/sim";
import type { Scenario, Action } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const actions = JSON.parse(readFileSync(new URL("./guided_actions.json", import.meta.url), "utf8")) as Action[];
const B = (id: number) => id - 1;
const BR = (f: number, t: number) => sc.branches.find((b) => b.f === B(f) && b.t === B(t))!.idx;
const sim = replay(sc, actions, { tailSteps: 240 });
const n0 = sim.log.length;
sim.apply({ type: "limit", bus: B(7), mw: 300 }); sim.apply({ type: "limit", bus: B(22), mw: 0 }); sim.apply({ type: "limit", bus: B(23), mw: 0 });
let tripped = false;
for (let i = 0; i < Math.round(1800 / DT); i++) {
  sim.advance(1);
  if (!tripped && sim.branches[BR(7, 8)].tripped) { tripped = true; console.log("tripped at", fmtClock(sim.t)); for (let k = 0; k < 20; k++) { sim.advance(1); const isl = sim.islands.find((x) => x.buses.includes(B(7))); console.log(`  +${((k + 1) * DT).toFixed(2)}s bus7 energized=${sim.buses[B(7)].energized} island=${isl ? `${isl.id} f=${isl.f.toFixed(2)} Pgen=${isl.Pgen.toFixed(1)} Pload=${isl.Pload.toFixed(1)}` : "none"} units=${sim.units.filter((u, g) => sc.units[g].bus === B(7)).map((u) => `${u.status} P${u.P.toFixed(0)} Pset${u.Pset.toFixed(0)} Pgov${u.Pgov.toFixed(0)}`).join(" | ")}`); } break; }
}
for (const e of sim.log.slice(n0)) console.log(`[${fmtClock(e.t)}] ${e.level.toUpperCase()} ${e.text}`);
