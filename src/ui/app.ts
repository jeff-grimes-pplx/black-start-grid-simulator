import { Simulation, replay, fmtClock, DT } from "../engine/sim";
import { buildGuidedPlan, challengeDamagedBranch, type PlanStep } from "../engine/plan";
import { BANDS } from "../engine/protection";
import type { Action, Command, Scenario } from "../engine/types";
import { MapView, type Selection, type FerrantiBannerState } from "./map";
import { drawVoltageProfile, drawQvFerrantiCurve, drawPhasorAndFrequency } from "./telemetry";
import { ScadaSoundEngine } from "./sound";
import verifiedTelemetry from "../data/verified_telemetry.json";

export type AppMode = "ferranti" | "guided" | "sandbox";

export class App {
  readonly sc: Scenario;
  readonly refActions: Action[];
  sim: Simulation;
  map: MapView;
  sound = new ScadaSoundEngine();

  mode: AppMode = "ferranti";
  speed = 10; // default 10x so unit synchronization and frequency response feel responsive
  paused = false;

  // Ferranti Demo state (0 = 3 units online @ 0.980 pu, 1 = Line 21-22 closed, 2 = Line 17-22 closed (1.080 pu), 3 = Line 16-17 closed (1.211 pu Trip!), 4 = Recovered with 6 units)
  ferrantiStep = 0;
  ferrantiPeakPu = 0.98;
  ferrantiTripped = false;
  ferrantiAutoTimer: number | null = null;

  // Guided 163-step state
  plan: PlanStep[] = [];
  guideIndex = 0;
  guideAuto = false;
  guideEnteredAt = 0;
  guideRefusal: string | null = null;
  private guideAutoRetryAt = 0;

  // Sandbox / Contingency / Replay state
  contingencyDamaged = false;
  replayMode = false;
  replayCursor = 0;

  private lastFrame = performance.now();
  private simAccum = 0;
  private lastUiRender = 0;
  private toastTimer = 0;
  private lastWorkflowSig = "";

  constructor(sc: Scenario, refActions: Action[]) {
    this.sc = sc;
    this.refActions = refActions;
    this.sim = new Simulation(sc);
    this.plan = buildGuidedPlan(sc, "guided");

    const canvas = document.getElementById("map-canvas") as HTMLCanvasElement;
    this.map = new MapView(canvas, this.sim);
    this.map.onSelect = (sel) => {
      this.renderInspector();
      this.renderTelemetryCanvases();
      void sel;
    };
    this.map.onQuickAction = (sel) => this.handleQuickAction(sel);

    this.bindTopBar();
    this.bindDrawer();

    // Initialize into Mode 1 (Ferranti Trap Demo — Stage 0: 22 Aubrey 3x50 MW Hydro Online at 0.980 pu)
    // so the very first visible frame has an active glowing island, spinning rotor needle, and immediate interactive payoff!
    this.loadFerrantiStage(0, false);

    // Expose deterministic automation hook for Playwright verification & showcase video capture
    (window as unknown as Record<string, unknown>).__blackStartApp = this;

    requestAnimationFrame((t) => this.tick(t));
  }

  // ============================================================================
  // MODE & STAGE PRESET CONTROLLERS
  // ============================================================================

  setMode(mode: AppMode) {
    this.stopFerrantiAuto();
    this.mode = mode;
    this.replayMode = false;

    document.querySelectorAll<HTMLElement>("[data-mode-btn]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.modeBtn === mode);
    });

    if (mode === "ferranti") {
      if (this.sim.stats.servedMW > 50 || this.sim.stats.energizedBuses > 6) {
        this.loadFerrantiStage(0, false);
      } else {
        this.updateFerrantiBanner();
      }
      this.map.sel = { kind: "bus", idx: 21 };
    } else if (mode === "guided") {
      this.map.ferrantiBanner = null;
      this.syncGuidePointer();
    } else {
      this.map.ferrantiBanner = null;
      this.guideAuto = false;
      this.map.highlight = null;
      this.replayCursor = Math.min(this.refActions.length, this.sim.actions.length);
    }

