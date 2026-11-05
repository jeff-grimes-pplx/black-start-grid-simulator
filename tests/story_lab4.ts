// Which unit count / setpoint makes the second cranking line (17–22) trip the plant? (film click budget)
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const adv = (sim: Simulation, sec: number) => sim.advance(Math.round(sec / DT));
for (const vg of [1.05, 1.02, 1.0, 0.98]) for (const n of [2, 3, 4]) {
  const sim = new Simulation(sc);
  if (vg !== 1.05) sim.apply({ type: "avr", bus: B(22), vg } as any);
  for (let k = 1; k <= n; k++) sim.apply({ type: "start", unit: U(22, "U50", k) } as any);
  adv(sim, 606);
  const out: string[] = [`vg ${vg} units ${n}: on line ${sim.buses[B(22)].Vm.toFixed(3)}`];
  for (const [f, t] of [[21, 22], [17, 22], [16, 17], [17, 18]]) {
    sim.apply({ type: "close", branch: BR(f, t) } as any);
    let vmax = 0; for (let i = 0; i < 8; i++) { sim.advance(1); vmax = Math.max(vmax, sim.buses[B(22)].Vm); }
    adv(sim, 20);
    out.push(`${f}-${t}: plant ${sim.buses[B(22)].Vm.toFixed(3)} (max ${vmax.toFixed(3)}) trips ${sim.stats.trips}`);
    if (sim.stats.trips) break;
  }
  console.log(out.join(" | "));
}
