import { readFileSync } from "node:fs";
import { Simulation, fmtClock } from "../src/engine/sim";
import type { Scenario, Command } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
function run(title: string, fn: (sim: Simulation, act: (c: Command) => void, wait: (s: number) => void) => void) {
  console.log("=== " + title);
  const sim = new Simulation(sc); let ptr = 0;
  const flush = () => { for (; ptr < sim.log.length; ptr++) { const e = sim.log[ptr]; console.log(`    [${fmtClock(e.t)}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`); } };
  const act = (c: Command) => { const r = sim.apply(c); console.log(`  ${fmtClock(sim.t)} ${JSON.stringify(c)} -> ${r.ok ? "ok" : "REFUSED: " + r.reason}`); flush(); };
  const wait = (sec: number) => {
    let fmin = 99, fmax = 0, vmin = 9, vmax = 0;
    for (let i = 0; i < Math.round(sec / 0.25); i++) { sim.advance(1); for (const isl of sim.islands) { fmin = Math.min(fmin, isl.f); fmax = Math.max(fmax, isl.f); } for (const b of sim.buses) if (b.energized) { vmin = Math.min(vmin, b.Vm); vmax = Math.max(vmax, b.Vm); } }
    const V = sim.buses.map((b, i) => b.energized ? `${i + 1}:${b.Vm.toFixed(3)}${b.qLimit ? (b.qLimit < 0 ? "↓" : "↑") : ""}` : "").filter(Boolean).join(" ");
    console.log(`  ${fmtClock(sim.t)} +${sec}s f[${fmin === 99 ? "-" : fmin.toFixed(3)},${fmax ? fmax.toFixed(3) : "-"}] V[${vmin === 9 ? "-" : vmin.toFixed(3)},${vmax ? vmax.toFixed(3) : "-"}] ${V}`);
    flush();
  };
  fn(sim, act, wait);
}
run("CT island at 1 Abel then energize the 1-2 cable (46 Mvar) with CTs that cannot absorb", (sim, act, wait) => {
  act({ type: "start", unit: U(1, "U20", 1) }); act({ type: "start", unit: U(1, "U20", 2) });
  wait(1800); act({ type: "pickup", bus: B(1) }); wait(30);
  act({ type: "close", branch: BR(1, 2) }); wait(5); wait(5); wait(10);
  console.log("  units", sim.units.filter((u) => u.status !== "off").map((u, i) => `${u.status} P${u.P.toFixed(1)} Q${u.Q.toFixed(1)}`).join(" | "));
});
run("Hydro island at 1.00 pu energizing the whole north ring", (sim, act, wait) => {
  act({ type: "avr", bus: B(22), vg: 1.0 });
  for (let n = 1; n <= 6; n++) act({ type: "start", unit: U(22, "U50", n) });
  wait(600);
  for (const [f, t] of [[21, 22], [17, 22], [16, 17], [16, 19], [15, 16], [17, 18], [15, 21], [18, 21], [19, 20], [20, 23], [15, 24], [13, 23], [12, 23], [12, 13], [11, 13], [11, 14], [14, 16]]) { act({ type: "close", branch: BR(f, t) }); wait(5); }
  console.log("  units", sim.units.filter((u) => u.status === "online").map((u) => `P${u.P.toFixed(1)} Q${u.Q.toFixed(1)}`).join(" | "));
  wait(10);
});
