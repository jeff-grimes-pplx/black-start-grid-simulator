// Runs the guided plan headlessly against the engine and reports refusals, trips, sheds, limits and the win.
import { readFileSync, writeFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, type PlanStep } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";

const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const verbose = process.argv.includes("-v");
const damaged = process.argv.find((a) => a.startsWith("--damaged="))?.split("=")[1]?.split(",").map(Number) ?? [];
export function runPlan(plan: PlanStep[], opts: { damaged?: number[]; verbose?: boolean } = {}) {
  const sim = new Simulation(sc, { damaged: opts.damaged });
  const refusals: string[] = [];
  let ptr = 0;
  const flush = () => { for (; ptr < sim.log.length; ptr++) { const e = sim.log[ptr]; if (opts.verbose || e.level === "trip" || e.level === "alarm") console.log(`    [${fmtClock(e.t)}] ${e.level.toUpperCase().padEnd(5)} ${e.text}`); } };
  let fMin = 99, fMax = 0, vMin = 9, vMax = 0, worst = 0, vMinAt = "", vMaxAt = "";
  const tick = () => { sim.advance(1); for (const i of sim.islands) { fMin = Math.min(fMin, i.f); fMax = Math.max(fMax, i.f); } sim.buses.forEach((b, i) => { if (!b.energized) return; if (b.Vm < vMin) { vMin = b.Vm; vMinAt = `${fmtClock(sim.t)} bus ${i + 1}`; } if (b.Vm > vMax) { vMax = b.Vm; vMaxAt = `${fmtClock(sim.t)} bus ${i + 1}`; } }); worst = Math.max(worst, sim.stats.worstLoading); };
  for (const [n, step] of plan.entries()) {
    if (step.kind === "act") {
      let r = sim.apply(step.cmd);
      for (const c of step.also ?? []) { if (!r.ok) break; r = sim.apply(c); } // commands of one operation, same physics step
      if (opts.verbose) console.log(`${fmtClock(sim.t)} #${n} ${step.text} -> ${r.ok ? "ok" : "REFUSED " + r.reason}`);
      if (!r.ok) { refusals.push(`#${n} [${fmtClock(sim.t)}] ${step.text} -> ${r.reason}`); console.log(`  REFUSED #${n} [${fmtClock(sim.t)}] ${step.text}: ${r.reason}`); }
      tick();
    } else if (step.kind === "wait") {
      for (let i = 0; i < Math.round(step.seconds / DT); i++) tick();
      if (opts.verbose) console.log(`${fmtClock(sim.t)} #${n} waited ${step.seconds}s`);
    } else {
      let waited = 0;
      while (!step.cond(sim) && waited < step.timeout) { tick(); waited += DT; }
      if (opts.verbose) console.log(`${fmtClock(sim.t)} #${n} until: ${step.text} (${waited}s${waited >= step.timeout ? " TIMEOUT" : ""})`);
      if (waited >= step.timeout) console.log(`  TIMEOUT #${n} [${fmtClock(sim.t)}] ${step.text}`);
    }
    flush();
  }
  // let the win condition hold
  for (let i = 0; i < Math.round(120 / DT) && !sim.stats.won; i++) tick();
  flush();
  return { sim, refusals, fMin, fMax, vMin, vMax, worst, vMinAt, vMaxAt };
}

if (process.argv[1]?.endsWith("run_plan.ts")) {
  const plan = buildGuidedPlan(sc, process.argv.includes("--challenge") ? "challenge" : "guided");
  const t0 = performance.now();
  const r = runPlan(plan, { damaged, verbose });
  const ms = performance.now() - t0;
  const s = r.sim.stats;
  console.log(`\nplan steps ${plan.length}, actions ${r.sim.actions.length}, sim time ${fmtClock(r.sim.t)}, wall ${ms.toFixed(0)} ms`);
  console.log(`won ${s.won} at ${s.winAt >= 0 ? fmtClock(s.winAt) : "-"}; served ${s.servedMW.toFixed(1)}/${s.totalMW} MW, blocks ${s.blocksOn}/${s.blocksTotal}, islands ${s.islands}, energized ${s.energizedBuses}`);
  console.log(`trips ${s.trips}, sheds ${s.sheds}, collapses ${s.collapses}, refusals ${r.refusals.length}`);
  console.log(`f range [${r.fMin.toFixed(3)}, ${r.fMax.toFixed(3)}] Hz, V range [${r.vMin.toFixed(3)} (${r.vMinAt}), ${r.vMax.toFixed(3)} (${r.vMaxAt})] pu, worst loading ${(r.worst * 100).toFixed(0)} %`);
  console.log(`solves ${s.solves}, NR iterations ${s.nrIterations} (avg ${(s.nrIterations / Math.max(1, s.solves)).toFixed(2)}/solve)`);
  console.log(`violations now: ${s.violations.join("; ") || "none"}`);
  console.log(`voltage profile: ${r.sim.buses.map((b, i) => `${i + 1}:${b.Vm.toFixed(3)}`).join(" ")}`);
  console.log(`branch loading >70 %: ${r.sim.branches.map((b, k) => [k, b.loading] as const).filter(([, l]) => l > 0.7).map(([k, l]) => `${sc.branches[k].id} ${(l * 100).toFixed(0)} %`).join(", ") || "none"}`);
  console.log(`units: ${r.sim.units.map((u, g) => `${sc.units[g].code}@${sc.units[g].bus + 1}:${u.status}`).filter((x) => !x.endsWith(":online")).join(", ") || "all online"}`);
  writeFileSync(new URL(process.argv.includes("--challenge") ? "./challenge_actions.json" : "./guided_actions.json", import.meta.url), JSON.stringify(r.sim.actions));
}

if (process.argv.includes("--profile")) {
  // printed by the main block above via r; re-run cheaply here is unnecessary
}
