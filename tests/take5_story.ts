// Take-5 story lab: frame-faithful emulation of the app loop (300×, 20 physics steps per film frame, guide ticked after
// the advance, one auto action per frame, 1.5 s wall retry after a refusal) with the hand actions at film seconds.
//   npx tsx tests/take5_story.ts [--vg=1.00] [--l1=17-22] [--l2=16-17] [--t1=10.6] [--t2=18.0] [--tset=7.6] [--tstart=23.1] [--tauto=24.2] [--cut=29.0] [-v]
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, type PlanStep } from "../src/engine/plan";
import type { Command, Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const verbose = process.argv.includes("-v");
const BR = (s: string) => { const [f, t] = s.split("-").map(Number); return sc.branches.findIndex((b) => b.f === f - 1 && b.t === t - 1 && b.circuit === 1); };
const U = (bus: number, code: string, n: number) => sc.units.findIndex((u) => u.bus === bus - 1 && u.code === code && u.num === n);
const FPS = 60, SPF = Math.round(300 / FPS / DT); // steps per frame at 300×
const vg = Number(arg("vg", "1.00")), tset = Number(arg("tset", "7.6")), t1 = Number(arg("t1", "10.6")), t2 = Number(arg("t2", "18.0"));
const tstart = Number(arg("tstart", "23.1")), tauto = Number(arg("tauto", "24.2")), cut = Number(arg("cut", "29.0"));
const l1 = arg("l1", "17-22"), l2 = arg("l2", "16-17"), l3 = arg("l3", ""), t3 = Number(arg("t3", "0")), units = Number(arg("units", "2")), tu3 = Number(arg("tu3", "6.6"));
type Hand = [number, string, () => any];
const sim = new Simulation(sc);
const plan = buildGuidedPlan(sc);
const hands: Hand[] = [
  [2.8, "Do this step: AVR 0.98", () => applyStep(plan[0] as any)],
  [4.2, "Do this step: start U50 #1", () => applyStep(plan[1] as any)],
  [5.4, "Do this step: start U50 #2", () => applyStep(plan[2] as any)],
];
if (units >= 3) hands.push([tu3, "Do this step: start U50 #3", () => applyStep(plan[3] as any)]);
if (tset > 0) hands.push([tset, `setpoint ${vg.toFixed(2)} (preset)`, () => sim.apply({ type: "avr", bus: 21, vg })]);
hands.push([t1, `close ${l1} (hand)`, () => sim.apply({ type: "close", branch: BR(l1) })]);
if (t2 > 0) hands.push([t2, `close ${l2} (hand)`, () => sim.apply({ type: "close", branch: BR(l2) })]);
if (t3 > 0 && l3) hands.push([t3, `close ${l3} (hand)`, () => sim.apply({ type: "close", branch: BR(l3) })]);
hands.push([tstart, "Start all", () => { const startable = sc.units.filter((u) => u.bus === 21 && (sim.units[u.idx].status === "off" || sim.units[u.idx].status === "tripped")); const rs = startable.map((u) => sim.apply({ type: "start", unit: u.idx })); return { ok: rs.every((r) => r.ok), reason: `${rs.length} starts` }; }]);
let guideAuto = false; hands.push([tauto, "Run automatically", () => { guideAuto = true; return { ok: true }; }]);
hands.sort((a, b) => a[0] - b[0]);

let guideIndex = 0, guideEnteredAt = 0, guideRefusal: string | null = null, guideRetryAt = 0;
function cmdDone(c: Command, expectBlocks?: number): boolean {
  switch (c.type) {
    case "start": return sim.units[c.unit].status === "starting" || sim.units[c.unit].status === "online";
    case "stop": return sim.units[c.unit].status === "off";
    case "close": return sim.branches[c.branch].closed;
    case "open": return !sim.branches[c.branch].closed;
    case "pickup": return sim.buses[c.bus].blocks >= (expectBlocks ?? 1);
    case "drop": return true;
    case "reactor": return sim.buses[c.bus].reactorOn === c.on;
    case "avr": return Math.abs(sim.buses[c.bus].vset - c.vg) < 1e-6;
    case "limit": return Math.round(sim.buses[c.bus].plimit) === Math.round(c.mw);
  }
}
function stepDone(step: PlanStep): boolean {
  if (step.kind === "wait") return sim.t - guideEnteredAt >= step.seconds - 1e-9;
  if (step.kind === "until") return step.cond(sim);
  return cmdDone(step.cmd, step.expectBlocks) && (step.also ?? []).every((c) => cmdDone(c));
}
function applyStep(step: Extract<PlanStep, { kind: "act" }>) {
  const r = sim.apply(step.cmd); if (!r.ok) return r;
  for (const c of step.also ?? []) { if (!cmdDone(c)) { const r2 = sim.apply(c); if (!r2.ok) return r2; } }
  return r;
}
function tickGuide(nowMs: number) {
  for (let guard = 0; guard < 50; guard++) {
    const step = plan[guideIndex]; if (!step) return;
    if (stepDone(step)) { guideIndex++; guideEnteredAt = sim.t; guideRefusal = null; continue; }
    if (guideAuto && step.kind === "act" && nowMs >= guideRetryAt) { const r = applyStep(step); guideRefusal = r.ok ? null : r.reason ?? null; guideRetryAt = nowMs + (r.ok ? 0 : 1500); if (!r.ok && verbose) console.log(`    refusal at ${fmtClock(sim.t)}: ${step.text} -> ${r.reason}`); }
    return;
  }
}
let frame = 0, hi = 0, lastEn = -1, lastIsl = -1, lastTrips = 0, lastLog = 0;
const marks: string[] = [];
const note = (s: string) => { marks.push(s); if (verbose) console.log(s); };
let cutSimT = -1, winFrame = -1;
while (true) {
  for (let i = 0; i < SPF; i++) sim.advance(1);
  const filmS = frame / FPS, nowMs = frame * 1000 / FPS;
  while (hi < hands.length && hands[hi][0] <= filmS + 1e-9) { const [, label, fn] = hands[hi]; hi++; const r = fn(); note(`  f${frame} ${filmS.toFixed(2)} s sim ${fmtClock(sim.t)} HAND ${label} -> ${r.ok ? "ok" : "REFUSED " + r.reason} | V22 ${sim.buses[21].Vm.toFixed(3)} en ${sim.stats.energizedBuses} trips ${sim.stats.trips} gi ${guideIndex}`); }
  tickGuide(nowMs);
  if (sim.stats.energizedBuses !== lastEn || sim.islands.length !== lastIsl || sim.stats.trips !== lastTrips) {
    note(`  f${frame} ${filmS.toFixed(2)} s sim ${fmtClock(sim.t)}: en ${sim.stats.energizedBuses} islands ${sim.islands.length} trips ${sim.stats.trips} served ${sim.stats.servedMW.toFixed(0)} V22 ${sim.buses[21].Vm.toFixed(3)} gi ${guideIndex} actions ${sim.actions.length}`);
    lastEn = sim.stats.energizedBuses; lastIsl = sim.islands.length; lastTrips = sim.stats.trips;
  }
  for (; lastLog < sim.log.length; lastLog++) { const e = sim.log[lastLog]; if (e.level === "trip" || e.level === "alarm") note(`    LOG f${frame} [${fmtClock(e.t)}] ${e.level}: ${e.text.slice(0, 200)}`); }
  if (frame === Math.round(cut * FPS)) { cutSimT = sim.t; note(`  CUT at f${frame}: sim ${fmtClock(sim.t)} en ${sim.stats.energizedBuses} served ${sim.stats.servedMW.toFixed(0)} actions ${sim.actions.length}`); }
  if (sim.stats.won) { winFrame = frame; break; }
  frame++;
  if (frame > 60 * 60 * 20) { console.log("no win within 20 min of film frames"); break; }
}
console.log(`\nwon ${sim.stats.won} at sim ${fmtClock(sim.stats.winAt)} (t=${sim.stats.winAt}); film frames to win (uncut) ${winFrame}; actions ${sim.actions.length}; trips ${sim.stats.trips}; collapses ${sim.stats.collapses}; sheds ${sim.stats.sheds}; served ${sim.stats.servedMW.toFixed(1)}/${sim.stats.totalMW}`);
console.log(`cut sim ${cutSimT >= 0 ? fmtClock(cutSimT) : "-"}; refusals in log: ${sim.log.filter((e) => /refus/i.test(e.text)).length}`);
if (!verbose) for (const m of marks.slice(0, 60)) console.log(m);
const ovTrips = sim.log.filter((e) => e.level === "trip");
console.log(`trip events: ${ovTrips.length}`); for (const e of ovTrips) console.log(`  [${fmtClock(e.t)}] ${e.text.slice(0, 220)}`);
const vmax = Math.max(...sim.buses.map((b) => b.Vm));
console.log(`final Vmax ${vmax.toFixed(3)}; violations: ${sim.stats.violations.join("; ") || "none"}`);
