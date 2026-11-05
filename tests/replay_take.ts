// Replays the exact action log of a filmed take (film/master/take.json → actions) through the engine
// and prints the outcome plus a state hash, so the handoff can show that the replay reproduces the filmed run.
// usage: npx tsx tests/replay_take.ts ../film/master/take.json [--md out.md]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { replay, fmtClock, DT, Simulation } from "../src/engine/sim";
import type { Scenario, Action } from "../src/engine/types";

const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const takePath = process.argv[2];
const take = JSON.parse(readFileSync(takePath, "utf8"));
const actions = take.actions as Action[];
const mdOut = process.argv.includes("--md") ? process.argv[process.argv.indexOf("--md") + 1] : null;
const argAfter = (flag: string, dflt: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : dflt);
const srcLabel = argAfter("--src", "film/take.json"); // how the take file is named in the handoff
const handNote = argAfter("--note", ""); // optional parenthetical after "applied by hand in the film"

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

// replay twice (fresh simulations) — the hash must be identical
const tail = 60 * 4; // one more sim minute after the last action, like the game does before declaring the win
const a = replay(sc, actions, { tailSteps: tail });
const b = replay(sc, actions, { tailSteps: tail });
const ha = stateHash(a), hb = stateHash(b);
const s = a.stats;
const actionsHash = createHash("sha256").update(JSON.stringify(actions)).digest("hex");
console.log(`actions: ${actions.length} (sha256 ${actionsHash})`);
console.log(`replayed: won=${s.won} at ${s.won ? fmtClock(s.winAt) : "—"}, served ${s.servedMW.toFixed(1)}/${s.totalMW} MW, feeders ${s.blocksOn}/${s.blocksTotal}, trips ${s.trips}, sheds ${s.sheds}, collapses ${s.collapses}, solves ${s.solves}`);
console.log(`state hash (replay 1): ${ha}`);
console.log(`state hash (replay 2): ${hb}  ${ha === hb ? "identical" : "DIFFERENT"}`);
console.log(`filmed take final: ${JSON.stringify({ t: take.final.t, won: take.final.won, served: take.final.served, blocks: take.final.blocks, trips: take.final.trips, sheds: take.final.sheds, collapses: take.final.collapses })}`);

if (mdOut) {
  const unitName = (g: number) => { const u = sc.units[g]; return `${u.code} #${u.num} at ${sc.buses[u.bus].id} ${sc.buses[u.bus].name}`; };
  const busName = (i: number) => `${sc.buses[i].id} ${sc.buses[i].name}`;
  const brName = (k: number) => { const br = sc.branches[k]; return `${sc.buses[br.f].id}–${sc.buses[br.t].id}${br.circuits > 1 ? ` circuit ${br.circuit}` : ""}`; };
  const describe = (x: Action): string => {
    switch (x.type) {
      case "start": return `start ${unitName(x.unit)}`;
      case "stop": return `stop ${unitName((x as any).unit)}`;
      case "close": return `close breaker, line ${brName(x.branch)}`;
      case "open": return `open breaker, line ${brName(x.branch)}`;
      case "pickup": return `pick up next feeder at ${busName(x.bus)}`;
      case "drop": return `drop last feeder at ${busName(x.bus)}`;
      case "avr": return `voltage setpoint ${x.vg.toFixed(3)} pu at ${busName(x.bus)}`;
      case "limit": return `dispatch limit ${(x as any).mw} MW at ${busName(x.bus)}`;
      case "reactor": return `${(x as any).on ? "switch in" : "switch out"} shunt reactor at ${busName(x.bus)}`;
      default: return JSON.stringify(x);
    }
  };
  const rows = actions.map((x, i) => `| ${i + 1} | ${fmtClock(x.t * DT)} | ${describe(x)} |`);
  const autoMark = (take.marks as { f: number; label: string }[] | undefined)?.find((m) => m.label === "Run automatically");
  const autoSimT = autoMark ? (take.frames as { f: number; simT: number }[]).find((fr) => fr.f === autoMark.f)?.simT ?? 0 : 0;
  const handCount = autoMark ? actions.filter((a) => a.t * DT < autoSimT).length : 0;
  const md = `# Exact action log of the filmed run\n\nSource: \`${srcLabel}\` → \`actions\` (${actions.length} operator actions, sha256 \`${actionsHash}\`). Times are simulation clock (T+hh:mm:ss, 0.25 s physics steps). Actions 1–${handCount} were applied by hand in the film${handNote ? ` (${handNote})` : ""}; from the "Run automatically" click at film frame ${autoMark ? autoMark.f : "?"} (T+${autoMark ? fmtClock(autoSimT) : "?"}) the guided sequence applied the remaining ${actions.length - handCount} at the UI's 300×.\n\nReplay of this log through the engine: won=${s.won} at ${s.won ? fmtClock(s.winAt) : "—"}, ${s.servedMW.toFixed(1)}/${s.totalMW} MW, ${s.blocksOn}/${s.blocksTotal} feeders, trips ${s.trips}, sheds ${s.sheds}, collapses ${s.collapses}; state hash \`${ha}\` (two independent replays identical: ${ha === hb}).\n\n| # | T+ | Action |\n|---|---|---|\n${rows.join("\n")}\n`;
  writeFileSync(mdOut, md);
  console.log(`wrote ${mdOut}`);
}
