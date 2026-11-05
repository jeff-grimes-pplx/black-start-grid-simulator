// Trip delay after each cranking-path close, by setpoint and unit count (looking for a ride-through trip ≥ 0.6 s after the click).
import { readFileSync } from "node:fs";
import { Simulation, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const adv = (sim: Simulation, sec: number) => sim.advance(Math.round(sec / DT));
const seqs: number[][][] = [[[21, 22], [17, 22], [16, 17]], [[17, 22], [21, 22]], [[21, 22], [18, 21]], [[21, 22], [15, 21]]];
for (const vg of [1.05, 1.02, 1.0, 0.98]) for (const n of [1, 2, 3, 4, 5]) for (const seq of seqs) {
  const sim = new Simulation(sc);
  if (vg !== 1.05) sim.apply({ type: "avr", bus: B(22), vg } as any);
  for (let k = 1; k <= n; k++) sim.apply({ type: "start", unit: U(22, "U50", k) } as any);
  adv(sim, 606);
  const out: string[] = [];
  for (const [f, t] of seq) {
    const r = sim.apply({ type: "close", branch: BR(f, t) } as any);
    const v0 = sim.buses[B(22)].Vm; let tripAt = -1, vmax = v0;
    for (let i = 0; i < 40; i++) { sim.advance(1); vmax = Math.max(vmax, sim.buses[B(22)].Vm); if (sim.stats.trips && tripAt < 0) { tripAt = (i + 1) * DT; break; } }
    out.push(`${f}-${t}${r.ok ? "" : "(refused)"}: V ${v0.toFixed(3)}${tripAt >= 0 ? ` TRIP after ${tripAt.toFixed(2)} s` : ` ok`}`);
    if (sim.stats.trips) break;
  }
  if (out.some((s) => /TRIP after (0\.[5-9]|1\.)/.test(s))) console.log(`vg ${vg} n ${n}: ${out.join(" | ")}  <== delayed`);
  else console.log(`vg ${vg} n ${n}: ${out.join(" | ")}`);
}
