import { readFileSync } from "node:fs";
import { Simulation, fmtClock } from "../src/engine/sim";
import type { Scenario, Command } from "../src/engine/types";

const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const sim = new Simulation(sc);
const B = (id: number) => id - 1; // bus number -> index
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
let logPtr = 0;
function flush() { for (; logPtr < sim.log.length; logPtr++) { const e = sim.log[logPtr]; console.log(`  [${fmtClock(e.t)}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`); } }
function act(c: Command, label = "") {
  const r = sim.apply(c);
  console.log(`${fmtClock(sim.t)} ACT ${JSON.stringify(c)} ${label} -> ${r.ok ? "ok" : "REFUSED: " + r.reason}`);
  flush();
}
function wait(sec: number) {
  const n = Math.round(sec / 0.25);
  let fmin = 99, fmax = 0, vmin = 9, vmax = 0;
  for (let i = 0; i < n; i++) {
    sim.advance(1);
    for (const isl of sim.islands) { fmin = Math.min(fmin, isl.f); fmax = Math.max(fmax, isl.f); }
    for (const b of sim.buses) if (b.energized) { vmin = Math.min(vmin, b.Vm); vmax = Math.max(vmax, b.Vm); }
  }
  const isl = sim.islands.map((i) => `#${i.id} ${i.f.toFixed(3)} Hz ${i.buses.length} buses gen ${i.Pgen.toFixed(1)} load ${i.Pload.toFixed(1)}`).join(" | ");
  console.log(`${fmtClock(sim.t)} wait ${sec}s  f[${fmin === 99 ? "-" : fmin.toFixed(3)}, ${fmax ? fmax.toFixed(3) : "-"}]  V[${vmin === 9 ? "-" : vmin.toFixed(3)}, ${vmax ? vmax.toFixed(3) : "-"}]  ${isl}  worst ${(sim.stats.worstLoading * 100).toFixed(0)}%  served ${sim.stats.servedMW.toFixed(1)} MW  solves ${sim.stats.solves}`);
  flush();
}
function v(bus: number) { const b = sim.buses[B(bus)]; return `${bus}:${b.energized ? b.Vm.toFixed(3) : "dead"}`; }

// --- Phase 1: hydro black start at 22 Aubrey
for (let n = 1; n <= 6; n++) act({ type: "start", unit: U(22, "U50", n) });
wait(600);
act({ type: "pickup", bus: B(22) }); // no load at 22 -> refused
act({ type: "close", branch: BR(21, 22) });
wait(10);
console.log(v(21), v(22));
act({ type: "close", branch: BR(17, 22) });
wait(10);
act({ type: "close", branch: BR(16, 17) });
wait(10);
act({ type: "close", branch: BR(16, 19) });
wait(10);
act({ type: "close", branch: BR(15, 16) });
wait(10);
console.log([15, 16, 17, 19, 21, 22].map(v).join(" "));
// crank the U155 at 16 and 15 (needs cranking power)
act({ type: "pickup", bus: B(16) });
wait(20);
act({ type: "pickup", bus: B(19) });
wait(20);
act({ type: "pickup", bus: B(15) });
wait(20);
act({ type: "start", unit: U(16, "U155") });
act({ type: "start", unit: U(15, "U155", 6) });
wait(60);
act({ type: "pickup", bus: B(16) });
wait(30);
act({ type: "pickup", bus: B(15) });
wait(30);
act({ type: "pickup", bus: B(19) });
wait(30);
console.log([15, 16, 17, 19, 21, 22].map(v).join(" "));
// big pickup to test the shed
act({ type: "pickup", bus: B(15) }, "(25% block ~79 MW on ~300 MW hydro)");
wait(30);
console.log("units:", sim.units.map((u, g) => `${sc.units[g].code}@${sc.units[g].bus + 1}:${u.status}${u.status === "online" ? ` P${u.P.toFixed(1)} set${u.Pset.toFixed(1)} gov${u.Pgov.toFixed(1)}` : ""}`).filter((s) => !s.includes(":off")).join(" | "));
wait(3 * 3600 - 60);
console.log("units:", sim.units.map((u, g) => `${sc.units[g].code}@${sc.units[g].bus + 1}:${u.status}${u.status === "online" ? ` P${u.P.toFixed(1)} set${u.Pset.toFixed(1)} gov${u.Pgov.toFixed(1)}` : ""}`).filter((s) => !s.includes(":off")).join(" | "));
console.log("stats", JSON.stringify(sim.stats));
