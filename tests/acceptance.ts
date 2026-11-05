// Headless acceptance tests for the Black Start engine. Run: npx tsx tests/acceptance.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Simulation, replay, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, challengeDamagedBranch } from "../src/engine/plan";
import { runPlan } from "./run_plan";
import type { Scenario, Action } from "../src/engine/types";

const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const results: { test: string; pass: boolean; detail: string }[] = [];
function check(test: string, pass: boolean, detail: string) { results.push({ test, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${test} — ${detail}`); }
/** Stats with every float rounded (1e-6), so the hash is identical across JavaScript engines whose summation order differs in the last bit. */
function roundStats(st: Simulation["stats"]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(st)) out[k] = k === "lastSolveMs" ? 0 : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;
  return out;
}
function stateHash(sim: Simulation) {
  const h = createHash("sha256");
  h.update(JSON.stringify({ t: sim.t, V: sim.buses.map((b) => [b.energized, Math.round(b.Vm * 1e6), Math.round(b.Va * 1e6), b.blocks]), br: sim.branches.map((b) => [b.closed, b.tripped, Math.round(b.loading * 1e6)]), u: sim.units.map((u) => [u.status, Math.round(u.P * 1e4), Math.round(u.Q * 1e4)]), f: sim.islands.map((i) => [i.id, Math.round(i.f * 1e6)]), log: sim.log.length, stats: roundStats(sim.stats) }));
  return h.digest("hex");
}

// 1. Guided plan: complete restoration from a cold start
const guided = buildGuidedPlan(sc);
const g = runPlan(guided);
const gs = g.sim.stats;
check("guided plan restores all load", gs.won && gs.blocksOn === gs.blocksTotal && gs.islands === 1 && gs.energizedBuses === 24,
  `won=${gs.won} at ${fmtClock(gs.winAt)}, ${gs.servedMW.toFixed(1)}/${gs.totalMW} MW, ${gs.blocksOn}/${gs.blocksTotal} feeders, ${g.sim.actions.length} actions, ${guided.length} plan steps`);
check("guided plan is clean", gs.trips === 0 && gs.sheds === 0 && gs.collapses === 0 && g.refusals.length === 0,
  `trips ${gs.trips}, sheds ${gs.sheds}, collapses ${gs.collapses}, refusals ${g.refusals.length}; f ∈ [${g.fMin.toFixed(3)}, ${g.fMax.toFixed(3)}] Hz, worst loading ${(g.worst * 100).toFixed(0)} %`);
check("solver effort in the guided run", gs.solves > 0, `${gs.solves} power-flow solves, ${gs.nrIterations} Newton iterations (${(gs.nrIterations / gs.solves).toFixed(2)} per solve, warm-started), max ${g.sim.stats.lastIterations} on the last solve`);
writeFileSync(new URL("./guided_actions.json", import.meta.url), JSON.stringify(g.sim.actions));
const guidedHash = stateHash(g.sim);

// 2. Replay determinism: the action log alone reproduces the final state
const rp = replay(sc, g.sim.actions, { tailSteps: g.sim.step - g.sim.actions[g.sim.actions.length - 1].t });
check("replay reproduces the guided run exactly", stateHash(rp) === guidedHash && rp.stats.won && rp.stats.winAt === gs.winAt,
  `state hash ${guidedHash.slice(0, 16)}… matches; replay won at ${fmtClock(rp.stats.winAt)}; ${rp.log.length} log entries both ways`);
const rp2 = replay(sc, JSON.parse(readFileSync(new URL("./guided_actions.json", import.meta.url), "utf8")) as Action[], { tailSteps: g.sim.step - g.sim.actions[g.sim.actions.length - 1].t });
check("replay from the saved JSON log matches too", stateHash(rp2) === guidedHash, `hash ${stateHash(rp2).slice(0, 16)}…`);

// 3. Challenge: the 17–22 line is damaged; the guided opening fails honestly, the challenge plan still wins
const dmg = challengeDamagedBranch(sc);
{
  const sim = new Simulation(sc, { damaged: [dmg] });
  const r = sim.apply({ type: "close", branch: dmg });
  check("damaged line cannot be closed", !r.ok && /damag/i.test(r.reason ?? ""), r.reason ?? "");
}
const c = runPlan(buildGuidedPlan(sc, "challenge"), { damaged: [dmg] });
check("challenge plan restores all load with 17–22 out", c.sim.stats.won && c.refusals.length === 0 && c.sim.stats.trips === 0 && c.sim.stats.sheds === 0,
  `won=${c.sim.stats.won} at ${fmtClock(c.sim.stats.winAt)}, ${c.sim.actions.length} actions, trips ${c.sim.stats.trips}, sheds ${c.sim.stats.sheds}, refusals ${c.refusals.length}`);
writeFileSync(new URL("./challenge_actions.json", import.meta.url), JSON.stringify(c.sim.actions));

// 4. Negative: excessive pickup on a small island triggers under-frequency load shedding
{
  const sim = new Simulation(sc);
  sim.apply({ type: "start", unit: U(1, "U20", 1) }); sim.apply({ type: "start", unit: U(1, "U20", 2) });
  sim.advanceSeconds(1801);
  sim.apply({ type: "pickup", bus: B(1) }); sim.apply({ type: "pickup", bus: B(1) }); // 3.2 + 6.4 MW on a 40 MW island
  let fmin = 99; for (let i = 0; i < 120; i++) { sim.advance(1); fmin = Math.min(fmin, sim.islands[0]?.f ?? 99); }
  const shed = sim.log.find((e) => /Under-frequency load shedding/.test(e.text));
  check("oversized pickup → UFLS", !!shed && sim.stats.sheds >= 1 && fmin < 59.3, `nadir ${fmin.toFixed(2)} Hz; ${shed?.text ?? "no shed event"}`);
}

// 5. Negative: energizing the Abel–Adams cable from combustion turbines that cannot absorb reactive power
{
  const sim = new Simulation(sc);
  sim.apply({ type: "start", unit: U(1, "U20", 1) }); sim.apply({ type: "start", unit: U(1, "U20", 2) });
  sim.advanceSeconds(1801);
  const r = sim.apply({ type: "close", branch: BR(1, 2) });
  sim.advanceSeconds(5);
  const ev = sim.log.find((e) => /Reactive surplus/.test(e.text));
  check("cable on a CT island → reactive-surplus collapse", r.ok && !!ev && sim.stats.collapses === 1 && !sim.buses[0].energized, ev?.text ?? "no collapse event");
}

// 6. Negative: too much unloaded line on the hydro island at a high setpoint → over-voltage trips
{
  const sim = new Simulation(sc);
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  sim.advanceSeconds(601);
  let vmax = 0;
  const sample = () => { for (const b of sim.buses) if (b.energized) vmax = Math.max(vmax, b.Vm); };
  for (const [f, t] of [[21, 22], [17, 22], [16, 17], [16, 19], [15, 16], [17, 18], [15, 21], [18, 21], [19, 20], [20, 23]]) { sim.apply({ type: "close", branch: BR(f, t) }); for (let i = 0; i < 12; i++) { sim.advance(1); sample(); } }
  for (let i = 0; i < 40; i++) { sim.advance(1); sample(); }
  const ov = sim.log.find((e) => /over-voltage/.test(e.text) && e.level === "trip");
  check("unloaded lines at 1.05 pu setpoint → voltage rise and over-voltage trip", vmax > 1.1 && !!ov, `Vmax ${vmax.toFixed(3)} pu; ${ov?.text ?? "no over-voltage trip"}`);
}

// 7. Negative: thermal overload. From the restored system, de-rate Aubrey and Austen to zero; secondary control pushes
//    Alder's three units above what the single 7–8 line can carry.
{
  const sim = replay(sc, g.sim.actions, { tailSteps: 240 });
  sim.apply({ type: "limit", bus: B(7), mw: 300 });
  sim.apply({ type: "limit", bus: B(22), mw: 0 });
  sim.apply({ type: "limit", bus: B(23), mw: 0 });
  let peak = 0, over = "";
  for (let i = 0; i < Math.round(1800 / DT); i++) { sim.advance(1); const l = sim.branches[BR(7, 8)].loading; if (l > peak) { peak = l; over = fmtClock(sim.t); } if (sim.branches[BR(7, 8)].tripped) { sim.advanceSeconds(10); break; } }
  const trip = sim.log.find((e) => /Line 7–8 tripped on overload/.test(e.text));
  const island = sim.log.find((e) => /Alder tripped on over-frequency/.test(e.text));
  check("line overload → thermal trip with ratings in the message", !!trip && peak > 1.0, `peak loading ${(peak * 100).toFixed(0)} % at ${over}; ${trip?.text ?? "no trip"}`);
  check("overload trip islands Alder and its units trip on over-frequency", !!island, island?.text ?? "no over-frequency trip");
}

// 8. Negative: sync check and dead-bus refusals explain themselves
{
  const sim = new Simulation(sc);
  const r1 = sim.apply({ type: "pickup", bus: B(15) });
  for (let n = 1; n <= 6; n++) sim.apply({ type: "start", unit: U(22, "U50", n) });
  sim.apply({ type: "start", unit: U(1, "U20", 1) }); sim.apply({ type: "start", unit: U(1, "U20", 2) });
  sim.advanceSeconds(1801);
  for (const [f, t] of [[21, 22], [17, 22], [16, 17], [15, 16], [15, 24], [3, 24]]) sim.apply({ type: "close", branch: BR(f, t) });
  sim.advanceSeconds(2);
  sim.apply({ type: "pickup", bus: B(15) }); sim.apply({ type: "pickup", bus: B(15) }); // disturb the hydro island
  sim.advanceSeconds(1.5);
  const r2 = sim.apply({ type: "close", branch: BR(1, 3) });
  check("dead-bus pickup is refused with a reason", !r1.ok && /dead/.test(r1.reason ?? ""), r1.reason ?? "");
  check("sync check blocks a tie between islands that are apart", !r2.ok && /Sync check/.test(r2.reason ?? ""), r2.reason ?? "");
}

// 9. Random dispatch states keep solving (solver robustness under the engine's warm start)
{
  let bad = 0, n = 0;
  for (const cut of [40, 80, 120, 150]) {
    const sim = replay(sc, g.sim.actions.slice(0, cut), { tailSteps: 400 });
    n++; if (sim.islands.some((i) => !i.converged)) bad++;
  }
  check("engine states along the guided run all converge", bad === 0, `${n} intermediate states checked`);
}

// 10. Reactive-limit consistency along the guided run (the game's limit-release mode, see validation/VALIDATION.md):
//     a regulating plant sits at its setpoint inside its Q range; a plant held at Qmax has V ≤ Vset; one held at Qmin
//     (fixed Q or fixed EMF) has V ≥ Vset. Checked on every energized plant bus at twelve points of the restoration.
{
  const QLIM_V_TOL = 1e-4, viol: string[] = []; let checked = 0;
  for (const cut of [10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 9999]) {
    const sim = replay(sc, g.sim.actions.slice(0, cut), { tailSteps: 200 });
    sim.buses.forEach((b, i) => {
      if (!b.energized) return;
      const units = sc.units.map((u, gi) => ({ u, gi })).filter(({ u, gi }) => u.bus === i && sim.units[gi].status === "online");
      if (!units.length) return;
      checked++;
      const Q = units.reduce((s, { gi }) => s + sim.units[gi].Q, 0), qmin = units.reduce((s, { u }) => s + u.qmin, 0), qmax = units.reduce((s, { u }) => s + u.qmax, 0);
      const tag = `${fmtClock(sim.t)} ${sc.buses[i].name}: V ${b.Vm.toFixed(4)} Vset ${b.vset.toFixed(4)} Q ${Q.toFixed(1)} [${qmin}, ${qmax}] lim ${b.qLimit}`;
      if (b.qLimit === 0) { if (Math.abs(b.Vm - b.vset) > 1e-6 || Q < qmin - 1e-3 || Q > qmax + 1e-3) viol.push("regulating: " + tag); }
      else if (b.qLimit > 0) { if (b.Vm > b.vset + QLIM_V_TOL || Math.abs(Q - qmax) > 1e-3) viol.push("at Qmax: " + tag); }
      else if (b.Vm < b.vset - QLIM_V_TOL || Q > qmin + 1e-3) viol.push("at Qmin: " + tag);
    });
  }
  check("reactive limits are consistent along the guided run", viol.length === 0, viol.length ? viol.slice(0, 4).join(" | ") : `${checked} energized plant-bus states checked, none pinned at a limit it does not touch`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
writeFileSync(new URL("./acceptance_results.json", import.meta.url), JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, guided_state_hash: guidedHash, guided_actions: g.sim.actions.length, guided_win_at: fmtClock(g.sim.stats.winAt), results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
