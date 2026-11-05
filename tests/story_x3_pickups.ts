// Story X3 driven exactly like the browser drives it: one guide tick per 60 Hz frame, speed-limited step batches,
// fast-forward at 300× on wait/until steps, refusal retry after 1500 ms of page time. Finds why the browser run
// differs from the pure engine emulation (story_x3.ts).
//   npx tsx tests/story_x3_browser.ts [speedAtHandover=300] [frameMs=16.667]
import { readFileSync } from "node:fs";
import { Simulation, fmtClock, DT } from "../src/engine/sim";
import { buildGuidedPlan, type PlanStep } from "../src/engine/plan";
import type { Scenario } from "../src/engine/types";
const sc = JSON.parse(readFileSync(new URL("../src/data/scenario.json", import.meta.url), "utf8")) as Scenario;
const B = (id: number) => id - 1;
const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!.idx;
const U = (bus: number, code: string, num = 1) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;
const plan = buildGuidedPlan(sc);
const SPEED_AT_HANDOVER = Number(process.argv[2] ?? 300);
const FRAME_MS = Number(process.argv[3] ?? 1000 / 60);
const VARIANT = process.argv[4] ?? "x3"; // x3: 0.98 + three lines; v105: default 1.05 setpoint, two lines

const sim = new Simulation(sc);
let p = 0; const show = (sim: Simulation) => { for (let i = p; i < sim.log.length; i++) { const e = sim.log[i]; console.log(`    [${fmtClock(e.t)}] ${e.level.padEnd(5)} ${e.text}`); } p = sim.log.length; };
const actions: any[] = []; const act = (c: any) => { const r = sim.apply(c); actions.push({ ...c, t: sim.step, ok: r.ok }); if (!r.ok) console.log("  REFUSED", JSON.stringify(c), r.reason); return r; };

// ---- browser-like loop state (mirrors main.ts)
let speed = 0, speedBeforeFF = 10, ffUntil: (() => boolean) | null = null, acc = 0, now = 0;
let guideIndex = 0, guideEnteredAt = 0, guideRetryAt = 0, guideAuto = false, guideRefusal: string | null = null;
let autoActs = 0; const refusals: string[] = [];
const cmdDone = (c: any, expectBlocks?: number): boolean => {
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
  return false;
};
const stepDone = (s: PlanStep) => s.kind === "wait" ? sim.t - guideEnteredAt >= s.seconds - 1e-9 : s.kind === "until" ? s.cond(sim) : cmdDone(s.cmd, s.expectBlocks) && (s.also ?? []).every((c) => cmdDone(c));
const applyStep = (s: Extract<PlanStep, { kind: "act" }>) => { const r = sim.apply(s.cmd); if (!r.ok) return r; for (const c of s.also ?? []) { if (!cmdDone(c)) { const r2 = sim.apply(c); if (!r2.ok) return r2; } } return r; };
const setSpeed = (s: number) => { ffUntil = null; if (s !== 0) speedBeforeFF = s; speed = s; };
const fastForward = () => { const idx = guideIndex; if (!plan[idx]) return; if (!ffUntil) speedBeforeFF = speed || 10; speed = 300; ffUntil = () => guideIndex !== idx; };
function tickGuide() {
  for (let guard = 0; guard < 50; guard++) {
    const step = plan[guideIndex]; if (!step) return;
    if (stepDone(step)) { guideIndex++; guideEnteredAt = sim.t; guideRefusal = null; if (ffUntil) { ffUntil = null; speed = speedBeforeFF; } continue; }
    if (guideAuto) {
      if (step.kind === "act") { if (now >= guideRetryAt) { const r = applyStep(step); autoActs++; guideRefusal = r.ok ? null : r.reason ?? null; if (!r.ok) refusals.push(`[${fmtClock(sim.t)}] #${guideIndex} ${step.text} -> ${r.reason}`); guideRetryAt = now + (r.ok ? 0 : 1500); } }
      else if (speed > 0 && speed < 300 && !ffUntil) fastForward();
    }
    return;
  }
}
function frame(dtMs = FRAME_MS) {
  const dt = Math.min(250, dtMs); now += dtMs;
  if (speed > 0) {
    acc += (dt / 1000) * speed;
    const steps = Math.min(400, Math.floor(acc / DT)); acc -= steps * DT;
    if (steps > 0) sim.advance(steps);
    if (ffUntil && ffUntil()) { ffUntil = null; speed = speedBeforeFF; }
  }
  tickGuide();
}
const frames = (n: number) => { for (let i = 0; i < n; i++) frame(); };
const seconds = (s: number) => frames(Math.round(s * 60));

