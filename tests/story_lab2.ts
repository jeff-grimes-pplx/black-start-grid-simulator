import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const adv = (sim: Simulation, sec: number) => sim.advance(Math.round(sec / DT));
const vmax = (sim: Simulation) => { let m = 0, at = -1; sim.buses.forEach((b, i) => { if (b.energized && b.Vm > m) { m = b.Vm; at = i; } }); return [m, at] as const; };
function base(vset: number, lines: [number, number][]) {
  const sim = new Simulation(sc);
  if (vset !== 1.05) sim.apply({ type: "avr", bus: B(22), vg: vset });
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  adv(sim, 610);
  for (const [f, t] of lines) { sim.apply({ type: "close", branch: BR(f, t) }); adv(sim, 30); }
  return sim;
}
const energizedBuses = (sim: Simulation) => sim.buses.map((b, i) => b.energized ? i : -1).filter((i) => i >= 0);
const candidates = (sim: Simulation) => { const en = new Set(energizedBuses(sim)); return sc.branches.filter((b) => !sim.branches[b.idx].closed && (en.has(b.f) !== en.has(b.t))); };
for (const vset of [1.05]) {
  for (const pre of [[[21, 22], [17, 22], [16, 17]], [[21, 22], [17, 22]], [[21, 22]]] as [number, number][][]) {
    const s0 = base(vset, pre);
    const [m0, a0] = vmax(s0);
    console.log(`\nvset ${vset}, pre ${pre.map((l) => l.join("-")).join(",")}: Vmax ${m0.toFixed(3)} at ${a0 + 1}, plant ${s0.buses[B(22)].Vm.toFixed(3)}`);
    for (const c of candidates(s0)) {
      const sim = base(vset, pre);
      const r = sim.apply({ type: "close", branch: c.idx });
      if (!r.ok) { console.log(`   ${sc.buses[c.f].id}-${sc.buses[c.t].id}: refused ${r.reason}`); continue; }
      let peak = 0, plantPeak = 0; const trips0 = sim.stats.trips;
      for (let i = 0; i < 40; i++) { sim.advance(1); const [m] = vmax(sim); peak = Math.max(peak, m); plantPeak = Math.max(plantPeak, sim.buses[B(22)].Vm); }
      const tr = sim.log.filter((e) => e.level === "trip").map((e) => e.text.slice(0, 90));
      console.log(`   +${sc.buses[c.f].id}-${sc.buses[c.t].id} (${c.kind}${c.circuits > 1 ? " c" + c.circuit : ""}): Vmax ${peak.toFixed(3)} plant ${plantPeak.toFixed(3)} trips ${sim.stats.trips - trips0} ${tr[0] ?? ""}`);
    }
  }
}
