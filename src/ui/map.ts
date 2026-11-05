import type { Simulation } from "../engine/sim";

export type Selection =
  | { kind: "bus"; idx: number }
  | { kind: "branch"; idx: number }
  | null;

export interface FerrantiBannerState {
  active: boolean;
  step: number; // 0=ready, 1=line1(0.980), 2=line2(1.080 Qmin), 3=line3(1.211 Trip!), 4=recovered(6 units)
  vAubrey: number;
  vAston: number;
  vAsser: number;
  qAubreyMvar: number;
  qLimitMvar: number;
  qSaturated: boolean;
  tripped: boolean;
  headline: string;
  detail: string;
}

const WORLD_W = 1040;
const WORLD_H = 620;

const C = {
  bgTop: "#050912",
  bgBot: "#091120",
  gridMinor: "rgba(56, 189, 248, 0.04)",
  gridMajor: "rgba(56, 189, 248, 0.085)",
  dead230: "rgba(100, 148, 196, 0.56)",
  dead138: "rgba(116, 134, 175, 0.48)",
  deadBusFill: "#0D1626",
  deadBusStroke: "#3B5278",
  nominal: "#14F0A0",
  nominalCyan: "#38BDF8",
  warn: "#FFB020",
  danger: "#FF3B5C",
  chargingViolet: "#C084FC",
  loadGold: "#FBBF24",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
};

function vColor(vm: number, energized: boolean): string {
  if (!energized) return C.deadBusStroke;
  if (vm >= 1.12 || vm < 0.88) return C.danger;
  if (vm > 1.05 || vm < 0.95) return C.warn;
  return C.nominal;
}

function loadColor(loading: number): string {
  if (loading >= 1.0) return C.danger;
  if (loading >= 0.8) return C.warn;
  return C.nominalCyan;
}

const GEN_OFFSETS: Record<number, [number, number]> = {
  0: [-52, 28],
  1: [52, 28],
  6: [-52, 24],
  12: [56, 6],
  13: [0, -48],
  14: [-56, -20],
  15: [0, -48],
  17: [-54, -18],
  20: [0, -48],
  21: [56, 2],
  22: [58, -10],
};

