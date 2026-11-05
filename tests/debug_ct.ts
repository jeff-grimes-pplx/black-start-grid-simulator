import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const sim = new Simulation(sc);
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === bus - 1 && u.code === code && u.num === num)!.idx;
sim.apply({ type: "start", unit: U(2, "U20", 1) }); sim.apply({ type: "start", unit: U(2, "U20", 2) });
sim.advanceSeconds(1800 + 5);
sim.apply({ type: "start", unit: U(2, "U76", 3) }); sim.apply({ type: "start", unit: U(2, "U76", 4) });
for (let i = 0; i < 400; i++) {
  sim.advance(1);
  if (i % 20 === 0) { const isl = sim.islands[0]; const s = sim.units[U(2, "U20", 1)]; console.log(`${fmtClock(sim.t)} f=${isl.f.toFixed(3)} Pgen=${isl.Pgen.toFixed(3)} Pload=${isl.Pload.toFixed(3)} Pset=${s.Pset.toFixed(4)} Pgov=${s.Pgov.toFixed(4)} crank=${sim.units[U(2, "U76", 3)].crank.toFixed(3)} loss=${(sim as any).lossesByIsland.get(isl.id)}`); }
}
