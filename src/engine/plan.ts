import type { Simulation } from "./sim";
import { BLOCK_FRACTIONS } from "./sim";
import type { Command, Scenario } from "./types";

/** One step of the guided restoration. `act` steps are operator actions; `wait`/`until` steps let the clock run. */
export type PlanStep =
  | { kind: "act"; cmd: Command; also?: Command[]; text: string; why?: string; target: { kind: "bus" | "branch" | "unit"; id: number }; expectBlocks?: number }
  | { kind: "wait"; seconds: number; text: string; why?: string }
  | { kind: "until"; text: string; why?: string; cond: (sim: Simulation) => boolean; timeout: number; quiet?: boolean; status?: (sim: Simulation) => string };

/** Frequency within the normal band and steady for the last five seconds. */
export function settled(sim: Simulation, islandId?: number) {
  return sim.islands.filter((i) => islandId === undefined || i.id === islandId).every((i) => Math.abs(i.f - 60) < 0.05 && i.fTrace.slice(-20).every((f) => Math.abs(f - 60) < 0.08));
}

/** Branch index of the line damaged in challenge mode: 17–22, the 73-mile Aston–Aubrey line that the guided plan uses first. */
export function challengeDamagedBranch(sc: Scenario) { return sc.branches.find((b) => b.f === 16 && b.t === 21)!.idx; }