// Key corridors whose capacitive charging Mvar should be called out directly on the map
const KEY_CHARGING_BRANCHES: Record<string, string> = {
  "20-21": "47 mi · +14 Mvar",
  "16-21": "73 mi · +22 Mvar",
  "15-16": "18 mi · +6 Mvar",
  "5-9": "Cable · +246 Mvar",
  "0-1": "Cable · +46 Mvar",
};

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  sim: Simulation;
  sel: Selection = { kind: "bus", idx: 21 }; // Default focus on 22 Aubrey Black-Start Hydro
  hover: Selection = null;
  highlight: Selection = null;
  ferrantiBanner: FerrantiBannerState | null = null;
  onSelect: (s: Selection) => void = () => {};
  onQuickAction: (s: Selection) => void = () => {};

  private scale = 1;
  private ox = 0;
  private oy = 0;
  private userZoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragMoved = false;
  private dragStart = { x: 0, y: 0, panX: 0, panY: 0 };

  private branchPaths: {
    mx: number;
    my: number;
    pts: [number, number][];
  }[] = [];

  private lastTripShockwave = -1e9;
  private lastTrippedValue = 0;

  constructor(canvas: HTMLCanvasElement, sim: Simulation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.sim = sim;
    this.computePaths();
    this.bindEvents();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  setSim(sim: Simulation) {
    this.sim = sim;
  }

  triggerTripShockwave(peakPu = 1.211) {
    this.lastTripShockwave = performance.now();
    this.lastTrippedValue = peakPu;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    const isMobile = r.width < 640;
    const padX = isMobile ? 12 : 46;
    const padY = isMobile ? 16 : 42;
    const sx = (r.width - padX * 2) / WORLD_W;
    const sy = (r.height - padY * 2) / WORLD_H;
    const effZoom = isMobile && this.userZoom === 1 ? 1.75 : this.userZoom;
    this.scale = Math.min(sx, sy) * effZoom;
    if (isMobile && this.userZoom === 1 && this.panX === 0 && this.panY === 0) {
      // On narrow mobile viewports, frame the active selection / northern 230 kV spine cleanly so labels never crowd
      const focusBus = this.sel?.kind === "bus" ? this.sim.sc.buses[this.sel.idx] : this.sim.sc.buses[21];
      const baseOx = (r.width - WORLD_W * this.scale) / 2;
      const baseOy = (r.height - WORLD_H * this.scale) / 2 + 6;
      this.ox = baseOx + (r.width * 0.5 - (baseOx + focusBus.x * this.scale));
      this.oy = baseOy + (r.height * 0.48 - (baseOy + focusBus.y * this.scale));
    } else {
      this.ox = (r.width - WORLD_W * this.scale) / 2 + this.panX;
      this.oy = (r.height - WORLD_H * this.scale) / 2 + this.panY + 6;
    }
  }

  resetView() {
    this.userZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.resize();
  }

  zoomBy(factor: number) {
    this.userZoom = Math.max(0.75, Math.min(3.0, this.userZoom * factor));
    this.resize();
  }

  /** Smoothly center camera on a world point at a given zoom level (used for guided focus or reset) */
  focusWorld(wx: number, wy: number, zoom = 1.0) {
    const r = this.canvas.getBoundingClientRect();
    this.userZoom = Math.max(0.75, Math.min(3.0, zoom));
    const padX = 46;
    const padY = 42;
    const baseScale = Math.min((r.width - padX * 2) / WORLD_W, (r.height - padY * 2) / WORLD_H);
    const s = baseScale * this.userZoom;
    const baseOx = (r.width - WORLD_W * s) / 2;
    const baseOy = (r.height - WORLD_H * s) / 2 + 6;
    if (zoom <= 1.02) {
      this.panX = 0;
      this.panY = 0;
    } else {
      this.panX = r.width / 2 - (baseOx + wx * s);
      this.panY = r.height / 2 - (baseOy + wy * s);
    }
    this.resize();
  }

  private toScreen(x: number, y: number): [number, number] {
    return [this.ox + x * this.scale, this.oy + y * this.scale];
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (sy - this.oy) / this.scale];
  }

  private computePaths() {
    const buses = this.sim.sc.buses;
    this.branchPaths = this.sim.sc.branches.map((br) => {
      const a = buses[br.f];
      const b = buses[br.t];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L;
      const ny = dx / L;
      const offset = br.circuits === 2 ? (br.circuit === 1 ? -11 : 11) : 0;
      const mx = (a.x + b.x) / 2 + nx * offset;
      const my = (a.y + b.y) / 2 + ny * offset;
      const pts: [number, number][] =
        offset === 0
          ? [
              [a.x, a.y],
              [b.x, b.y],
            ]
          : [
              [a.x, a.y],
              [mx, my],
              [b.x, b.y],
            ];
      return { mx, my, pts };
    });
  }

  private bindEvents() {
    this.canvas.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
    });

    window.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (this.dragging) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        if (Math.hypot(dx, dy) > 4) this.dragMoved = true;
        if (this.dragMoved) {
          this.panX = this.dragStart.panX + dx;
          this.panY = this.dragStart.panY + dy;
          this.resize();
          return;
        }
      }
      if (sx >= 0 && sy >= 0 && sx <= r.width && sy <= r.height) {
        const [wx, wy] = this.toWorld(sx, sy);
        this.hover = this.hitTest(wx, wy);
        this.canvas.style.cursor = this.hover ? "pointer" : this.dragging ? "grabbing" : "grab";
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (!this.dragging) return;
      const moved = this.dragMoved;
      this.dragging = false;
      if (moved) return;
      const r = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const hit = this.hitTest(wx, wy);
      if (hit) {
        this.sel = hit;
        this.onSelect(hit);
      }
    });

    this.canvas.addEventListener("dblclick", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const hit = this.hitTest(wx, wy);
      if (hit) this.onQuickAction(hit);
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const [wx, wy] = this.toWorld(sx, sy);
        const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
        this.userZoom = Math.max(0.75, Math.min(3.0, this.userZoom * factor));
        this.resize();
        const [nsx, nsy] = this.toScreen(wx, wy);
        this.panX += sx - nsx;
        this.panY += sy - nsy;
        this.resize();
      },
      { passive: false }
    );
  }

  private hitTest(wx: number, wy: number): Selection {
    const buses = this.sim.sc.buses;
    for (let i = 0; i < buses.length; i++) {
      const b = buses[i];
      if (Math.abs(wx - b.x) <= 28 && Math.abs(wy - b.y) <= 16) {
        return { kind: "bus", idx: i };
      }
      const off = GEN_OFFSETS[i];
      if (off && Math.hypot(wx - (b.x + off[0]), wy - (b.y + off[1])) <= 18) {
        return { kind: "bus", idx: i };
      }
    }
    let bestBr = -1;
    let bestD = 16;
    for (let k = 0; k < this.branchPaths.length; k++) {
      const p = this.branchPaths[k];
      const d = Math.hypot(wx - p.mx, wy - p.my);
      if (d < bestD) {
        bestD = d;
        bestBr = k;
      }
    }
    if (bestBr >= 0) return { kind: "branch", idx: bestBr };
    for (let k = 0; k < this.branchPaths.length; k++) {
      const pts = this.branchPaths[k].pts;
      for (let s = 0; s < pts.length - 1; s++) {
        const d = distToSegment(wx, wy, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]);
        if (d < 9) return { kind: "branch", idx: k };
      }
    }
    return null;
  }

  draw(nowMs: number) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Deep Obsidian SCADA Control Room Backdrop
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, C.bgTop);
    bgGrad.addColorStop(1, C.bgBot);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Subtle Radial Spotlight around Northern 230 kV Hydro Spine
    const [aubSx, aubSy] = this.toScreen(242, 72);
    const radGlow = ctx.createRadialGradient(aubSx, aubSy, 10, aubSx, aubSy, 340 * this.scale);
    radGlow.addColorStop(0, "rgba(20, 240, 160, 0.06)");
    radGlow.addColorStop(0.5, "rgba(56, 189, 248, 0.03)");
    radGlow.addColorStop(1, "rgba(5, 9, 18, 0)");
    ctx.fillStyle = radGlow;
    ctx.fillRect(0, 0, W, H);

    // 2. Geospatial Coordinate Graticule & Topographical Contours
    this.drawGeospatialBackdrop(ctx, W, H);

    // 3. Voltage Zone Demarcation (230 kV North vs 138 kV South)
    this.drawZoneDivider(ctx);

    // 4. Transmission Branches, Breakers & Animated Active/Reactive Particle Streams
    this.drawBranches(ctx, nowMs);

    // 5. Substations, Voltage Halos, Generator Phase-Angle Turrets & Feeder Load Bars
    this.drawBuses(ctx, nowMs);

    // 6. PRC-024 Instantaneous Trip Shockwave (if recently triggered)
    this.drawTripShockwave(ctx, nowMs);

    // 7. On-Canvas Legend & Ferranti Over-Voltage Telemetry Banner
    this.drawCanvasHud(ctx, W, H, nowMs);

    ctx.restore();
  }

  private drawGeospatialBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const s = this.scale;
    // Coordinate grid
    ctx.strokeStyle = C.gridMinor;
    ctx.lineWidth = 1;
    const step = 60 * s;
    if (step >= 18) {
      for (let x = ((this.ox % step) + step) % step; x < W; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = ((this.oy % step) + step) % step; y < H; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    }

    // Northwest & Northeast Hydro Reservoir Contours around 22 Aubrey (pure geometric contour, no overlapping watermark text)
    ctx.save();
    const aub = this.sim.sc.buses[21];
    const [hx, hy] = this.toScreen(aub.x, aub.y);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
    ctx.fillStyle = "rgba(14, 116, 144, 0.04)";
    for (let rIdx = 1; rIdx <= 3; rIdx++) {
      ctx.beginPath();
      ctx.ellipse(hx, hy - 4 * s, (54 + rIdx * 28) * s, (26 + rIdx * 13) * s, -0.12, 0, Math.PI * 2);
      if (rIdx === 1) ctx.fill();
      ctx.stroke();
    }

    // Southern Urban Coastal Load Basin contour
    const [cx, cy] = this.toScreen(540, 595);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.07)";
    ctx.beginPath();
    ctx.moveTo(cx - 420 * s, cy);
    ctx.bezierCurveTo(cx - 180 * s, cy - 18 * s, cx + 180 * s, cy + 16 * s, cx + 430 * s, cy - 8 * s);
    ctx.stroke();
    ctx.restore();
  }

  private drawZoneDivider(ctx: CanvasRenderingContext2D) {
    const s = this.scale;
    const [x1, yZone] = this.toScreen(48, 304);
    const [x2] = this.toScreen(WORLD_W - 36, 304);

    ctx.save();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.22)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.moveTo(x1, yZone);
    ctx.lineTo(x2, yZone);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = `700 ${Math.max(8.5, 9.2 * s)}px "JetBrains Mono", monospace`;
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(56, 189, 248, 0.62)";
    ctx.fillText("▲ 230 kV NORTHERN TRANSMISSION SPINE", x1 + 6, yZone - 7);
    ctx.fillStyle = "rgba(165, 180, 252, 0.58)";
    ctx.fillText("▼ 138 kV SUB-TRANSMISSION & LOAD RING", x1 + 6, yZone + 13);
    ctx.restore();
  }

  private drawBranches(ctx: CanvasRenderingContext2D, nowMs: number) {
    const sc = this.sim.sc;
    const s = this.scale;

    for (let k = 0; k < sc.branches.length; k++) {
      const br = sc.branches[k];
      const st = this.sim.branches[k];
      const p = this.branchPaths[k];
      const pts = p.pts.map(([x, y]) => this.toScreen(x, y));
      const is230 = sc.buses[br.f].kv >= 200 && sc.buses[br.t].kv >= 200;
      const isSelected = this.sel?.kind === "branch" && this.sel.idx === k;
      const isHover = this.hover?.kind === "branch" && this.hover.idx === k;
      const isHint = this.highlight?.kind === "branch" && this.highlight.idx === k;

      // Determine line voltage state from connected buses
      const vf = this.sim.buses[br.f].Vm;
      const vt = this.sim.buses[br.t].Vm;
      const vMaxBranch = Math.max(vf, vt);
      const isOvervolt = st.energized && vMaxBranch > 1.05;
      const isSevereOvervolt = st.energized && vMaxBranch >= 1.15;

      // Outer luminous glow for energized or highlighted branches
      if (st.energized || isSelected || isHint) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        if (isHint && !st.energized) {
          ctx.strokeStyle = "rgba(255, 176, 32, 0.38)";
        } else if (isSevereOvervolt) {
          ctx.strokeStyle = "rgba(255, 59, 92, 0.55)";
        } else if (isOvervolt) {
          ctx.strokeStyle = "rgba(255, 176, 32, 0.45)";
        } else if (st.energized) {
          ctx.strokeStyle = is230 ? "rgba(20, 240, 160, 0.28)" : "rgba(56, 189, 248, 0.26)";
        } else {
          ctx.strokeStyle = "rgba(56, 189, 248, 0.30)";
        }
        ctx.lineWidth = (st.energized ? 9 : 7) * s;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
      }

      // Main transmission conductor line
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);

      if (st.damaged) {
        ctx.strokeStyle = "rgba(255, 59, 92, 0.65)";
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2.2 * s;
      } else if (st.tripped && !st.closed) {
        ctx.strokeStyle = C.danger;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2.6 * s;
      } else if (!st.closed) {
        ctx.strokeStyle = isHint ? C.warn : is230 ? C.dead230 : C.dead138;
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = (isHint ? 2.6 : is230 ? 2.0 : 1.65) * s;
      } else if (!st.energized) {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.68)";
        ctx.lineWidth = 2.2 * s;
      } else {
        // Energized conductor color reflects either thermal loading or Ferranti overvoltage
        if (isSevereOvervolt) {
          ctx.strokeStyle = C.danger;
        } else if (isOvervolt) {
          ctx.strokeStyle = C.warn;
        } else {
          ctx.strokeStyle = st.loading >= 0.8 ? loadColor(st.loading) : is230 ? C.nominal : C.nominalCyan;
        }
        ctx.lineWidth = (is230 ? 3.1 : 2.5) * s;
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Animated Active Power (MW) & Reactive Charging (+Mvar) Particle Streams
      if (st.energized) {
        this.drawBranchParticles(ctx, pts, br, st, isOvervolt, isSevereOvervolt, nowMs);
      }

      // Transformer double-circle symbol for 230/138 kV autotransformers
      const [mx, my] = this.toScreen(p.mx, p.my);
      if (br.kind === "transformer") {
        const col = st.energized ? C.nominalCyan : C.dead230;
        ctx.save();
        ctx.fillStyle = "#08101E";
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.8 * s;
        const r = 6.2 * s;
        ctx.beginPath();
        ctx.arc(mx, my - 3.5 * s, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(mx, my + 3.5 * s, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Interactive Breaker Switch Box at midpoint
      const bw = (isHint || isSelected || isHover ? 11.5 : 8.5) * s;
      ctx.save();
      if (isHint) {
        const pulse = 0.5 + 0.5 * Math.sin(nowMs / 180);
        ctx.strokeStyle = `rgba(255, 176, 32, ${0.45 + 0.45 * pulse})`;
        ctx.lineWidth = 2.2 * s;
        ctx.beginPath();
        ctx.arc(mx, my, bw * 1.45 + pulse * 4 * s, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = st.damaged
        ? "#2A0B14"
        : st.closed
        ? st.energized
          ? isSevereOvervolt
            ? C.danger
            : isOvervolt
            ? C.warn
            : C.nominal
          : "#475569"
        : "#0B1322";
      ctx.strokeStyle = isSelected
        ? "#FFFFFF"
        : isHint
        ? C.warn
        : st.damaged
        ? C.danger
        : st.closed
        ? "#06101E"
        : is230
        ? "#60A5FA"
        : "#94A3B8";
      ctx.lineWidth = (isSelected || isHint ? 2.2 : 1.5) * s;
      ctx.beginPath();
      ctx.roundRect(mx - bw / 2, my - bw / 2, bw, bw, 2.5 * s);
      ctx.fill();
      ctx.stroke();

      if (st.damaged) {
        ctx.strokeStyle = C.danger;
        ctx.lineWidth = 1.8 * s;
        ctx.beginPath();
        ctx.moveTo(mx - 4 * s, my - 4 * s);
        ctx.lineTo(mx + 4 * s, my + 4 * s);
        ctx.moveTo(mx + 4 * s, my - 4 * s);
        ctx.lineTo(mx - 4 * s, my + 4 * s);
        ctx.stroke();
      }
      ctx.restore();

      // Callout badge on key Ferranti / charging corridors or high-loading lines
      const keyTag = `${br.f}-${br.t}`;
      const chargingLabel = KEY_CHARGING_BRANCHES[keyTag];
      const showTagOnViewport = this.canvas.clientWidth >= 640 || isSelected || isHover || isHint;
      if (showTagOnViewport && ((chargingLabel && br.circuit === 1) || (st.energized && st.loading >= 0.65) || isSelected || isHover || isHint)) {
        this.drawBranchTag(ctx, mx, my, br, st, chargingLabel, isHint, isOvervolt, isSevereOvervolt);
      }
    }
  }

  private drawBranchParticles(
    ctx: CanvasRenderingContext2D,
    pts: [number, number][],
    br: { f: number; t: number; b: number },
    st: { Pf: number; Qf: number; Qt: number; Smax: number },
    isOvervolt: boolean,
    isSevereOvervolt: boolean,
    nowMs: number
  ) {
    const s = this.scale;
    const pAbs = Math.abs(st.Pf);
    const chargingMvar = br.b * 100;

    // 1. Capacitive charging particles (+Mvar flowing out of unloaded/lightly loaded high-B lines)
    if (chargingMvar >= 5 && pAbs < 45) {
      const nCharge = chargingMvar > 20 ? 4 : 3;
      const speed = 0.00055 + (isOvervolt ? 0.00045 : 0);
      ctx.save();
      ctx.fillStyle = isSevereOvervolt ? C.danger : isOvervolt ? C.warn : C.chargingViolet;
      for (let i = 0; i < nCharge; i++) {
        // Flow toward the higher-absorption / generator end
        const dir = st.Qt <= st.Qf ? 1 : -1;
        let u = ((nowMs * speed * dir + i / nCharge) % 1 + 1) % 1;
        const [px, py] = pointAlong(pts, u);
        ctx.beginPath();
        ctx.arc(px, py, (isOvervolt ? 3.3 : 2.6) * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. Active Power (MW) particles
    if (pAbs >= 2.0) {
      const dir = st.Pf >= 0 ? 1 : -1;
      const speed = (0.00038 + Math.min(350, pAbs) * 0.0000018) * dir;
      const count = pAbs > 140 ? 4 : 3;
      ctx.save();
      ctx.fillStyle = "#E0F2FE";
      for (let i = 0; i < count; i++) {
        const u = ((nowMs * speed + i / count) % 1 + 1) % 1;
        const [px, py] = pointAlong(pts, u);
        ctx.beginPath();
        ctx.arc(px, py, 2.4 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawBranchTag(
    ctx: CanvasRenderingContext2D,
    mx: number,
    my: number,
    br: { f: number; t: number; b: number },
    st: { closed: boolean; energized: boolean; Pf: number; Qf: number; Qt: number; loading: number },
    chargingLabel: string | undefined,
    isHint: boolean,
    isOvervolt: boolean,
    isSevereOvervolt: boolean
  ) {
    const s = this.scale;
    const lineId = `${this.sim.sc.buses[br.f].id}–${this.sim.sc.buses[br.t].id}`;
    let txt = "";
    let borderCol = "rgba(100, 148, 196, 0.45)";
    let textCol = "#CBD5E1";

    if (st.energized) {
      const qNet = -(st.Qf + st.Qt);
      if (Math.abs(st.Pf) < 25 && qNet > 3) {
        txt = `${lineId}: +${qNet.toFixed(0)} Mvar Qc`;
        borderCol = isSevereOvervolt ? C.danger : isOvervolt ? C.warn : C.chargingViolet;
        textCol = isSevereOvervolt ? "#FFE4E8" : isOvervolt ? "#FEF3C7" : "#F3E8FF";
      } else {
        txt = `${lineId}: ${Math.abs(st.Pf).toFixed(0)} MW · ${(st.loading * 100).toFixed(0)}%`;
        borderCol = st.loading >= 0.8 ? C.warn : "rgba(56, 189, 248, 0.5)";
        textCol = "#E2E8F0";
      }
    } else if (isHint) {
      txt = `CLOSE ${lineId} (${chargingLabel ?? `+${(br.b * 100).toFixed(0)} Mvar`})`;
      borderCol = C.warn;
      textCol = "#FEF3C7";
    } else if (chargingLabel) {
      txt = `${lineId} · ${chargingLabel}`;
    }

    if (!txt) return;

    ctx.save();
    ctx.font = `600 ${Math.max(8.5, 9.2 * s)}px "JetBrains Mono", monospace`;
    const padX = 5 * s;
    const tw = ctx.measureText(txt).width + padX * 2;
    const th = 14 * s;
    const isCable12 = br.f === 0 && br.t === 1;
    const belowTag = br.f === 16 && br.t === 21;
    const tx = isCable12 ? mx - 46 * s : mx;
    const ty = isCable12 ? my - 14 * s : belowTag ? my + 16 * s : my - 15 * s;
    ctx.fillStyle = "rgba(6, 11, 21, 0.90)";
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1.1 * s;
    ctx.beginPath();
    ctx.roundRect(tx - tw / 2, ty - th / 2, tw, th, 3 * s);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textCol;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, tx, ty + 0.5);
    ctx.restore();
  }

  private drawBuses(ctx: CanvasRenderingContext2D, nowMs: number) {
    const sc = this.sim.sc;
    const s = this.scale;

    for (let i = 0; i < sc.buses.length; i++) {
      const b = sc.buses[i];
      const st = this.sim.buses[i];
      const [sx, sy] = this.toScreen(b.x, b.y);
      const isSelected = this.sel?.kind === "bus" && this.sel.idx === i;
      const isHover = this.hover?.kind === "bus" && this.hover.idx === i;
      const isHint = this.highlight?.kind === "bus" && this.highlight.idx === i;

      const units = sc.units.filter((u) => u.bus === i);
      const hasBlackStart = units.some((u) => u.blackStart);
      const col = vColor(st.Vm, st.energized);

      // 1. Bus Voltage Luminous Halo
      if (st.energized || hasBlackStart || isHint) {
        ctx.save();
        const isFerrantiBus = st.energized && st.Vm > 1.05;
        const isTripBus = st.energized && st.Vm >= 1.15;
        const haloRadius = (isTripBus ? 46 : isFerrantiBus ? 38 : st.energized ? 28 : 24) * s;
        const grad = ctx.createRadialGradient(sx, sy, 3 * s, sx, sy, haloRadius);
        if (isTripBus) {
          grad.addColorStop(0, "rgba(255, 59, 92, 0.58)");
          grad.addColorStop(1, "rgba(255, 59, 92, 0)");
        } else if (isFerrantiBus) {
          grad.addColorStop(0, "rgba(255, 176, 32, 0.46)");
          grad.addColorStop(1, "rgba(255, 176, 32, 0)");
        } else if (st.energized) {
          grad.addColorStop(0, "rgba(20, 240, 160, 0.28)");
          grad.addColorStop(1, "rgba(20, 240, 160, 0)");
        } else {
          grad.addColorStop(0, "rgba(255, 176, 32, 0.22)");
          grad.addColorStop(1, "rgba(255, 176, 32, 0)");
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, haloRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 2. Generator Turret & Rotor Phase-Angle Needle (if station has units)
      const off = GEN_OFFSETS[i];
      if (off && units.length > 0) {
        this.drawGeneratorTurret(ctx, i, sx, sy, off, units, st, nowMs);
      }

      // 4. Substation Busbar Module Card (auto-sized to text width so names like '22 Aubrey' and '4 Agricola' never clip)
      const labelTxt = `${b.id} ${b.name}`;
      ctx.save();
      ctx.font = `700 ${Math.max(7.5, 10.2 * s)}px "Space Grotesk", "Inter", sans-serif`;
      const measuredW = ctx.measureText(labelTxt).width;
      const bw = Math.max(50 * s, measuredW + 13 * s);
      const bh = Math.max(14, 18 * s);

      // 3. Shunt Reactor Symbol at 6 Alber (bus idx 5) placed cleanly to the right of the auto-sized bus card
      if (sc.reactors.some((r) => r.bus === i)) {
        this.drawReactorSymbol(ctx, sx + bw / 2 + 24 * s, sy + 1 * s, st.reactorOn, st.energized);
      }

      if (isHint) {
        const pulse = 0.5 + 0.5 * Math.sin(nowMs / 180);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 176, 32, ${0.5 + 0.45 * pulse})`;
        ctx.lineWidth = 2.4 * s;
        ctx.beginPath();
        ctx.roundRect(sx - bw / 2 - 5 * s, sy - bh / 2 - 5 * s, bw + 10 * s, bh + 10 * s, 6 * s);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = st.energized ? "#0A1929" : C.deadBusFill;
      ctx.strokeStyle = isSelected ? "#FFFFFF" : isHover ? "#93C5FD" : hasBlackStart && !st.energized ? C.warn : col;
      ctx.lineWidth = (isSelected ? 2.5 : st.energized ? 2.1 : 1.5) * s;
      ctx.beginPath();
      ctx.roundRect(sx - bw / 2, sy - bh / 2, bw, bh, 4 * s);
      ctx.fill();
      ctx.stroke();

      // Substation ID + Name inside card
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = st.energized ? "#FFFFFF" : hasBlackStart ? "#FDE68A" : "#CBD5E1";
      ctx.fillText(labelTxt, sx, sy);
      ctx.restore();

      // 5. Live Voltage Readout Badge on every energized bus (positioned to avoid feeder blocks of vertically stacked buses)
      if (st.energized && (s >= 0.52 || isSelected || i === 21)) {
        const vTxt = `${st.Vm.toFixed(3)} pu${st.qLimit === -1 ? " · Qmin" : st.qLimit === 1 ? " · Qmax" : ""}`;
        ctx.save();
        ctx.font = `700 ${Math.max(7.2, 8.8 * s)}px "JetBrains Mono", monospace`;
        const vtw = ctx.measureText(vTxt).width + 8 * s;
        const vth = Math.max(11, 13 * s);
        // Buses 13 Arne (idx 12) and 9 Ali (idx 8) sit directly beneath 19 Attar and 11 Anna; place their voltage pill on the left.
        // Buses 10 Allen (idx 9) and 1 Abel (idx 0) sit beneath 12 Archer and 2 Adams; place their voltage pill on the right.
        const sideLeft = i === 12 || i === 8;
        const sideRight = i === 9 || i === 0;
        const vx = sideLeft ? sx - bw / 2 - vtw / 2 - 5 * s : sideRight ? sx + bw / 2 + vtw / 2 + 5 * s : sx;
        const vy = sideLeft || sideRight ? sy : sy - bh / 2 - 9 * s;

        ctx.fillStyle =
          st.Vm >= 1.15
            ? "rgba(255, 59, 92, 0.95)"
            : st.Vm > 1.05 || st.Vm < 0.95
            ? "rgba(245, 158, 11, 0.92)"
            : "rgba(6, 24, 38, 0.92)";
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.1 * s;
        ctx.beginPath();
        ctx.roundRect(vx - vtw / 2, vy - vth / 2, vtw, vth, 3 * s);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = st.Vm > 1.05 || st.Vm < 0.95 ? "#060B14" : col;
        if (st.Vm >= 1.15) ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(vTxt, vx, vy + 0.5);
        ctx.restore();
      } else if (i === 21 && this.ferrantiBanner?.tripped) {
        const tripTxt = "1.211 pu · PRC-024 TRIP!";
        ctx.save();
        ctx.font = `700 ${Math.max(8.5, 9.2 * s)}px "JetBrains Mono", monospace`;
        const vtw = ctx.measureText(tripTxt).width + 10 * s;
        const vy = sy - bh / 2 - 10 * s;
        ctx.fillStyle = "rgba(255, 59, 92, 0.95)";
        ctx.strokeStyle = "#FFE4E8";
        ctx.lineWidth = 1.2 * s;
        ctx.beginPath();
        ctx.roundRect(sx - vtw / 2, vy - 7 * s, vtw, 14 * s, 3 * s);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tripTxt, sx, vy + 0.5);
        ctx.restore();
      } else if (hasBlackStart && (isSelected || isHover || isHint)) {
        const bsTxt = i === 21 ? "BLACK-START HYDRO (300 MW)" : "BLACK-START CT (40 MW)";
        ctx.save();
        ctx.font = `700 ${Math.max(8, 8.5 * s)}px "JetBrains Mono", monospace`;
        const vtw = ctx.measureText(bsTxt).width + 8 * s;
        const vy = sy - bh / 2 - 9 * s;
        ctx.fillStyle = "rgba(245, 158, 11, 0.18)";
        ctx.strokeStyle = C.warn;
        ctx.lineWidth = 1 * s;
        ctx.beginPath();
        ctx.roundRect(sx - vtw / 2, vy - 6.5 * s, vtw, 13 * s, 3 * s);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#FDE68A";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(bsTxt, sx, vy + 0.5);
        ctx.restore();
      }

      // 6. 5-Block Cold-Load Pickup Feeder Strip below every load substation
      if (b.pd > 0) {
        const segW = 6.8 * s;
        const segH = 4.2 * s;
        const gap = 1.6 * s;
        const totalW = 5 * segW + 4 * gap;
        const x0 = sx - totalW / 2;
        const y0 = sy + bh / 2 + 3.5 * s;
        for (let k = 0; k < 5; k++) {
          ctx.fillStyle = k < st.blocks ? C.loadGold : "rgba(51, 65, 85, 0.72)";
          ctx.fillRect(x0 + k * (segW + gap), y0, segW, segH);
        }
      }
    }
  }

  private drawGeneratorTurret(
    ctx: CanvasRenderingContext2D,
    busIdx: number,
    sx: number,
    sy: number,
    off: [number, number],
    units: Simulation["sc"]["units"],
    busState: Simulation["buses"][number],
    nowMs: number
  ) {
    const s = this.scale;
    const gx = sx + off[0] * s;
    const gy = sy + off[1] * s;
    const r = 13.5 * s;

    const states = units.map((u) => this.sim.units[u.idx]);
    const nOnline = states.filter((u) => u.status === "online").length;
    const nStarting = states.filter((u) => u.status === "starting").length;
    const nTripped = states.filter((u) => u.status === "tripped").length;
    const allUnavailable = units.every((u) => !u.available);
    const isSynCon = units[0].kind === "syncon";

    let turretCol = "#64748B";
    if (allUnavailable) turretCol = "#475569";
    else if (nTripped > 0 && nOnline === 0) turretCol = C.danger;
    else if (nOnline > 0) turretCol = busState.qLimit === -1 ? C.warn : C.nominal;
    else if (nStarting > 0) turretCol = C.warn;
    else if (units.some((u) => u.blackStart)) turretCol = C.nominalCyan;

    // Connector stem
    ctx.save();
    ctx.strokeStyle = turretCol;
    ctx.lineWidth = 1.8 * s;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(gx, gy);
    ctx.stroke();

    // Turret body
    ctx.fillStyle = "#07101E";
    ctx.strokeStyle = turretCol;
    ctx.lineWidth = 2.0 * s;
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Segmented unit status ring around turret
    const nUnits = units.length;
    if (nUnits > 1 && !allUnavailable) {
      const ringR = r + 3.2 * s;
      const arcSpan = (Math.PI * 2) / nUnits;
      for (let uIdx = 0; uIdx < nUnits; uIdx++) {
        const uSt = states[uIdx].status;
        ctx.strokeStyle =
          uSt === "online"
            ? C.nominal
            : uSt === "starting"
            ? C.warn
            : uSt === "tripped"
            ? C.danger
            : "rgba(100, 116, 139, 0.35)";
        ctx.lineWidth = 2.2 * s;
        ctx.beginPath();
        ctx.arc(gx, gy, ringR, uIdx * arcSpan - Math.PI / 2 + 0.08, (uIdx + 1) * arcSpan - Math.PI / 2 - 0.08);
        ctx.stroke();
      }
    }

    // Rotor Phase-Angle Needle when online
    if (nOnline > 0) {
      const angRad = busState.Va - Math.PI / 2 + Math.sin(nowMs / 420) * 0.04;
      ctx.strokeStyle = busState.qLimit === -1 ? C.warn : C.nominal;
      ctx.lineWidth = 1.8 * s;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + Math.cos(angRad) * (r - 2.5 * s), gy + Math.sin(angRad) * (r - 2.5 * s));
      ctx.stroke();
    }

    // Center glyph & count
    ctx.fillStyle = allUnavailable ? "#64748B" : "#F8FAFC";
    ctx.font = `700 ${Math.max(8, 8.8 * s)}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const glyph = allUnavailable ? "NUC" : isSynCon ? "SC" : `${nOnline}/${nUnits}`;
    ctx.fillText(glyph, gx, gy + 0.5);
    ctx.restore();
    void busIdx;
  }

  private drawReactorSymbol(ctx: CanvasRenderingContext2D, rx: number, ry: number, on: boolean, energized: boolean) {
    const s = this.scale;
    const col = on ? (energized ? C.nominalCyan : C.warn) : "#64748B";
    const lbl = on ? "−100 Mvar" : "SHUNT";
    ctx.save();
    ctx.font = `700 ${Math.max(7, 7.8 * s)}px "JetBrains Mono", monospace`;
    const rw = Math.max(34 * s, ctx.measureText(lbl).width + 10 * s);
    const rh = Math.max(13, 16 * s);
    ctx.fillStyle = "#07101E";
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.roundRect(rx - rw / 2, ry - rh / 2, rw, rh, 3 * s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = on ? C.nominalCyan : "#94A3B8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(lbl, rx, ry + 0.5);
    ctx.restore();
  }

  private drawTripShockwave(ctx: CanvasRenderingContext2D, nowMs: number) {
    const dt = nowMs - this.lastTripShockwave;
    if (dt < 0 || dt > 3600) return;
    const s = this.scale;
    const aub = this.sim.sc.buses[21];
    const [ax, ay] = this.toScreen(aub.x, aub.y); // 22 Aubrey
    const u = dt / 3600;
    const r1 = (30 + u * 290) * s;
    const r2 = (15 + u * 190) * s;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 59, 92, ${(1 - u) * 0.85})`;
    ctx.lineWidth = 3.2 * s;
    ctx.beginPath();
    ctx.arc(ax, ay, r1, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `rgba(255, 176, 32, ${(1 - u) * 0.65})`;
    ctx.lineWidth = 2.0 * s;
    ctx.beginPath();
    ctx.arc(ax, ay, r2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawCanvasHud(ctx: CanvasRenderingContext2D, W: number, H: number, nowMs: number) {
    // 1. Compact PRC-024 Trip Alert Pill (only shown during active trip, docked top-center-left away from all substations)
    const fb = this.ferrantiBanner;
    if (fb && fb.active && (fb.tripped || fb.vAubrey >= 1.2) && W >= 640) {
      const pillW = Math.min(420, W - 220);
      const pillH = 26;
      const pillX = 186;
      const pillY = 10;
      ctx.save();
      ctx.fillStyle = "rgba(28, 7, 14, 0.94)";
      ctx.strokeStyle = C.danger;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.font = `700 10.5px "JetBrains Mono", monospace`;
      ctx.fillStyle = "#FECDD3";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("PRC-024 TRIP: 22 Aubrey peaked at 1.211 pu (+21.1%)", pillX + 10, pillY + 13.5, pillW - 20);
      ctx.restore();
    }

    // 2. Bottom-left Compact Legend Bar (desktop/tablet viewports)
    if (W < 640) return;
    const legY = H - 28;
    const items: [string, string][] = [
      [C.nominal, "0.95–1.05 pu Nominal"],
      [C.warn, "1.05–1.15 pu Qmin Rise"],
      [C.danger, "≥1.20 pu PRC-024 Trip"],
      ["#E0F2FE", "● MW Flow"],
      [C.chargingViolet, "● +Mvar Charging"],
      [C.loadGold, "■ Feeders (5 Bays/Bus)"],
    ];
    ctx.save();
    ctx.font = `600 9.5px "JetBrains Mono", monospace`;
    let totalW = 20;
    for (const [, label] of items) {
      totalW += ctx.measureText(label).width + 28;
    }
    const legW = Math.min(W - 28, totalW);
    ctx.fillStyle = "rgba(6, 11, 21, 0.88)";
    ctx.strokeStyle = "rgba(56, 189, 248, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(14, legY, legW, 22, 5);
    ctx.fill();
    ctx.stroke();

    let lx = 24;
    ctx.textBaseline = "middle";
    for (const [col, label] of items) {
      const itemW = ctx.measureText(label).width + 28;
      if (lx + itemW - 14 > 14 + legW) break;
      ctx.fillStyle = col;
      ctx.fillRect(lx, legY + 7, 8, 8);
      ctx.fillStyle = "#CBD5E1";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 12, legY + 11.5);
      lx += itemW;
    }
    ctx.restore();
    void nowMs;
  }
}

function pointAlong(pts: [number, number][], u: number): [number, number] {
  if (pts.length === 2) {
    return [pts[0][0] + (pts[1][0] - pts[0][0]) * u, pts[0][1] + (pts[1][1] - pts[0][1]) * u];
  }
  if (u < 0.5) {
    const t = u * 2;
    return [pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t];
  }
  const t = (u - 0.5) * 2;
  return [pts[1][0] + (pts[2][0] - pts[1][0]) * t, pts[1][1] + (pts[2][1] - pts[1][1]) * t];
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
