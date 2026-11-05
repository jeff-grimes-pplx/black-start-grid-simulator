import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const adv = (sim: Simulation, sec: number) => sim.advance(Math.round(sec / DT));
const vmax = (sim: Simulation) => { let m = 0, at = -1; sim.buses.forEach((b, i) => { if (b.energized && b.Vm > m) { m = b.Vm; at = i; } }); return `${m.toFixed(3)}@${at + 1}`; };
const u = sc.units[U(22, "U50", 1)]; console.log("U50:", JSON.stringify({ pmax: u.pmax, pmin: u.pmin, qmax: u.qmax, qmin: u.qmin, vg: u.vg }));
for (const k of [1, 2, 3, 4, 6]) for (const vset of [0.98, 1.00, 1.05]) {
  const sim = new Simulation(sc);
  if (vset !== 1.05) sim.apply({ type: "avr", bus: B(22), vg: vset });
  for (let n = 1; n <= k; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 610);
  const row: string[] = [];
  for (const [f, t] of [[21, 22], [17, 22], [16, 17], [15, 21], [18, 21]]) {
    const r = sim.apply({ type: "close", branch: BR(f, t) }); if (!r.ok) { row.push(`${f}-${t}: REFUSED ${r.reason!.slice(0, 50)}`); break; }
    const trips0 = sim.stats.trips; let peakPlant = 0;
    for (let i = 0; i < 80; i++) { sim.advance(1); peakPlant = Math.max(peakPlant, sim.buses[B(22)].Vm); }
    const tr = sim.log.filter((e) => e.level === "trip");
    row.push(`${f}-${t}: Vmax ${vmax(sim)} plant ${peakPlant.toFixed(3)} Q ${sim.buses[B(22)].qLimit}` + (sim.stats.trips > trips0 ? ` TRIPS ${sim.stats.trips - trips0} [${tr[tr.length - 1].text.match(/\(([^)]*)\)/)?.[1] ?? tr[tr.length - 1].text.slice(0, 60)}]` : ""));
    if (sim.stats.trips > trips0) break;
  }
  console.log(`\n${k} units, vset ${vset}:`); row.forEach((x) => console.log("   " + x));
}