export function buildGuidedPlan(sc: Scenario, variant: "guided" | "challenge" = "guided"): PlanStep[] {
  const P: PlanStep[] = [];
  const challenge = variant === "challenge";
  const B = (id: number) => id - 1;
  const name = (id: number) => `${id} ${sc.buses[B(id)].name}`;
  const BR = (f: number, t: number, circuit = 1) => sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === circuit)!;
  const U = (bus: number, code: string, num: number) => sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!;
  const picked: Record<number, number> = {};

  const avr = (bus: number, vg: number, why?: string) => P.push({ kind: "act", cmd: { type: "avr", bus: B(bus), vg }, text: `Set the ${name(bus)} plant voltage setpoint to ${vg.toFixed(2)} pu.`, why, target: { kind: "bus", id: B(bus) } });
  const limit = (bus: number, mw: number, why?: string) => P.push({ kind: "act", cmd: { type: "limit", bus: B(bus), mw }, text: `Limit the ${name(bus)} plant to ${mw} MW.`, why, target: { kind: "bus", id: B(bus) } });
  const start = (bus: number, code: string, nums: number[], why?: string) => nums.forEach((n, i) => { const u = U(bus, code, n); P.push({ kind: "act", cmd: { type: "start", unit: u.idx }, text: `Start ${code === "SynCond" ? "the synchronous condenser" : `${code} #${n}`} at ${name(bus)}.`, why: i === 0 ? why : undefined, target: { kind: "unit", id: u.idx } }); });
  const close = (f: number, t: number, why?: string, circuit = 1) => { const br = BR(f, t, circuit); P.push({ kind: "act", cmd: { type: "close", branch: br.idx }, text: `Close ${br.kind === "transformer" ? "transformer" : "line"} ${f}–${t}${br.circuits > 1 ? ` circuit ${circuit}` : ""} (${sc.buses[B(f)].name} – ${sc.buses[B(t)].name}).`, why, target: { kind: "branch", id: br.idx } }); };
  const reactor = (bus: number, on: boolean, why?: string) => P.push({ kind: "act", cmd: { type: "reactor", bus: B(bus), on }, text: `Switch the ${name(bus)} shunt reactor ${on ? "in" : "out"}.`, why, target: { kind: "bus", id: B(bus) } });
  const wait = (seconds: number, text: string, why?: string) => P.push({ kind: "wait", seconds, text, why });
  const settle = (why?: string) => P.push({ kind: "until", text: "Let frequency settle.", why, timeout: 900, quiet: true, cond: (sim) => settled(sim), status: () => "Waiting for frequency to settle." });
  /** Pick up the next feeder at a bus, after waiting for enough governor and dispatch headroom in its island. */
  const pickup = (bus: number, why?: string) => {
    picked[bus] = (picked[bus] ?? 0) + 1;
    const n = picked[bus], mw = sc.buses[B(bus)].pd * BLOCK_FRACTIONS[n - 1];
    P.push({ kind: "until", text: `Wait for headroom before picking up ${mw.toFixed(0)} MW at ${name(bus)}.`, timeout: 7200, quiet: true, cond: (sim) => {
      const b = sim.buses[B(bus)]; if (!b.energized) return true; // let the action be refused with its own reason
      const h = sim.headroom(b.island);
      return settled(sim, b.island) && h.guide >= mw * 1.3 && h.agcRoom >= mw * 1.5 + 10;
    }, status: (sim) => {
      const b = sim.buses[B(bus)]; if (!b.energized) return "";
      const h = sim.headroom(b.island);
      if (!settled(sim, b.island)) return "Waiting for frequency to settle at 60.00 Hz.";
      return `Waiting for headroom: governor guide ${h.guide.toFixed(0)} MW and dispatch room ${h.agcRoom.toFixed(0)} MW; this ${mw.toFixed(0)} MW block needs ${(mw * 1.3).toFixed(0)} and ${(mw * 1.5 + 10).toFixed(0)} MW. Units load up at their ramp rate.`;
    } });
    P.push({ kind: "act", cmd: { type: "pickup", bus: B(bus) }, text: `Pick up feeder ${n} at ${name(bus)} (${mw.toFixed(0)} MW).`, why, target: { kind: "bus", id: B(bus) }, expectBlocks: n });
  };
  const untilOnline = (bus: number, code: string, num: number, text: string, why?: string) => { const u = U(bus, code, num); P.push({ kind: "until", text, why, timeout: 9 * 3600, cond: (sim) => sim.units[u.idx].status === "online" }); };

  // ---- Stage 0: black-start units
  avr(22, 0.98, "The hydro plant will energize long, unloaded 230 kV lines. Their charging raises voltage along the line (Ferranti effect), so start from a low setpoint.");
  start(22, "U50", [1, 2, 3, 4, 5, 6], "Hydro units can start with no outside power and are on line in about ten minutes. Aubrey's six 50 MW units are the system's black-start resource.");
  start(1, "U20", [1, 2], "The 20 MW combustion turbines at Abel and Adams are the second black-start resource. They will supply station service to the coal units next to them.");
  start(2, "U20", [1, 2]);
  wait(600, "Wait for the hydro units to synchronize (10 min).", "Nothing is energized yet: every breaker is open and every load is dark.");

  // ---- Stage 1: north 230 kV spine from Aubrey
  close(21, 22, "Energize one line at a time and watch voltage. Line 21–22 carries 14 Mvar of charging that the hydro units must absorb.");
  if (challenge) {
    close(15, 21, "With the Aston–Aubrey line out of service, the only way north is through Attlee and Arthur.");
    close(15, 16);
    pickup(16, "Load absorbs reactive power and gives the governors something to carry. Pick up the smallest feeder first.");
    close(16, 19);
    pickup(19);
    pickup(15);
    close(16, 17);
    close(17, 18);
    pickup(18);
  } else {
    close(17, 22, "The 73-mile line to Aston adds 22 Mvar of charging — the longest line in the system.");
    close(16, 17);
    pickup(16, "Load absorbs reactive power and gives the governors something to carry. Pick up the smallest feeder first: the island has 300 MW of hydro but only 5 % droop holding frequency.");
    close(16, 19);
    pickup(19);
    close(15, 16);
    pickup(15, "Each pickup pulls frequency down until the governors and then the automatic generation control catch up. The guide waits for 60.00 Hz before the next one.");
    close(17, 18);
    pickup(18);
  }
  start(16, "U155", [1], "The coal unit at Asser needs 7 % of its rating as cranking power from the island for a three-hour hot start.");
  start(15, "U155", [6]);
  start(15, "U12", [1, 2, 3, 4, 5], "The five 12 MW oil units at Arthur take two hours; their cranking load is small.");
  close(14, 16, "Arnold has a synchronous condenser: up to 200 Mvar of voltage support once it is spinning.");
  pickup(14);
  start(14, "SynCond", [1], "The condenser starts as a motor and is on line in twenty minutes. Cranking loads run at 0.85 power factor and the hydro units can only supply 96 Mvar — the condenser is what keeps far-end voltage up.");
  wait(300, "Let the cranking loads ramp in (5 min).", "Auxiliary load comes in over a few minutes as pumps and fans start.");
  avr(22, 1.02, "With load on the lines the voltage profile sags toward the far end. Raise the hydro setpoint, keeping every bus under 1.05 pu.");
  pickup(16);
  close(19, 20, "Attila and Austen come next. Line 19–20 has two circuits; one is enough for now.");
  pickup(20);
  close(20, 23);
  start(23, "U155", [1, 2], "Austen holds 660 MW of coal capacity. Crank both 155 MW units now; they take three hours. The 350 MW unit needs eight hours and is not required for tonight's 1 681 MW.");
  wait(300, "Let Austen's cranking loads ramp in (5 min).");
  pickup(20);
  untilOnline(14, "SynCond", 1, "Wait for the Arnold condenser to synchronize.", "Watch the voltage profile: Arne and Austen are a long way from the only reactive source.");
  avr(14, 1.0, "The condenser is now the reactive source in the middle of the system. Raise it from 0.98 so the far buses stay nearer 0.95 pu while the steam units are still cranking.");
  close(13, 23, "Arne's three 197 MW oil units are the largest block of capacity that can be ready within four hours.");
  pickup(13);
  start(13, "U197", [1, 2, 3], "Cranking 41 MW of auxiliaries for a four-hour hot start — the condenser covers their reactive demand.");
  wait(300, "Let Arne's cranking loads ramp in (5 min).");
  pickup(19);

  // ---- Stage 2: reach Avery, Adler and the 138 kV system from the north
  close(15, 24);
  close(3, 24, "The Avery transformer brings the north island down to the 138 kV system at Adler.");
  pickup(3);
  close(12, 23, "Energize the Archer and Anna 230 kV buses from Austen and Arne.");
  close(12, 13);
  close(11, 13);
  close(11, 14);
  close(9, 11, "Two 230/138 kV transformers bring the system down to Ali and Allen.");
  close(10, 12);
  pickup(9);
  pickup(10);
  close(8, 10);
  pickup(8);
  close(7, 8, "Alder's three 100 MW oil units need two hours. Crank them now.");
  start(7, "U100", [1, 2, 3]);
  limit(7, 160, "Line 7–8 is Alder's only connection and is rated 175 MVA. Cap the plant so it can never export more than the line carries, whatever the rest of the system does.");
  wait(300, "Let Alder's cranking loads ramp in (5 min).");
  pickup(7);
  pickup(13);

  // ---- Stage 3: the combustion-turbine islands crank the coal units at Abel and Adams, then join the system
  P.push({ kind: "until", text: "Wait for the combustion turbines at Abel and Adams to come on line (30 min after start).", timeout: 3600, cond: (sim) => [1, 2].every((b) => sim.buses[B(b)].energized) });
  avr(1, 1.03, "Match the main system's voltage so the tie can be closed, then hold the weak 138 kV side up: the south is fed over long lines until its own units arrive.");
  avr(2, 1.03);
  start(1, "U76", [3, 4], "Each CT island is only 40 MW. Use it for cranking, not load: the two coal units draw 5 MW each for a three-hour hot start.");
  start(2, "U76", [3, 4]);
  wait(300, "Let the coal units' cranking loads ramp in (5 min).");
  close(1, 3, "Synchronize the Abel island to the main system: the breaker closes only if frequency and voltage match across it.");
  close(2, 4, "Bring Agricola in from Adams, then tie Adams to the main system through 4–9.");
  close(4, 9);
  pickup(1);
  pickup(2);
  pickup(4);
  close(1, 5);
  pickup(5);
  close(5, 10);
  close(2, 6, "Alber's line is ordinary. The 6–10 cable beyond it carries 246 Mvar of charging and stays open until the end.");
  pickup(6);
  close(8, 9);

  // ---- Stage 4: second-wave pickups as units arrive and load up
  untilOnline(15, "U12", 5, "Wait for the Arthur oil units to synchronize (2 h after cranking).", "Frequency control gets easier with every unit on line: more inertia, more governor response. Units load up at their ramp rate after synchronizing.");
  for (const b of [3, 9, 10, 8]) pickup(b);
  untilOnline(7, "U100", 3, "Wait for Alder's oil units to synchronize.");
  avr(1, 1.0, "With Alder's units on line the south holds its own voltage: bring Abel and Adams back to 1.00 pu so nothing runs high when the loops close.");
  avr(2, 1.0);
  for (const b of [15, 18, 14, 7]) pickup(b);
  for (const b of [16, 19, 20, 13, 3, 9, 10, 8, 7, 14]) pickup(b);
  untilOnline(23, "U155", 2, "Wait for the Asser, Arthur and Austen coal units to synchronize (3 h after cranking).");
  if (!challenge) close(15, 21, "With four 155 MW units absorbing reactive power, the parallel circuits can be closed.");
  close(18, 21, challenge ? "With four 155 MW units absorbing reactive power, the parallel circuits can be closed." : undefined);
  close(19, 20, undefined, 2);
  close(20, 23, undefined, 2);
  for (const b of [15, 18, 1, 2, 4, 5, 6]) pickup(b);
  for (const b of [16, 19, 15, 18, 13, 20, 14, 3, 9, 10, 8, 7]) pickup(b);
  untilOnline(2, "U76", 4, "Wait for the Abel and Adams coal units to synchronize.");
  close(1, 2, "The Abel–Adams cable adds 46 Mvar of charging; with the coal units on line the system can absorb it.");
  for (const b of [1, 2, 4, 5, 6]) pickup(b);
  for (const b of [16, 19, 20, 14, 3, 7]) pickup(b);
  untilOnline(13, "U197", 3, "Wait for Arne's 197 MW units to synchronize (4 h after cranking).");
  for (const b of [18, 15, 13, 9, 10, 8, 1, 2, 4, 5, 6]) pickup(b);
  for (const b of [1, 2, 4, 5, 6]) pickup(b);
  close(15, 21, "Close the remaining parallel circuits to restore normal topology.", 2);
  close(18, 21, undefined, 2);
  avr(7, 1.0, "The cable's charging will lift the Allen and Alber voltages. Lower Alder's setpoint first so the 138 kV side has room under 1.05 pu.");
  reactor(6, true, "The last element is the Alber–Allen cable: 246 Mvar of charging, covered by the reactor and the units now on line. Switch the reactor in and close the cable together — the reactor alone drags the weak 138 kV side down, the cable alone lifts it past 1.15 pu.");
  { const last = P[P.length - 1]; if (last.kind === "act") { last.also = [{ type: "close", branch: BR(6, 10).idx }]; last.text = `Switch the ${name(6)} shunt reactor in and close the 6–10 cable with it.`; } }
  settle();
  return P;
}
