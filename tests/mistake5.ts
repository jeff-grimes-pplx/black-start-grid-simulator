// Take-5 mistake lab: plan's opening (AVR 0.98, start U50 #1, #2), hydro on line, then candidate wrong closes.
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const BR = (f: number, t: number, c = 1) => sc.branches.findIndex((b) => b.f === f - 1 && b.t === t - 1 && b.circuit === c);
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
const variants: Record<string, [number, number, number?][]> = {
  "17-22": [[17, 22]], "21-22": [[21, 22]], "21-22,17-22": [[21, 22], [17, 22]], "17-22,21-22": [[17, 22], [21, 22]],
  "21-22,15-21": [[21, 22], [15, 21]], "21-22,15-21x2": [[21, 22], [15, 21], [15, 21, 2]], "21-22,18-21": [[21, 22], [18, 21]],
  "17-22,16-17": [[17, 22], [16, 17]], "21-22,15-21,18-21": [[21, 22], [15, 21], [18, 21]],
};
const nunits = Number(process.argv.find((a) => a.startsWith("--units="))?.split("=")[1] ?? 2);
const vg = Number(process.argv.find((a) => a.startsWith("--vg="))?.split("=")[1] ?? 0.98);
const gapS = Number(process.argv.find((a) => a.startsWith("--gap="))?.split("=")[1] ?? 60);
for (const [name, closes] of Object.entries(variants)) {
  const sim = new Simulation(sc);
  sim.apply({ type: "avr", bus: 21, vg });
  for (let n = 1; n <= nunits; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  while (sim.units[U(22, "U50", 1)].status !== "online") sim.advance(1);
  for (let i = 0; i < Math.round(120 / DT); i++) sim.advance(1); // 2 min on line
  const v0 = sim.buses[21].Vm;
  const trace: string[] = [];
  let tripAt = -1, vPeak = 0, vAtTrip = 0;
  for (const [f, t, c] of closes) {
    const r = sim.apply({ type: "close", branch: BR(f, t, c ?? 1) });
    trace.push(`${fmtClock(sim.t)} close ${f}-${t}${c ? "c" + c : ""} -> ${r.ok ? "ok" : "REFUSED " + r.reason}`);
    for (let i = 0; i < Math.round(gapS / DT); i++) {
      sim.advance(1);
      const v = sim.buses[21].Vm; if (v > vPeak) vPeak = v;
      if (tripAt < 0 && sim.stats.trips > 0) { tripAt = sim.t; vAtTrip = v; }
    }
    trace.push(`   after ${gapS}s: V22 ${sim.buses[21].Vm.toFixed(3)} en ${sim.stats.energizedBuses} trips ${sim.stats.trips} qLimit ${sim.buses[21].qLimit}`);
  }
  const tripEv = sim.log.filter((e) => e.level === "trip").map((e) => `[${fmtClock(e.t)}] ${e.text}`);
  console.log(`== ${name}: V22 before ${v0.toFixed(3)} | peak ${vPeak.toFixed(3)} | trips ${sim.stats.trips}${tripAt >= 0 ? ` at ${fmtClock(tripAt)}` : ""} | en ${sim.stats.energizedBuses}`);
  for (const l of trace) console.log("   " + l);
  for (const e of tripEv.slice(0, 4)) console.log("   " + e.slice(0, 200));
}
