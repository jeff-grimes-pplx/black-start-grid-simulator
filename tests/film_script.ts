// Rehearses the film arc headlessly: guided plan → operator mistake (energizing extra unloaded 230 kV lines) → collapse →
// recovery → plan continues to full restoration. Prints the timeline so the browser capture can be scripted.
import { readFileSync, writeFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";

const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const BR = (f: number, t: number, c = 1) => sc.branches.findIndex((b) => b.f === f - 1 && b.t === t - 1 && b.circuit === c);
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
const variant = process.argv.find((a) => a.startsWith("--variant="))?.split("=")[1] ?? "B";
const verbose = process.argv.includes("-v");

const plan = buildGuidedPlan(sc);
const sim = new Simulation(sc);
let ptr = 0;
const flush = () => { for (; ptr < sim.log.length; ptr++) { const e = sim.log[ptr]; if (verbose || e.level !== "info") console.log(`    [${fmtClock(e.t)}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`); } };
let vMax = 0, vMaxAt = "";
const tick = (n = 1) => { for (let i = 0; i < n; i++) { sim.advance(1); sim.buses.forEach((b, k) => { if (b.energized && b.Vm > vMax) { vMax = b.Vm; vMaxAt = `${fmtClock(sim.t)} bus ${k + 1}`; } }); } };
const act = (cmd: Parameters<Simulation["apply"]>[0], label: string) => { const r = sim.apply(cmd); console.log(`${fmtClock(sim.t)} ${label} -> ${r.ok ? "ok" : "REFUSED " + r.reason}`); tick(); flush(); };

const runSteps = (from: number, to: number) => {
  for (let n = from; n < to; n++) {
    const step = plan[n];
    if (step.kind === "act") { const r = sim.apply(step.cmd); if (!r.ok) console.log(`  REFUSED #${n} [${fmtClock(sim.t)}] ${step.text}: ${r.reason}`); tick(); }
    else if (step.kind === "wait") tick(Math.round(step.seconds / DT));
    else { let w = 0; while (!step.cond(sim) && w < step.timeout) { tick(); w += DT; } if (w >= step.timeout) console.log(`  TIMEOUT #${n} ${step.text}`); }
    // self-heal like the browser guide: re-apply pickups until the expected feeder count is reached
    if (step.kind === "act" && step.cmd.type === "pickup" && step.expectBlocks) { let guard = 0; while (sim.buses[step.cmd.bus].blocks < step.expectBlocks && sim.buses[step.cmd.bus].energized && guard++ < 6) { tick(Math.round(20 / DT)); sim.apply(step.cmd); tick(); } }
    flush();
  }
};

console.log(`== plan steps 0..25 (through the first pickup at 18 Astor)`);
runSteps(0, 26);
console.log(`state: ${fmtClock(sim.t)} energized ${sim.stats.energizedBuses} served ${sim.stats.servedMW.toFixed(1)} MW; V ${sim.buses.filter((b) => b.energized).map((b) => b.Vm.toFixed(3)).join(" ")}`);
console.log(`== mistake (variant ${variant})`);
const mistakes: Record<string, () => void> = {
  A: () => { act({ type: "close", branch: BR(15, 21) }, "close 15–21"); tick(40); act({ type: "close", branch: BR(18, 21) }, "close 18–21"); tick(40); act({ type: "close", branch: BR(19, 20) }, "close 19–20"); },
  B: () => { act({ type: "avr", bus: 21, vg: 1.05 }, "AVR Aubrey 1.05"); tick(40); act({ type: "close", branch: BR(15, 21) }, "close 15–21"); tick(40); act({ type: "close", branch: BR(18, 21) }, "close 18–21"); },
  C: () => { act({ type: "avr", bus: 21, vg: 1.05 }, "AVR Aubrey 1.05"); },
  D: () => { act({ type: "close", branch: BR(15, 21) }, "close 15–21"); tick(40); act({ type: "close", branch: BR(18, 21) }, "close 18–21"); tick(40); act({ type: "close", branch: BR(19, 20) }, "close 19–20"); tick(40); act({ type: "close", branch: BR(20, 23) }, "close 20–23"); },
};
const vBefore = vMax; vMax = 0;
mistakes[variant]();
for (let i = 0; i < 160 && sim.stats.collapses === 0; i++) tick();
flush();
console.log(`after mistake: ${fmtClock(sim.t)} collapses ${sim.stats.collapses} trips ${sim.stats.trips} energized ${sim.stats.energizedBuses}; vMax ${vMax.toFixed(3)} at ${vMaxAt} (before: ${vBefore.toFixed(3)})`);
console.log(`V now: ${sim.buses.map((b, k) => b.energized ? `${k + 1}:${b.Vm.toFixed(3)}` : "").filter(Boolean).join(" ")}`);
if (sim.stats.collapses > 0 || sim.stats.energizedBuses < 7) {
  console.log(`== recovery`);
  for (const [f, t] of [[15, 21], [18, 21], [19, 20], [20, 23]]) { const k = BR(f, t); if (sim.branches[k].closed && variant !== "C") act({ type: "open", branch: k }, `open ${f}–${t}`); }
  if (variant !== "A" && variant !== "D") act({ type: "avr", bus: 21, vg: 0.98 }, "AVR Aubrey 0.98");
  for (let n = 1; n <= 6; n++) act({ type: "start", unit: U(22, "U50", n) }, `start U50 #${n}`);
  tick(Math.round(620 / DT)); flush();
  console.log(`after restart: ${fmtClock(sim.t)} energized ${sim.stats.energizedBuses} islands ${sim.stats.islands} trips ${sim.stats.trips}; V ${sim.buses.map((b, k) => b.energized ? `${k + 1}:${b.Vm.toFixed(3)}` : "").filter(Boolean).join(" ")}`);
}
console.log(`== plan continues from step 26`);
const tResume = sim.t;
runSteps(26, plan.length);
for (let i = 0; i < Math.round(120 / DT) && !sim.stats.won; i++) tick();
flush();
const s = sim.stats;
console.log(`\nwon ${s.won} at ${s.winAt >= 0 ? fmtClock(s.winAt) : "-"}; served ${s.servedMW.toFixed(1)}/${s.totalMW}, blocks ${s.blocksOn}/${s.blocksTotal}, islands ${s.islands}, trips ${s.trips}, sheds ${s.sheds}, collapses ${s.collapses}, actions ${sim.actions.length}, resumed at ${fmtClock(tResume)}`);
console.log(`violations: ${s.violations.join("; ") || "none"}`);
writeFileSync(new URL(`./film_rehearsal_${variant}.json`, import.meta.url), JSON.stringify({ variant, won: s.won, winAt: s.winAt, actions: sim.actions }, null, 0));
