// Take-5 mistake lab (b): timed sequences. Opening as take 4 (AVR 0.98 at film 2.8 s, start #1 at 4.2 s, #2 at 5.4 s at 300×),
// then candidate hand closes at film seconds; reports V22 after each close, limits, trips and the log.
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const BR = (f: number, t: number, c = 1) => sc.branches.findIndex((b) => b.f === f - 1 && b.t === t - 1 && b.circuit === c);
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
type Ev = [number, string, number?, number?, number?]; // [film s, kind, a, b, c]
const SPEED = 300, FPS = 60;
// film-second → simulation second (300×, 5 s per frame); the app advances 20 steps per frame
const OPEN: Ev[] = [[2.8, "avr", 0.98], [4.2, "start", 1], [5.4, "start", 2]];
const variants: Record<string, Ev[]> = {
  "A: 17-22@8.5, 16-17@11.0": [[8.5, "close", 17, 22], [11.0, "close", 16, 17]],
  "B: 21-22@8.5, 17-22@11.0": [[8.5, "close", 21, 22], [11.0, "close", 17, 22]],
  "C: 17-22@8.5, 17-18@11.0, 16-17@13.5": [[8.5, "close", 17, 22], [11.0, "close", 17, 18], [13.5, "close", 16, 17]],
  "D: 17-22@8.5, 17-18@11.0": [[8.5, "close", 17, 22], [11.0, "close", 17, 18]],
  "E: 17-22@6.5 (one unit on line)": [[6.5, "close", 17, 22]],
  "F: 17-22@6.5, 16-17@9.0": [[6.5, "close", 17, 22], [9.0, "close", 16, 17]],
  "G: 21-22@6.5 (one unit), 17-22@7.0": [[6.5, "close", 21, 22], [7.0, "close", 17, 22]],
  "H: 17-22@8.5, 17-18@11.0, 21-22@13.5": [[8.5, "close", 17, 22], [11.0, "close", 17, 18], [13.5, "close", 21, 22]],
  "I: 17-22@8.5, 16-17@11.0 (16-17 after 17-18?)": [[8.5, "close", 17, 22], [9.5, "close", 17, 18], [11.0, "close", 16, 17]],
  "J: 21-22@8.5, 17-18? no: 21-22, 16-17 (dead)": [[8.5, "close", 21, 22], [11.0, "close", 16, 17]],
};
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
for (const [name, evs] of Object.entries(variants)) {
  if (only && !name.startsWith(only)) continue;
  const sim = new Simulation(sc);
  const all = [...OPEN, ...evs].sort((a, b) => a[0] - b[0]);
  const endFilm = Math.max(...all.map((e) => e[0])) + 4.0;
  let frame = 0; const lines: string[] = []; let evi = 0; let lastV = -1; let onlineAt: number[] = [];
  const stepsPerFrame = Math.round((SPEED / FPS) / DT);
  let tripEvIdx = -1;
  while (frame / FPS < endFilm) {
    // app order: advance (20 steps) then guide/clicks happen at the frame boundary
    for (let i = 0; i < stepsPerFrame; i++) sim.advance(1);
    const filmS = frame / FPS;
    while (evi < all.length && all[evi][0] <= filmS + 1e-9) {
      const [, kind, a, b] = all[evi]; evi++;
      let r;
      if (kind === "avr") r = sim.apply({ type: "avr", bus: 21, vg: a! });
      else if (kind === "start") r = sim.apply({ type: "start", unit: U(22, "U50", a!) });
      else r = sim.apply({ type: "close", branch: BR(a!, b!) });
      lines.push(`  film ${filmS.toFixed(2)} s sim ${fmtClock(sim.t)}: ${kind} ${a}${b ? "-" + b : ""} -> ${r.ok ? "ok" : "REFUSED " + r.reason} | V22 now ${sim.buses[21].Vm.toFixed(3)} qLimit ${sim.buses[21].qLimit} en ${sim.stats.energizedBuses} trips ${sim.stats.trips}`);
    }
    const v = sim.buses[21].Vm;
    if (Math.abs(v - lastV) > 0.0005) { lines.push(`    f${frame} (${filmS.toFixed(2)} s, sim ${fmtClock(sim.t)}): V22 ${v.toFixed(3)} ${sim.buses[21].energized ? "" : "(de-energized)"} en ${sim.stats.energizedBuses} trips ${sim.stats.trips} islands ${sim.islands.length} U1 ${sim.units[U(22, "U50", 1)].status} U2 ${sim.units[U(22, "U50", 2)].status} Q1 ${sim.units[U(22, "U50", 1)].Q.toFixed(1)} Q2 ${sim.units[U(22, "U50", 2)].Q.toFixed(1)}`); lastV = v; }
    frame++;
  }
  console.log(`== ${name}`);
  for (const l of lines) console.log(l);
  for (const e of sim.log.filter((e) => e.level === "trip" || e.level === "alarm")) console.log(`  LOG [${fmtClock(e.t)}] ${e.level}: ${e.text.slice(0, 230)}`);
}