// ---- the filmed story, at film-realistic page times
seconds(0.5);
if (VARIANT === "x3") { act({ type: "avr", bus: B(22), vg: 0.98 }); seconds(1.2); }
setSpeed(1); seconds(0.5);
act({ type: "start", unit: U(22, "U50", 1) }); seconds(0.8);
act({ type: "start", unit: U(22, "U50", 2) }); seconds(0.8);
act({ type: "start", unit: U(22, "U50", 3) }); seconds(1.0);
setSpeed(300); while (sim.stats.energizedBuses === 0) frame(); seconds(0.5);
console.log("plant on line at", fmtClock(sim.t)); show(sim);
setSpeed(SPEED_AT_HANDOVER === 300 ? 300 : 10); seconds(0.8);
for (const [f, t] of (VARIANT === "x3" ? [[21, 22], [17, 22], [16, 17]] : [[21, 22], [17, 22]])) { const r = act({ type: "close", branch: BR(f, t) }); console.log(`  close ${f}-${t} at ${fmtClock(sim.t)}: ${r.ok ? "ok" : r.reason}`); seconds(2.0); show(sim); }
console.log("after collapse", fmtClock(sim.t), "energized", sim.stats.energizedBuses, "trips", sim.stats.trips);
seconds(2.0);
// (guide restarts the units itself)
seconds(1.0);
setSpeed(SPEED_AT_HANDOVER);
guideAuto = true;
const handover = sim.t; const handoverFrame = now;
console.log("hand-over at", fmtClock(handover), "speed", speed, "manual actions", actions.length);
let guard = 0; let lastServed = -1;
while (!sim.stats.won && guard++ < 60 * 60 * 20) { frame(); if (Math.round(sim.stats.servedMW) !== lastServed && guard % 600 === 0) { lastServed = Math.round(sim.stats.servedMW); } if (!plan[guideIndex] && sim.t - guideEnteredAt > 120) break; }
const st = sim.stats;
console.log(`won ${st.won} at ${st.won ? fmtClock(st.winAt) : "—"} served ${st.servedMW} / ${st.totalMW} MW blocks ${st.blocksOn}/${st.blocksTotal} trips ${st.trips} sheds ${st.sheds} collapses ${st.collapses} actions ${actions.length + autoActs} (manual ${actions.length}, auto ${autoActs}) page-s after hand-over ${((now - handoverFrame) / 1000).toFixed(1)} sim-s ${(sim.t - handover).toFixed(0)} guideIndex ${guideIndex}/${plan.length}`);
console.log("refusals", refusals.length); refusals.slice(0, 10).forEach((x) => console.log("   " + x));
const bad = sim.log.filter((e) => /shed|UFLS|trip|collapse|under-frequency|over-frequency/i.test(e.text) && e.t > handover);
console.log("events after hand-over worth a look:"); bad.forEach((e) => console.log(`    [${fmtClock(e.t)}] ${e.level.padEnd(5)} ${e.text}`));
const win = sim.log.filter((e) => /Restoration complete/.test(e.text)); win.forEach((e) => console.log(`    [${fmtClock(e.t)}] ${e.text}`));
// ---- pickup timeline (sim time after hand-over → which bus lit which feeder block)
const pick = sim.log.filter((e) => /Pick|feeder|picked up|block/i.test(e.text) && e.t >= handover);
console.log("pickup-ish log lines:", pick.length);
const byBus: Record<string, string[]> = {};
for (const e of sim.log.filter((e) => e.t >= handover)) { const m = e.text.match(/^(\d+) ([A-Z][a-z]+): feeder (\d+)/) || e.text.match(/feeder (\d+) at (\d+) ([A-Z][a-z]+)/); if (m) { const k = m[2] ? `${m[1]} ${m[2]}` : e.text.slice(0, 20); (byBus[k] ||= []).push(fmtClock(e.t)); } }
console.log(JSON.stringify(byBus));
const servedAt: string[] = [];
console.log("sample log after hand-over (every 12th):"); sim.log.filter((e) => e.t >= handover).forEach((e, i) => { if (i % 12 === 0) console.log(`    [${fmtClock(e.t)}] ${e.text.slice(0, 110)}`); });
const pk: Record<string, { t: number[]; mw: number[] }> = {};
for (const e of sim.log.filter((e) => e.t >= handover)) { const m = e.text.match(/^(\d+ [A-Z][a-z]+): Feeder (\d+) picked up \(\+([\d.]+) MW/); if (m) { (pk[m[1]] ||= { t: [], mw: [] }); pk[m[1]].t.push(Math.round((e.t - handover) / 60)); pk[m[1]].mw.push(+m[3]); } }
console.log("minutes after hand-over of each feeder pickup, per bus:");
for (const [k, v] of Object.entries(pk)) console.log(`  ${k.padEnd(12)} ${v.t.join(",")}  (${v.mw.reduce((a, b) => a + b, 0).toFixed(0)} MW)`);
let cum = 0; const tl: string[] = []; for (const e of sim.log.filter((e) => e.t >= handover)) { const m = e.text.match(/Feeder \d+ picked up \(\+([\d.]+) MW/); if (m) { cum += +m[1]; tl.push(`${Math.round((e.t - handover) / 60)}m:${cum.toFixed(0)}`); } }
console.log("cumulative MW vs minutes after hand-over:", tl.filter((_, i) => i % 5 === 0).join("  "));