    this.renderWorkflowStrip();
    this.renderTopBar();
    this.renderInspector();
    this.renderTelemetryCanvases();
    this.renderEventLog();
  }

  /**
   * Load exact deterministic stage of the Ferranti Over-Voltage Trap out of 22 Aubrey Hydro:
   * - stage 0: 3 × 50 MW Hydro Units (U50 #1, #2, #3) online at 0.980 pu setpoint (0 lines closed) -> V_22 = 0.980 pu
   * - stage 1: Close Line 21–22 (47 mi, +14.2 Mvar charging) -> V_22 = 0.980 pu, V_21 = 0.985 pu, Q_22 = -13.7 Mvar
   * - stage 2: Close Line 17–22 (73 mi, +22.2 Mvar charging) -> Qmin (-30 Mvar) saturated! V_22 jumps to 1.080 pu, V_17 = 1.093 pu
   * - stage 3: Close Line 16–17 (18 mi, +5.5 Mvar charging) -> V_22 spikes to 1.211 pu (>= 1.200 pu PRC-024 Instant Trip!) -> Island collapses!
   * - stage 4: Recovery — All 6 Hydro Units online (Qmin = -60 Mvar) across all 3 lines -> V_22 holds 0.980 pu cleanly!
   */
  loadFerrantiStage(stage: number, playAudio = true) {
    this.stopFerrantiAuto();
    this.mode = "ferranti";
    this.guideAuto = false;
    this.replayMode = false;
    document.querySelectorAll<HTMLElement>("[data-mode-btn]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.modeBtn === "ferranti");
    });

    const B = (id: number) => id - 1;
    const BR = (f: number, t: number) =>
      this.sc.branches.find((b) => b.f === B(f) && b.t === B(t) && b.circuit === 1)!.idx;
    const U = (bus: number, code: string, num: number) =>
      this.sc.units.find((u) => u.bus === B(bus) && u.code === code && u.num === num)!.idx;

    this.sim = new Simulation(this.sc);
    this.map.setSim(this.sim);
    this.ferrantiStep = stage;
    this.ferrantiTripped = false;
    this.ferrantiPeakPu = 0.98;

    // Set 22 Aubrey AVR setpoint to 0.980 pu
    this.sim.apply({ type: "avr", bus: B(22), vg: 0.98 });

    if (stage <= 3) {
      // Start 3 of 6 hydro units at 22 Aubrey (Qmin = -30 Mvar total)
      this.sim.apply({ type: "start", unit: U(22, "U50", 1) });
      this.sim.apply({ type: "start", unit: U(22, "U50", 2) });
      this.sim.apply({ type: "start", unit: U(22, "U50", 3) });
      this.sim.advanceSeconds(602); // 10 min hydro start -> online at T+00:10:02
    } else {
      // Stage 4 Recovery: Start all 6 hydro units (Qmin = -60 Mvar total)
      for (let n = 1; n <= 6; n++) {
        this.sim.apply({ type: "start", unit: U(22, "U50", n) });
      }
      this.sim.advanceSeconds(602);
    }

    if (stage >= 1) {
      this.sim.apply({ type: "close", branch: BR(21, 22) });
      this.sim.advance(2);
      this.ferrantiPeakPu = Math.max(this.ferrantiPeakPu, this.sim.buses[B(22)].Vm);
    }
    if (stage >= 2) {
      this.sim.apply({ type: "close", branch: BR(17, 22) });
      this.sim.advance(2);
      this.ferrantiPeakPu = Math.max(this.ferrantiPeakPu, this.sim.buses[B(22)].Vm);
    }
    if (stage === 3) {
      // Close the 3rd unloaded line 16–17: solved voltage hits 1.2113 pu at 22 Aubrey (1.2336 pu at 16 Asser),
      // which triggers NERC PRC-024 instantaneous >=1.20 pu over-voltage relay trip on the very first physics step!
      this.sim.apply({ type: "close", branch: BR(16, 17) });
      this.ferrantiPeakPu = 1.2113;
      this.sim.advance(1); // Executes solveAll (1.2113 pu) -> protectionStep (instantaneous PRC-024 trip!) -> island blackout
      this.ferrantiTripped = true;
      this.map.triggerTripShockwave(1.2113);
      if (playAudio) this.sound.playPrc024TripAlarm();
    } else if (stage === 4) {
      this.sim.apply({ type: "close", branch: BR(16, 17) });
      this.sim.advance(4);
      this.ferrantiPeakPu = this.sim.buses[B(22)].Vm;
      if (playAudio) this.sound.playUnitSync();
    } else if (playAudio) {
      if (stage === 2) this.sound.playFerrantiWarning();
      else if (stage === 1) this.sound.playBreakerClose(0.985);
      else this.sound.playUnitSync();
    }

    // Highlight the next target breaker on the map
    if (stage === 0) {
      this.map.highlight = { kind: "branch", idx: BR(21, 22) };
      this.map.sel = { kind: "bus", idx: B(22) };
    } else if (stage === 1) {
      this.map.highlight = { kind: "branch", idx: BR(17, 22) };
      this.map.sel = { kind: "branch", idx: BR(21, 22) };
    } else if (stage === 2) {
      this.map.highlight = { kind: "branch", idx: BR(16, 17) };
      this.map.sel = { kind: "bus", idx: B(22) };
    } else if (stage === 3) {
      this.map.highlight = { kind: "bus", idx: B(22) };
      this.map.sel = { kind: "bus", idx: B(22) };
    } else {
      this.map.highlight = null;
      this.map.sel = { kind: "bus", idx: B(22) };
    }

    this.updateFerrantiBanner();
    this.renderWorkflowStrip();
    this.renderTopBar();
    this.renderInspector();
    this.renderTelemetryCanvases();
    this.renderEventLog();
  }

  /** Step forward one stage in the Ferranti Trap Demo */
  stepFerrantiDemo() {
    const next = this.ferrantiStep < 4 ? this.ferrantiStep + 1 : 0;
    this.loadFerrantiStage(next, true);
  }

  /** Auto-play the 4-stage Ferranti Overvoltage Collapse & Recovery demo */
  toggleFerrantiAutoPlay() {
    if (this.ferrantiAutoTimer !== null) {
      this.stopFerrantiAuto();
      this.renderWorkflowStrip();
      return;
    }
    this.loadFerrantiStage(0, true);
    this.ferrantiAutoTimer = window.setInterval(() => {
      if (this.ferrantiStep < 4) {
        this.loadFerrantiStage(this.ferrantiStep + 1, true);
      } else {
        this.stopFerrantiAuto();
        this.renderWorkflowStrip();
      }
    }, 2800);
    this.renderWorkflowStrip();
  }

  private stopFerrantiAuto() {
    if (this.ferrantiAutoTimer !== null) {
      clearInterval(this.ferrantiAutoTimer);
      this.ferrantiAutoTimer = null;
    }
  }

  private updateFerrantiBanner() {
    if (this.mode !== "ferranti") {
      this.map.ferrantiBanner = null;
      return;
    }
    const b22 = this.sim.buses[21];
    const b17 = this.sim.buses[16];
    const b16 = this.sim.buses[15];
    const aubreyUnits = this.sc.units.filter((u) => u.bus === 21);
    const onlineUnits = aubreyUnits.filter((u) => this.sim.units[u.idx].status === "online");
    const qGen = onlineUnits.reduce((s, u) => s + this.sim.units[u.idx].Q, 0);
    const qLim = onlineUnits.reduce((s, u) => s + u.qmin, 0);

    const stepMeta: Record<number, { headline: string; detail: string }> = {
      0: {
        headline: "Stage 0 · 22 Aubrey Hydro Online (3 × 50 MW Units @ 0.980 pu)",
        detail: "3 hydro units provide −30 Mvar under-excitation capacity. Click 'Close Line 21–22' to energize the first 230 kV line.",
      },
      1: {
        headline: "Stage 1 · Line 21–22 Closed (+14.2 Mvar Charging) → 0.980 pu",
        detail: "22 Aubrey absorbs −13.7 Mvar (within −30 Mvar Qmin limit). AVR holds bus at 0.980 pu (21 Attlee at 0.985 pu).",
      },
      2: {
        headline: "Stage 2 · Line 17–22 Closed (+22.2 Mvar) → 1.080 pu (Qmin Saturated!)",
        detail: "Total charging (+36.4 Mvar) exceeds 3-unit −30 Mvar Qmin ceiling! Fixed EMF behind Xd=1.8 pu pushes 22 Aubrey to 1.080 pu.",
      },
      3: {
        headline: "Stage 3 · Line 16–17 Closed (+5.5 Mvar) → 1.211 pu PRC-024 RELAY TRIP!",
        detail: "Uncompensated Ferranti rise drives 22 Aubrey to 1.211 pu (≥1.200 pu instant trip limit). All 3 hydro units trip — island collapses!",
      },
      4: {
        headline: "Stage 4 · Recovered with All 6 Hydro Units (−60 Mvar Qmin) → 0.980 pu",
        detail: "With all 6 × 50 MW units online (−60 Mvar absorbing capacity), 22 Aubrey absorbs −40.5 Mvar and holds 0.980 pu across all 3 lines.",
      },
    };

    const meta = stepMeta[this.ferrantiStep] ?? stepMeta[0];
    const banner: FerrantiBannerState = {
      active: true,
      step: this.ferrantiStep,
      vAubrey: this.ferrantiTripped ? 1.2113 : b22.Vm,
      vAston: this.ferrantiTripped ? 1.2295 : b17.Vm,
      vAsser: this.ferrantiTripped ? 1.2336 : b16.Vm,
      qAubreyMvar: this.ferrantiTripped ? -61.82 : qGen,
      qLimitMvar: qLim,
      qSaturated: b22.qLimit === -1 || this.ferrantiStep === 2,
      tripped: this.ferrantiTripped,
      headline: meta.headline,
      detail: meta.detail,
    };
    this.map.ferrantiBanner = banner;
  }

  /**
   * Jump directly to any of the 6 major restoration milestones (using deterministic replay of reference_actions.json)
   */
  loadRestorationMilestone(milestoneId: "blackout" | "hydro-ready" | "north-spine" | "multi-island" | "cable-reactor" | "full-1682") {
    this.stopFerrantiAuto();
    this.guideAuto = false;
    this.replayMode = false;

    if (milestoneId === "blackout") {
      this.sim = new Simulation(this.sc, { damaged: this.contingencyDamaged ? [challengeDamagedBranch(this.sc)] : [] });
      this.map.setSim(this.sim);
      this.ferrantiTripped = false;
      this.ferrantiPeakPu = 0;
      this.guideIndex = 0;
      this.guideEnteredAt = 0;
      this.map.sel = { kind: "bus", idx: 21 };
    } else if (milestoneId === "hydro-ready") {
      this.loadFerrantiStage(0, true);
      return;
    } else {
      // Slice reference_actions.json up to the milestone action index
      const actionCounts: Record<string, number> = {
        "north-spine": 28,    // Northern 230 kV spine energized, steam plants cranking, 14 Arnold SynCon starting
        "multi-island": 64,   // North 230 kV + South 138 kV CT islands active, initial load blocks restored
        "cable-reactor": 108, // 6 Alber 100 Mvar shunt reactor + 6-10 cable energized, thermal units ramping
        "full-1682": this.refActions.length, // All 163 actions -> 1,681.5 / 1,682 MW restored at 60.00 Hz
      };
      const count = actionCounts[milestoneId] ?? this.refActions.length;
      this.replayCursor = count;
      const slice = this.refActions.slice(0, count);
      const tailSteps = milestoneId === "full-1682" ? 300 : 20;
      this.sim = replay(this.sc, slice, { tailSteps });
      this.map.setSim(this.sim);
      this.ferrantiTripped = false;
      this.ferrantiPeakPu = this.sim.stats.vMax;
      this.sound.playUnitSync();

      // Advance guideIndex to match the exact action count reached by this milestone
      this.plan = buildGuidedPlan(this.sc, this.contingencyDamaged ? "challenge" : "guided");
      let actionsSeen = 0;
      this.guideIndex = 0;
      while (this.guideIndex < this.plan.length && actionsSeen < count) {
        const st = this.plan[this.guideIndex];
        if (st.kind === "act") {
          actionsSeen += 1 + (st.also?.length ?? 0);
        }
        this.guideIndex++;
      }
      while (this.guideIndex < this.plan.length) {
        const st = this.plan[this.guideIndex];
        if ((st.kind === "until" && st.cond(this.sim)) || st.kind === "wait") {
          this.guideIndex++;
        } else {
          break;
        }
      }
      this.guideEnteredAt = this.sim.t;
      this.updateGuideHighlight();
    }

    if (milestoneId === "blackout") {
      this.syncGuidePointer();
    }
    this.updateFerrantiBanner();
    this.renderWorkflowStrip();
    this.renderTopBar();
    this.renderInspector();
    this.renderTelemetryCanvases();
    this.renderEventLog();
  }

  // ============================================================================
  // GUIDED 163-STEP RESTORATION ENGINE
  // ============================================================================

  private cmdDone(c: Command, expectBlocks?: number): boolean {
    switch (c.type) {
      case "start":
        return this.sim.units[c.unit].status === "starting" || this.sim.units[c.unit].status === "online";
      case "stop":
        return this.sim.units[c.unit].status === "off";
      case "close":
        return this.sim.branches[c.branch].closed;
      case "open":
        return !this.sim.branches[c.branch].closed;
      case "pickup":
        return this.sim.buses[c.bus].blocks >= (expectBlocks ?? 1);
      case "drop":
        return true;
      case "reactor":
        return this.sim.buses[c.bus].reactorOn === c.on;
      case "avr":
        return Math.abs(this.sim.buses[c.bus].vset - c.vg) < 1e-6;
      case "limit":
        return Math.round(this.sim.buses[c.bus].plimit) === Math.round(c.mw);
    }
  }

  private stepDone(step: PlanStep): boolean {
    if (step.kind === "wait") return this.sim.t - this.guideEnteredAt >= step.seconds - 1e-9;
    if (step.kind === "until") return step.cond(this.sim);
    return this.cmdDone(step.cmd, step.expectBlocks) && (step.also ?? []).every((c) => this.cmdDone(c));
  }

  private syncGuidePointer() {
    this.plan = buildGuidedPlan(this.sc, this.contingencyDamaged ? "challenge" : "guided");
    this.guideIndex = 0;
    this.guideEnteredAt = this.sim.t;
    while (this.guideIndex < this.plan.length) {
      const st = this.plan[this.guideIndex];
      if (st.kind === "act" && this.stepDone(st)) {
        this.guideIndex++;
        this.guideEnteredAt = this.sim.t;
      } else if (st.kind === "until" && st.cond(this.sim)) {
        this.guideIndex++;
        this.guideEnteredAt = this.sim.t;
      } else {
        break;
      }
    }
    this.updateGuideHighlight();
  }

  private updateGuideHighlight() {
    if (this.mode !== "guided") return;
    const step = this.plan[this.guideIndex];
    if (!step || step.kind !== "act") {
      this.map.highlight = null;
      return;
    }
    const c = step.cmd;
    if (c.type === "close" || c.type === "open") {
      this.map.highlight = { kind: "branch", idx: c.branch };
    } else if (c.type === "start" || c.type === "stop") {
      this.map.highlight = { kind: "bus", idx: this.sc.units[c.unit].bus };
    } else {
      this.map.highlight = { kind: "bus", idx: c.bus };
    }
  }

  executeCurrentGuideStep() {
    const step = this.plan[this.guideIndex];
    if (!step) return;
    if (step.kind === "act") {
      const r = this.sim.apply(step.cmd);
      if (!r.ok) {
        this.guideRefusal = r.reason ?? "Action blocked by protective interlock.";
        this.showToast(this.guideRefusal);
      } else {
        for (const c of step.also ?? []) {
          if (!this.cmdDone(c)) this.sim.apply(c);
        }
        this.guideRefusal = null;
        this.sound.playBreakerClose();
      }
    } else if (step.kind === "wait") {
      const rem = Math.max(0, step.seconds - (this.sim.t - this.guideEnteredAt));
      this.sim.advanceSeconds(rem + DT);
    } else if (step.kind === "until") {
      let guard = 0;
      const cap = Math.round(1800 / DT);
      while (!step.cond(this.sim) && guard++ < cap) {
        this.sim.advance(1);
      }
    }
    this.advanceCompletedGuideSteps();
    this.renderWorkflowStrip();
    this.renderTopBar();
    this.renderInspector();
    this.renderTelemetryCanvases();
    this.renderEventLog();
  }

  private advanceCompletedGuideSteps() {
    let guard = 0;
    while (this.guideIndex < this.plan.length && guard++ < 40) {
      const step = this.plan[this.guideIndex];
      if (this.stepDone(step)) {
        this.guideIndex++;
        this.guideEnteredAt = this.sim.t;
        this.guideRefusal = null;
      } else {
        break;
      }
    }
    this.updateGuideHighlight();
  }

  // ============================================================================
  // INTERACTIVE OPERATOR ACTIONS
  // ============================================================================

  applyOperatorCommand(cmd: Command) {
    const prevTrips = this.sim.stats.trips + this.sim.stats.collapses;
    const res = this.sim.apply(cmd);
    if (!res.ok) {
      this.showToast(res.reason ?? "Action blocked by SCADA interlock.");
      return res;
    }

    // Step physics once immediately so power flow & protection update right away
    this.sim.advance(1);

    // Check if we are in Ferranti mode and the user manually clicked one of the 3 northern 230 kV lines
    if (this.mode === "ferranti") {
      const b22 = this.sim.buses[21];
      if (this.sim.stats.trips + this.sim.stats.collapses > prevTrips) {
        this.ferrantiStep = 3;
        this.ferrantiTripped = true;
        this.ferrantiPeakPu = 1.2113;
        this.map.triggerTripShockwave(1.2113);
        this.sound.playPrc024TripAlarm();
      } else if (b22.Vm > 1.05) {
        this.ferrantiStep = 2;
        this.ferrantiPeakPu = Math.max(this.ferrantiPeakPu, b22.Vm);
        this.sound.playFerrantiWarning();
      } else {
        this.sound.playBreakerClose(b22.Vm || 1.0);
      }
      this.updateFerrantiBanner();
    } else {
      if (this.sim.stats.trips + this.sim.stats.collapses > prevTrips) {
        this.sound.playPrc024TripAlarm();
      } else if (cmd.type === "close") {
        this.sound.playBreakerClose();
      } else if (cmd.type === "open") {
        this.sound.playBreakerOpen();
      } else if (cmd.type === "start") {
        this.sound.playUnitSync();
      }
    }

    this.advanceCompletedGuideSteps();
    this.renderWorkflowStrip();
    this.renderTopBar();
    this.renderInspector();
    this.renderTelemetryCanvases();
    this.renderEventLog();
    return res;
  }

  private handleQuickAction(sel: Selection) {
    if (!sel) return;
    if (sel.kind === "branch") {
      const br = this.sim.branches[sel.idx];
      this.applyOperatorCommand({ type: br.closed ? "open" : "close", branch: sel.idx });
    } else {
      const b = this.sim.buses[sel.idx];
      if (b.energized && this.sc.buses[sel.idx].pd > 0 && b.blocks < 5) {
        this.applyOperatorCommand({ type: "pickup", bus: sel.idx });
      }
    }
  }

  private showToast(msg: string) {
    const el = document.getElementById("scada-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove("visible"), 4200);
  }

  // ============================================================================
  // ANIMATION & PHYSICS LOOP
  // ============================================================================

  private tick(nowMs: number) {
    const dtSec = Math.min(0.1, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    if (!this.paused && !this.replayMode) {
      this.simAccum += dtSec * this.speed;
      const maxSteps = 28;
      let stepsRun = 0;
      const prevTrips = this.sim.stats.trips + this.sim.stats.collapses;

      while (this.simAccum >= DT && stepsRun < maxSteps) {
        this.sim.advance(1);
        this.simAccum -= DT;
        stepsRun++;
      }
      if (stepsRun === maxSteps) this.simAccum = 0;

      if (this.sim.stats.trips + this.sim.stats.collapses > prevTrips) {
        this.sound.playPrc024TripAlarm();
        this.map.triggerTripShockwave(1.2113);
      }

      if (this.mode === "guided") {
        this.advanceCompletedGuideSteps();
        if (this.guideAuto && nowMs >= this.guideAutoRetryAt) {
          const st = this.plan[this.guideIndex];
          if (st && st.kind === "act") {
            const r = this.sim.apply(st.cmd);
            if (r.ok) {
              for (const c of st.also ?? []) {
                if (!this.cmdDone(c)) this.sim.apply(c);
              }
              this.advanceCompletedGuideSteps();
            } else {
              this.guideRefusal = r.reason ?? null;
              this.guideAutoRetryAt = nowMs + 1200;
            }
          }
        }
      }
    }

    this.map.draw(nowMs);

    if (nowMs - this.lastUiRender > 160) {
      this.lastUiRender = nowMs;
      this.renderTopBar();
      this.renderWorkflowStrip();
      this.renderTelemetryCanvases();
      this.renderEventLog();
    }

    requestAnimationFrame((t) => this.tick(t));
  }

  // ============================================================================
  // UI RENDERERS
  // ============================================================================

  private bindTopBar() {
    document.querySelectorAll<HTMLElement>("[data-mode-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = btn.dataset.modeBtn as AppMode;
        if (m) this.setMode(m);
      });
    });

    document.querySelectorAll<HTMLElement>("[data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = Number(btn.dataset.speed);
        if (s === 0) {
          this.paused = true;
        } else {
          this.paused = false;
          this.speed = s;
        }
        this.renderTopBar();
      });
    });

    document.getElementById("btn-audio-toggle")?.addEventListener("click", () => {
      this.sound.enabled = !this.sound.enabled;
      const btn = document.getElementById("btn-audio-toggle");
      if (btn) {
        btn.textContent = this.sound.enabled ? "🔊 Audio On" : "🔇 Muted";
        btn.classList.toggle("active", this.sound.enabled);
      }
    });

    document.getElementById("btn-zoom-in")?.addEventListener("click", () => this.map.zoomBy(1.22));
    document.getElementById("btn-zoom-out")?.addEventListener("click", () => this.map.zoomBy(1 / 1.22));
    document.getElementById("btn-zoom-reset")?.addEventListener("click", () => this.map.resetView());
    document.getElementById("btn-focus-aubrey")?.addEventListener("click", () => {
      this.map.focusWorld(260, 120, 1.45);
      this.map.sel = { kind: "bus", idx: 21 };
      this.renderInspector();
    });
  }

  private bindDrawer() {
    const drawer = document.getElementById("reference-drawer");
    document.getElementById("btn-open-reference")?.addEventListener("click", () => {
      if (drawer) {
        drawer.hidden = !drawer.hidden;
        if (!drawer.hidden) this.renderReferenceDrawer();
      }
    });
    document.getElementById("btn-close-reference")?.addEventListener("click", () => {
      if (drawer) drawer.hidden = true;
    });
  }

  renderTopBar() {
    const st = this.sim.stats;
    const setTxt = (id: string, val: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setTxt("kpi-clock", `T+${fmtClock(this.sim.t)}`);
    const mwRounded = Math.round(st.servedMW);
    const pct = ((st.servedMW / st.totalMW) * 100).toFixed(1);
    setTxt("kpi-load", `${mwRounded.toLocaleString()} / 1,682 MW (${pct}%)`);
    const loadFill = document.getElementById("kpi-load-fill");
    if (loadFill) loadFill.style.width = `${Math.min(100, (st.servedMW / st.totalMW) * 100)}%`;

    setTxt("kpi-buses", `${st.energizedBuses}/24 Buses · ${st.blocksOn}/85 Blocks`);

    // Frequency readout
    const fVal =
      this.sim.islands.length === 0
        ? "0.00 Hz (DEAD)"
        : this.sim.islands.length === 1
        ? `${this.sim.islands[0].f.toFixed(2)} Hz`
        : `${Math.min(...this.sim.islands.map((i) => i.f)).toFixed(2)}–${Math.max(...this.sim.islands.map((i) => i.f)).toFixed(2)} Hz`;
    const fEl = document.getElementById("kpi-freq");
    if (fEl) {
      fEl.textContent = fVal;
      const fBad = this.sim.islands.length === 0 || this.sim.islands.some((i) => i.f < BANDS.fLow || i.f > BANDS.fHigh);
      fEl.className = `kpi-value mono ${this.sim.islands.length === 0 ? "danger" : fBad ? "warn" : "nominal"}`;
    }

    // Peak Bus Voltage readout
    const vPeak = this.ferrantiTripped ? 1.211 : st.energizedBuses > 0 ? st.vMax : 0;
    const vEl = document.getElementById("kpi-vmax");
    if (vEl) {
      vEl.textContent =
        this.ferrantiTripped
          ? "1.211 pu TRIP!"
          : st.energizedBuses > 0
          ? `${st.vMax.toFixed(3)} pu`
          : "0.000 pu";
      vEl.className = `kpi-value mono ${
        vPeak >= 1.15 ? "danger" : vPeak > 1.05 || (st.vMin > 0 && st.vMin < 0.95) ? "warn" : "nominal"
      }`;
    }

    // Speed buttons active state
    document.querySelectorAll<HTMLElement>("[data-speed]").forEach((btn) => {
      const s = Number(btn.dataset.speed);
      btn.classList.toggle("active", (s === 0 && this.paused) || (!this.paused && s === this.speed));
    });
  }

  renderWorkflowStrip() {
    const container = document.getElementById("workflow-strip");
    if (!container) return;

    const sig = `${this.mode}|${this.ferrantiStep}|${this.ferrantiTripped}|${this.ferrantiAutoTimer !== null}|${this.guideIndex}|${this.guideAuto}|${this.sim.stats.won}|${this.contingencyDamaged}|${this.replayCursor}`;
    if (sig === this.lastWorkflowSig) return;
    this.lastWorkflowSig = sig;

    if (this.mode === "ferranti") {
      const stepLabels = [
        { s: 0, title: "0 · 3 Hydro Units", sub: "0.980 pu · AVR OK" },
        { s: 1, title: "1 · Close Line 21–22", sub: "+14 Mvar → 0.980 pu" },
        { s: 2, title: "2 · Close Line 17–22", sub: "+22 Mvar → 1.080 pu Qmin!" },
        { s: 3, title: "3 · Close Line 16–17", sub: "+6 Mvar → 1.211 pu TRIP!" },
        { s: 4, title: "4 · 6-Unit Recovery", sub: "−60 Mvar → 0.980 pu Stable" },
      ];

      const nextBtnLabel =
        this.ferrantiStep === 0
          ? "Close Line 1 (21–22) → 0.980 pu"
          : this.ferrantiStep === 1
          ? "Close Line 2 (17–22) → 1.080 pu (Qmin Saturated!)"
          : this.ferrantiStep === 2
          ? "Close Line 3 (16–17) → Trigger 1.211 pu PRC-024 Collapse!"
          : this.ferrantiStep === 3
          ? "Recover: Start All 6 Hydro Units (−60 Mvar) → 0.980 pu"
          : "Launch Full 160-Action Grid Restoration (1,682 MW) →";

      container.innerHTML = `
        <div class="wf-row">
          <div class="wf-Steps">
            ${stepLabels
              .map(
                (item) => `
              <button class="wf-step-pill ${this.ferrantiStep === item.s ? "active" : ""} ${
                  item.s === 3 && this.ferrantiStep === 3 ? "danger" : item.s === 2 && this.ferrantiStep === 2 ? "warn" : ""
                }" data-ferranti-stage="${item.s}">
                <span class="wf-pill-title">${item.title}</span>
                <span class="wf-pill-sub">${item.sub}</span>
              </button>
            `
              )
              .join("")}
          </div>
          <div class="wf-actions">
            <button class="btn-primary ${this.ferrantiStep === 2 ? "btn-danger-pulse" : ""}" id="btn-ferranti-next">
              ${nextBtnLabel}
            </button>
            <button class="btn-secondary ${this.ferrantiAutoTimer !== null ? "active" : ""}" id="btn-ferranti-auto">
              ${this.ferrantiAutoTimer !== null ? "⏸ Stop Auto-Demo" : "▶ Auto-Play Trap"}
            </button>
          </div>
        </div>
      `;

      container.querySelectorAll<HTMLElement>("[data-ferranti-stage]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.loadFerrantiStage(Number(btn.dataset.ferrantiStage), true);
        });
      });

      document.getElementById("btn-ferranti-next")?.addEventListener("click", () => {
        if (this.ferrantiStep === 4) {
          this.setMode("guided");
          this.speed = 300;
          this.paused = false;
          this.guideAuto = true;
          this.renderTopBar();
          this.renderWorkflowStrip();
        } else {
          this.stepFerrantiDemo();
        }
      });

      document.getElementById("btn-ferranti-auto")?.addEventListener("click", () => {
        this.toggleFerrantiAutoPlay();
      });
      return;
    }

    if (this.mode === "guided") {
      const step = this.plan[this.guideIndex];
      const totalSteps = this.plan.length;
      const actDone = Math.min(this.refActions.length, this.sim.actions.length);
      const headline = this.sim.stats.won
        ? `RESTORATION COMPLETE — 1,682 / 1,682 MW Restored (${this.refActions.length} / ${this.refActions.length} Actions · 60.00 Hz)`
        : step
        ? `Action ${actDone} / ${this.refActions.length} (Checklist ${this.guideIndex + 1}/${totalSteps}): ${step.text}`
        : "Guided Sequence Finished";
      const why = this.sim.stats.won
        ? "All 85 bulk load blocks (120 substation feeder bays) energized with voltages inside 0.971–1.035 pu and zero thermal overloads."
        : step?.why ?? "";

      container.innerHTML = `
        <div class="wf-row wf-guided-layout">
          <div class="wf-guide-info">
            <div class="wf-guide-headline">${headline}</div>
            <div class="wf-guide-why">${why}</div>
          </div>
          <div class="wf-milestones">
            <span class="wf-milestone-label">Jump to Stage:</span>
            <button class="wf-ms-btn" data-ms="blackout">0 · Blackout</button>
            <button class="wf-ms-btn" data-ms="north-spine">1 · North 230kV Spine</button>
            <button class="wf-ms-btn" data-ms="multi-island">2 · Multi-Island Sync</button>
            <button class="wf-ms-btn" data-ms="cable-reactor">3 · 6–10 Cable & Reactor</button>
            <button class="wf-ms-btn" data-ms="full-1682">4 · Full 1,682 MW (${this.refActions.length} Actions)</button>
          </div>
          <div class="wf-actions">
            ${
              !this.sim.stats.won && step
                ? `<button class="btn-primary" id="btn-guide-step">${
                    step.kind === "act" ? "Execute Step" : "Fast-Forward Wait"
                  }</button>`
                : ""
            }
            <button class="btn-secondary ${this.guideAuto ? "active" : ""}" id="btn-guide-auto">
              ${this.guideAuto ? "⏸ Pause Auto-Dispatch" : "▶ Auto-Dispatch (300×)"}
            </button>
          </div>
        </div>
      `;

      document.getElementById("btn-guide-step")?.addEventListener("click", () => this.executeCurrentGuideStep());
      document.getElementById("btn-guide-auto")?.addEventListener("click", () => {
        this.guideAuto = !this.guideAuto;
        if (this.guideAuto && this.speed < 60) {
          this.speed = 300;
          this.paused = false;
        }
        this.renderTopBar();
        this.renderWorkflowStrip();
      });
      container.querySelectorAll<HTMLElement>("[data-ms]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const ms = btn.dataset.ms as
            | "blackout"
            | "hydro-ready"
            | "north-spine"
            | "multi-island"
            | "cable-reactor"
            | "full-1682";
          if (ms) this.loadRestorationMilestone(ms);
        });
      });
      return;
    }

    // Mode 3: Operator Sandbox, N-1 Contingency & 163-Action Timelapse Scrubber
    container.innerHTML = `
      <div class="wf-row">
        <div class="wf-sandbox-controls">
          <span class="wf-milestone-label">Operator Sandbox & Replay:</span>
          <button class="wf-ms-btn ${this.contingencyDamaged ? "active" : ""}" id="btn-toggle-contingency">
            ⚡ N−1 Contingency: Line 17–22 ${this.contingencyDamaged ? "DAMAGED (Locked Out)" : "Healthy"}
          </button>
          <button class="wf-ms-btn" id="btn-sandbox-reset">Reset to Cold Blackout</button>
          <button class="wf-ms-btn" id="btn-sandbox-full">Load Restored 1,682 MW Grid</button>
        </div>
        <div class="wf-scrubber">
          <label for="replay-slider">${this.refActions.length}-Action Reference Scrubber (${this.replayCursor} / ${this.refActions.length}):</label>
          <input type="range" id="replay-slider" min="0" max="${this.refActions.length}" value="${this.replayCursor}" />
        </div>
      </div>
    `;

    document.getElementById("btn-toggle-contingency")?.addEventListener("click", () => {
      this.contingencyDamaged = !this.contingencyDamaged;
      this.loadRestorationMilestone("blackout");
    });
    document.getElementById("btn-sandbox-reset")?.addEventListener("click", () => {
      this.replayCursor = 0;
      this.loadRestorationMilestone("blackout");
    });
    document.getElementById("btn-sandbox-full")?.addEventListener("click", () => {
      this.replayCursor = this.refActions.length;
      this.loadRestorationMilestone("full-1682");
    });
    const slider = document.getElementById("replay-slider") as HTMLInputElement | null;
    slider?.addEventListener("input", () => {
      this.replayMode = true;
      this.replayCursor = Number(slider.value);
      const slice = this.refActions.slice(0, this.replayCursor);
      this.sim = replay(this.sc, slice, { tailSteps: this.replayCursor === this.refActions.length ? 300 : 12 });
      this.map.setSim(this.sim);
      this.renderTopBar();
      this.renderInspector();
      this.renderTelemetryCanvases();
      this.renderEventLog();
      this.renderWorkflowStrip();
    });
  }

  renderInspector() {
    const el = document.getElementById("inspector-content");
    if (!el) return;

    const sel = this.map.sel ?? { kind: "bus", idx: 21 };
    if (sel.kind === "branch") {
      this.renderBranchInspector(el, sel.idx);
    } else {
      this.renderBusInspector(el, sel.idx);
    }
  }

  private renderBusInspector(el: HTMLElement, busIdx: number) {
    const b = this.sc.buses[busIdx];
    const st = this.sim.buses[busIdx];
    const isl = this.sim.islands.find((i) => i.id === st.island);
    const units = this.sc.units.filter((u) => u.bus === busIdx);
    const connectedBranches = this.sc.branches.filter((br) => br.f === busIdx || br.t === busIdx);
    const reactor = this.sc.reactors.find((r) => r.bus === busIdx);

    const vDisplay = this.ferrantiTripped && busIdx === 21 ? "1.211 pu (TRIPPED)" : st.energized ? `${st.Vm.toFixed(3)} pu` : "0.000 pu (DEAD)";
    const kvDisplay = st.energized ? `${(st.Vm * b.kv).toFixed(1)} kV` : `0.0 / ${b.kv} kV`;
    const angDisplay = st.energized ? `${((st.Va * 180) / Math.PI).toFixed(1)}°` : "—";
    const freqDisplay = isl ? `${isl.f.toFixed(3)} Hz` : "—";

    // Plant AVR & Qmin status
    let plantControlsHtml = "";
    if (units.length > 0 && units.some((u) => u.available)) {
      const startable = units.filter(
        (u) => u.available && (this.sim.units[u.idx].status === "off" || this.sim.units[u.idx].status === "tripped")
      );
      const qLimBadge =
        st.qLimit === -1
          ? `<span class="badge danger">Q_MIN SATURATED (FIXED EMF BEHIND Xd)</span>`
          : st.qLimit === 1
          ? `<span class="badge warn">Q_MAX CEILING</span>`
          : `<span class="badge nominal">AVR REGULATING</span>`;

      plantControlsHtml = `
        <div class="insp-section">
          <div class="insp-sec-header">
            <span>AVR Excitation & Plant Control</span>
            ${st.energized ? qLimBadge : ""}
          </div>
          <div class="avr-preset-row">
            <span class="avr-label">V_set: <b>${st.vset.toFixed(3)} pu</b></span>
            <div class="avr-btns">
              ${[0.98, 1.0, 1.02, 1.05]
                .map(
                  (v) =>
                    `<button class="btn-mini ${Math.abs(st.vset - v) < 0.004 ? "active" : ""}" data-avr-preset="${v}">${v.toFixed(
                      2
                    )} pu</button>`
                )
                .join("")}
            </div>
          </div>
          ${
            startable.length > 1
              ? `<button class="btn-primary btn-full" id="btn-start-all-units">Start All ${startable.length} Available Units at ${b.id} ${b.name}</button>`
              : ""
          }
        </div>
      `;
    }

    // Units list
    const unitsHtml =
      units.length > 0
        ? `
        <div class="insp-section">
          <div class="insp-sec-header">
            <span>Generating Units (${units.filter((u) => this.sim.units[u.idx].status === "online").length}/${units.length} Online)</span>
          </div>
          <div class="unit-list">
            ${units
              .map((u) => {
                const us = this.sim.units[u.idx];
                const isSyn = u.kind === "syncon";
                const statusBadge = !u.available
                  ? `<span class="badge muted">UNAVAILABLE (NUCLEAR)</span>`
                  : us.status === "online"
                  ? `<span class="badge nominal">ONLINE</span>`
                  : us.status === "starting"
                  ? `<span class="badge warn">SYNC IN ${Math.max(0, Math.ceil(us.syncAt - this.sim.t))}s</span>`
                  : us.status === "tripped"
                  ? `<span class="badge danger">TRIPPED (PRC-024)</span>`
                  : `<span class="badge muted">${u.blackStart ? "BLACK-START READY" : "OFFLINE"}</span>`;

                const actionBtn =
                  u.available && (us.status === "off" || us.status === "tripped")
                    ? `<button class="btn-mini primary" data-unit-start="${u.idx}">Start</button>`
                    : us.status === "online" || us.status === "starting"
                    ? `<button class="btn-mini" data-unit-stop="${u.idx}">Stop</button>`
                    : "";

                return `
                  <div class="unit-card ${us.status}">
                    <div class="unit-card-top">
                      <div>
                        <b>${u.code}${isSyn ? "" : ` #${u.num}`}</b>
                        <span class="unit-fuel">${u.fuel} · ${isSyn ? "+200/−50 Mvar" : `${u.pmax} MW (Q: ${u.qmin}..+${u.qmax} Mvar)`}</span>
                      </div>
                      <div class="unit-card-actions">
                        ${statusBadge}
                        ${actionBtn}
                      </div>
                    </div>
                    ${
                      us.status === "online"
                        ? `<div class="unit-telemetry-row">
                            <span>P: <b>${us.P.toFixed(1)} MW</b></span>
                            <span>Q: <b class="${us.Q <= u.qmin + 0.5 ? "warn-txt" : ""}">${us.Q >= 0 ? "+" : ""}${us.Q.toFixed(1)} Mvar</b></span>
                            <span>Xd: <b>${u.xd} pu</b></span>
                          </div>`
                        : us.tripReason
                        ? `<div class="unit-trip-reason">${us.tripReason}</div>`
                        : ""
                    }
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `
        : "";

    // Reactor control at 6 Alber
    const reactorHtml = reactor
      ? `
        <div class="insp-section">
          <div class="insp-sec-header">
            <span>Shunt Inductive Reactor (−${reactor.mvar} Mvar)</span>
            <span class="badge ${st.reactorOn ? "nominal" : "muted"}">${st.reactorOn ? "IN SERVICE" : "OPEN"}</span>
          </div>
          <p class="insp-note">Absorbs 100 Mvar of capacitive charging so the 246 Mvar 6–10 underground cable can be energized safely.</p>
          <button class="btn-secondary btn-full" id="btn-toggle-reactor">
            ${st.reactorOn ? "Open 100 Mvar Shunt Reactor" : "Close 100 Mvar Shunt Reactor (−100 Mvar)"}
          </button>
        </div>
      `
      : "";

    // Cold-load pickup feeders
    const blocks = this.sim.blocks[busIdx];
    const feedersHtml =
      blocks.length > 0
        ? `
        <div class="insp-section">
          <div class="insp-sec-header">
            <span>Cold-Load Pickup Feeders (${st.blocks}/5 Blocks · ${st.Pd.toFixed(1)} / ${b.pd.toFixed(1)} MW)</span>
          </div>
          <div class="feeder-btn-row">
            <button class="btn-primary" id="btn-pickup-feeder" ${
              !st.energized || st.blocks >= 5 ? "disabled" : ""
            }>+ Energize Feeder ${Math.min(5, st.blocks + 1)} (${
            st.blocks < 5 ? `+${blocks[st.blocks].mw.toFixed(1)} MW` : "Full"
          })</button>
            <button class="btn-secondary" id="btn-drop-feeder" ${st.blocks <= 0 ? "disabled" : ""}>− Shed Feeder</button>
          </div>
        </div>
      `
        : "";

    // Connected transmission lines
    const branchesHtml = `
      <div class="insp-section">
        <div class="insp-sec-header">
          <span>Connected Transmission Breakers (${connectedBranches.length})</span>
        </div>
        <div class="branch-list">
          ${connectedBranches
            .map((br) => {
              const bst = this.sim.branches[br.idx];
              const otherIdx = br.f === busIdx ? br.t : br.f;
              const otherBus = this.sc.buses[otherIdx];
              const chargingMvar = (br.b * this.sc.baseMVA).toFixed(1);
              return `
                <div class="branch-row ${bst.energized ? "live" : ""}">
                  <div class="branch-row-info" data-select-branch="${br.idx}">
                    <b>${br.kind === "transformer" ? "Xfmr" : "Line"} ${this.sc.buses[br.f].id}–${this.sc.buses[br.t].id}${
                br.circuits > 1 ? ` #${br.circuit}` : ""
              }</b>
                    <span>→ ${otherBus.id} ${otherBus.name} · +${chargingMvar} Mvar Qc · ${
                bst.energized ? `${Math.abs(bst.Pf).toFixed(0)} MW (${(bst.loading * 100).toFixed(0)}%)` : "0 MW"
              }</span>
                  </div>
                  <button class="btn-mini ${bst.closed ? " nominal" : "primary"}" data-toggle-branch="${br.idx}" ${
                bst.damaged ? "disabled" : ""
              }>
                    ${bst.damaged ? "Damaged" : bst.closed ? "Open" : "Close"}
                  </button>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;

    el.innerHTML = `
      <div class="insp-header">
        <div>
          <div class="insp-eyebrow">SUBSTATION ${b.id} OF 24 · ${b.kv} kV BUS</div>
          <h2 class="insp-title">${b.id} ${b.name}</h2>
        </div>
        <span class="badge ${st.energized ? (st.Vm > 1.05 ? "warn" : "nominal") : "danger"}">
          ${st.energized ? `ISLAND ${st.island}` : "DE-ENERGIZED"}
        </span>
      </div>

      <div class="insp-kv-grid">
        <div class="insp-kv-cell">
          <span>Bus Voltage</span>
          <b class="${st.Vm >= 1.15 || (this.ferrantiTripped && busIdx === 21) ? "danger-txt" : st.Vm > 1.05 ? "warn-txt" : "nominal-txt"}">${vDisplay}</b>
        </div>
        <div class="insp-kv-cell">
          <span>kV Magnitude</span>
          <b>${kvDisplay}</b>
        </div>
        <div class="insp-kv-cell">
          <span>Rotor / Bus Angle δ</span>
          <b>${angDisplay}</b>
        </div>
        <div class="insp-kv-cell">
          <span>Island Frequency</span>
          <b>${freqDisplay}</b>
        </div>
      </div>

      ${plantControlsHtml}
      ${unitsHtml}
      ${reactorHtml}
      ${feedersHtml}
      ${branchesHtml}
    `;

    // Bind inspector interactions
    el.querySelectorAll<HTMLElement>("[data-avr-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.applyOperatorCommand({ type: "avr", bus: busIdx, vg: Number(btn.dataset.avrPreset) });
      });
    });

    document.getElementById("btn-start-all-units")?.addEventListener("click", () => {
      units.forEach((u) => {
        const s = this.sim.units[u.idx].status;
        if (u.available && (s === "off" || s === "tripped")) {
          this.sim.apply({ type: "start", unit: u.idx });
        }
      });
      this.sound.playUnitSync();
      this.renderInspector();
      this.renderEventLog();
    });

    el.querySelectorAll<HTMLElement>("[data-unit-start]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.applyOperatorCommand({ type: "start", unit: Number(btn.dataset.unitStart) });
      });
    });

    el.querySelectorAll<HTMLElement>("[data-unit-stop]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.applyOperatorCommand({ type: "stop", unit: Number(btn.dataset.unitStop) });
      });
    });

    document.getElementById("btn-toggle-reactor")?.addEventListener("click", () => {
      this.applyOperatorCommand({ type: "reactor", bus: busIdx, on: !st.reactorOn });
    });

    document.getElementById("btn-pickup-feeder")?.addEventListener("click", () => {
      this.applyOperatorCommand({ type: "pickup", bus: busIdx });
    });

    document.getElementById("btn-drop-feeder")?.addEventListener("click", () => {
      this.applyOperatorCommand({ type: "drop", bus: busIdx });
    });

    el.querySelectorAll<HTMLElement>("[data-toggle-branch]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = Number(btn.dataset.toggleBranch);
        const closed = this.sim.branches[k].closed;
        this.applyOperatorCommand({ type: closed ? "open" : "close", branch: k });
      });
    });

    el.querySelectorAll<HTMLElement>("[data-select-branch]").forEach((row) => {
      row.addEventListener("click", () => {
        this.map.sel = { kind: "branch", idx: Number(row.dataset.selectBranch) };
        this.renderInspector();
      });
    });
  }

  private renderBranchInspector(el: HTMLElement, brIdx: number) {
    const br = this.sc.branches[brIdx];
    const st = this.sim.branches[brIdx];
    const bf = this.sc.buses[br.f];
    const bt = this.sc.buses[br.t];
    const sf = this.sim.buses[br.f];
    const stTo = this.sim.buses[br.t];
    const chargingMvar = br.b * this.sc.baseMVA;
    const dAngle = sf.energized && stTo.energized ? (((sf.Va - stTo.Va) * 180) / Math.PI).toFixed(1) : "—";

    el.innerHTML = `
      <div class="insp-header">
        <div>
          <div class="insp-eyebrow">${br.kind.toUpperCase()} CORRIDOR · ${bf.kv}/${bt.kv} kV</div>
          <h2 class="insp-title">${bf.id} ${bf.name} ↔ ${bt.id} ${bt.name}</h2>
        </div>
        <span class="badge ${st.damaged ? "danger" : st.closed ? "nominal" : "muted"}">
          ${st.damaged ? "DAMAGED" : st.closed ? "CLOSED" : "OPEN"}
        </span>
      </div>

      <div class="insp-kv-grid">
        <div class="insp-kv-cell">
          <span>Active Flow P</span>
          <b>${st.energized ? `${st.Pf.toFixed(1)} MW` : "0.0 MW"}</b>
        </div>
        <div class="insp-kv-cell">
          <span>Reactive Flow Q</span>
          <b>${st.energized ? `${st.Qf.toFixed(1)} Mvar` : "0.0 Mvar"}</b>
        </div>
        <div class="insp-kv-cell">
          <span>Line Charging B_c</span>
          <b class="warn-txt">+${chargingMvar.toFixed(1)} Mvar</b>
        </div>
        <div class="insp-kv-cell">
          <span>Thermal Loading</span>
          <b>${st.energized ? `${st.Smax.toFixed(0)} / ${br.con} MVA (${(st.loading * 100).toFixed(0)}%)` : `0 / ${br.con} MVA`}</b>
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-sec-header">
          <span>π-Equivalent Line Parameters (100 MVA Base)</span>
        </div>
        <div class="unit-telemetry-row">
          <span>R = <b>${br.r} pu</b></span>
          <span>X = <b>${br.x} pu</b></span>
          <span>B = <b>${br.b} pu</b></span>
          <span>Δδ = <b>${dAngle}°</b></span>
        </div>
        <button class="btn-primary btn-full" id="btn-branch-main-toggle" ${st.damaged ? "disabled" : ""}>
          ${st.damaged ? "Locked Out (Field Crew Repair Needed)" : st.closed ? "Open Circuit Breaker" : "Close Circuit Breaker"}
        </button>
        <button class="btn-secondary btn-full" id="btn-branch-back-bus" style="margin-top:6px;">
          Inspect ${bf.id} ${bf.name} Substation
        </button>
      </div>
    `;

    document.getElementById("btn-branch-main-toggle")?.addEventListener("click", () => {
      this.applyOperatorCommand({ type: st.closed ? "open" : "close", branch: brIdx });
    });
    document.getElementById("btn-branch-back-bus")?.addEventListener("click", () => {
      this.map.sel = { kind: "bus", idx: br.f };
      this.renderInspector();
    });
  }

  renderTelemetryCanvases() {
    const cV = document.getElementById("chart-voltage") as HTMLCanvasElement | null;
    const cQV = document.getElementById("chart-qv") as HTMLCanvasElement | null;
    const cPF = document.getElementById("chart-phasor-freq") as HTMLCanvasElement | null;

    const selBus = this.map.sel?.kind === "bus" ? this.map.sel.idx : null;
    const peakTrip = this.ferrantiTripped ? 1.2113 : 0;

    if (cV) drawVoltageProfile(cV, this.sim, selBus, peakTrip);
    if (cQV) drawQvFerrantiCurve(cQV, this.sim, peakTrip);
    if (cPF) drawPhasorAndFrequency(cPF, this.sim);
  }

  renderEventLog() {
    const el = document.getElementById("soe-log-list");
    if (!el) return;
    const recent = this.sim.log.slice(-2).reverse();
    el.innerHTML = recent
      .map(
        (ev) => `
        <div class="soe-item ${ev.level}">
          <span class="soe-time">[${fmtClock(ev.t)}]</span>
          <span class="soe-lvl">${ev.level.toUpperCase()}</span>
          <span class="soe-txt">${ev.text}</span>
        </div>
      `
      )
      .join("");
  }

  private renderReferenceDrawer() {
    const body = document.getElementById("reference-drawer-body");
    if (!body) return;
    const rep = verifiedTelemetry.report;
    body.innerHTML = `
      <div class="ref-grid">
        <div class="ref-card">
          <h3>1. AC Power-Flow & Ferranti Physics Engine</h3>
          <p>Every switching action solves the full complex nodal admittance matrix <code>Y = G + jB</code> across all 24 substations and 38 transmission branches using polar Newton–Raphson iteration with analytical Jacobians:</p>
          <pre class="ref-math">P_i = V_i ∑ V_k (G_ik cos θ_ik + B_ik sin θ_ik)
Q_i = V_i ∑ V_k (G_ik sin θ_ik − B_ik cos θ_ik)</pre>
          <p>When a generator bus reaches its under-excitation reactive limit (<code>Q_min = −30 Mvar</code> for 3 hydro units at 22 Aubrey), its automatic voltage regulator (AVR) saturates and holds a fixed internal EMF <code>E_q</code> behind synchronous reactance <code>X_d = 1.8 pu</code>: <code>Q_gen = (E_q V − V²) / X_d</code>. Closing the 3rd unloaded 230 kV line (<code>16–17</code>) drives 22 Aubrey to <b>1.211 pu (+21.1% overvoltage)</b>, tripping NERC PRC-024 instantaneous over-voltage protection (<code>≥ 1.200 pu</code>).</p>
        </div>
        <div class="ref-card">
          <h3>2. SciPy / PYPOWER / pandapower Verification</h3>
          <p>Verified in Python using <code>scipy.optimize.root(method="hybr")</code> and cross-checked against PYPOWER 5.1.21 and pandapower 3.5.6 across 13 benchmark cases:</p>
          <ul>
            <li>Max Bus Voltage Magnitude Deviation vs PYPOWER: <code>${rep.base_case_verification.max_dvm_vs_pypower_pu.toExponential(2)} pu</code></li>
            <li>Max Bus Phase Angle Deviation vs PYPOWER: <code>${rep.base_case_verification.max_dva_vs_pypower_deg.toExponential(2)} deg</code></li>
            <li>Ferranti Trap Sequence (3 × 50 MW Hydro @ 0.980 pu): <code>0.9800 pu → 0.9800 pu (Line 21–22) → 1.0800 pu (Line 17–22, Qmin Saturated) → 1.2113 pu (Line 16–17, PRC-024 Trip)</code></li>
            <li>Full Restoration Sequence: <code>163 switching actions · 1,681.5 / 1,681.5 MW (100%) · 24/24 Substations · 60.000 Hz</code></li>
          </ul>
        </div>
      </div>
    `;
  }
}
