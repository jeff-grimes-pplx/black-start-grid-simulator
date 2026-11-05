// 2-unit lab at vg 0.98: find ordered close pairs where close A gives a persistent warn (1.05–1.10, no trip) and close B trips.
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
const nunits = Number(process.argv.find((a) => a.startsWith("--units="))?.split("=")[1] ?? 2);
const vg = Number(process.argv.find((a) => a.startsWith("--vg="))?.split("=")[1] ?? 0.98);
function base() {
  const sim = new Simulation(sc);
  sim.apply({ type: "avr", bus: 21, vg } as any);
  for (let n = 1; n <= nunits; n++) sim.apply({ type: "start", unit: U(22, "U50", n) } as any);
  while (sim.units[U(22, "U50", 1)].status !== "online") sim.advance(1);
  for (let i = 0; i < Math.round(120 / DT); i++) sim.advance(1);
  return sim;
}
const name = (i: number) => `${sc.branches[i].f + 1}-${sc.branches[i].t + 1}${sc.branches[i].circuit > 1 ? "c" + sc.branches[i].circuit : ""}`;
function closable(sim: Simulation): number[] {
  const out: number[] = [];
  for (let i = 0; i < sc.branches.length; i++) {
    const b = sc.branches[i]; if (sim.branches[i].closed) continue;
    const en = (k: number) => sim.buses[k].energized;
    if (en(b.f) || en(b.t)) out.push(i);
  }
  return out;
}
function run(sim: Simulation, br: number, secs = 30) {
  const r = sim.apply({ type: "close", branch: br } as any);
  if (!r.ok) return { ok: false, reason: r.reason, v: sim.buses[21].Vm, trips: sim.stats.trips, tripAt: -1 };
  let tripAt = -1, vmax = 0;
  for (let i = 0; i < Math.round(secs / DT); i++) { sim.advance(1); vmax = Math.max(vmax, sim.buses[21].Vm); if (tripAt < 0 && sim.stats.trips > 0) tripAt = (i + 1) * DT; }
  return { ok: true, v: sim.buses[21].Vm, vmax, trips: sim.stats.trips, tripAt };
}
const b0 = base();
for (const a of closable(b0)) {
  const s1 = base(); const ra = run(s1, a);
  if (!ra.ok) { console.log(`${name(a)}: refused ${ra.reason}`); continue; }
  console.log(`${name(a)}: V ${ra.v.toFixed(3)} (max ${ra.vmax!.toFixed(3)}) trips ${ra.trips}${ra.tripAt! >= 0 ? " at +" + ra.tripAt!.toFixed(1) + "s" : ""} en ${s1.stats.energizedBuses}`);
  if (ra.trips > 0) continue;
  for (const b of closable(s1)) {
    const s2 = base(); run(s2, a); const rb = run(s2, b);
    if (!rb.ok) continue;
    const tripTxt = s2.log.filter((e) => e.level === "trip").map((e) => e.text.slice(0, 120))[0] ?? "";
    console.log(`    + ${name(b)}: V ${rb.v.toFixed(3)} (max ${rb.vmax!.toFixed(3)}) trips ${rb.trips}${rb.tripAt! >= 0 ? " at +" + rb.tripAt!.toFixed(1) + "s" : ""} en ${s2.stats.energizedBuses} ${tripTxt}`);
  }
}
