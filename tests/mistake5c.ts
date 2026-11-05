import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const BR = (f: number, t: number, c = 1) => sc.branches.findIndex((b) => b.f === f - 1 && b.t === t - 1 && b.circuit === c);
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
for (const vg of [0.98, 1.00]) for (const seq of [[[17, 22]], [[17, 22], [17, 18]], [[17, 22], [16, 17]], [[21, 22]], [[21, 22], [17, 22]]]) {
  const sim = new Simulation(sc);
  sim.apply({ type: "avr", bus: 21, vg });
  sim.apply({ type: "start", unit: U(22, "U50", 1) }); sim.apply({ type: "start", unit: U(22, "U50", 2) });
  while (sim.units[U(22, "U50", 2)].status !== "online") sim.advance(1);
  for (let i = 0; i < 480; i++) sim.advance(1);
  const out: string[] = [];
  for (const [f, t] of seq) {
    sim.apply({ type: "close", branch: BR(f, t) });
    for (let i = 0; i < 20; i++) sim.advance(1);
    out.push(`close ${f}-${t}: V22 ${sim.buses[21].Vm.toFixed(3)} V17 ${sim.buses[16].Vm.toFixed(3)} V21 ${sim.buses[20].Vm.toFixed(3)} V16 ${sim.buses[15].Vm.toFixed(3)} V18 ${sim.buses[17].Vm.toFixed(3)} Q ${sim.units[U(22,"U50",1)].Q.toFixed(1)}/${sim.units[U(22,"U50",2)].Q.toFixed(1)} trips ${sim.stats.trips} en ${sim.stats.energizedBuses}`);
  }
  console.log(`vg ${vg}: ` + out.join(" | "));
  const tr = sim.log.filter((e) => e.level === "trip"); if (tr.length) console.log("   " + tr[0].text.slice(0, 200));
}
