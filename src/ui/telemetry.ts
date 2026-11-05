import type { Simulation } from "../engine/sim";
import verifiedData from "../data/verified_telemetry.json";

const C = {
  bg: "#070D19",
  nominal: "#14F0A0",
  cyan: "#38BDF8",
  warn: "#FFB020",
  danger: "#FF3B5C",
  violet: "#C084FC",
  muted: "#64748B",
  text: "#E2E8F0",
};

function prepCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; W: number; H: number } {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const W = Math.max(10, Math.floor(r.width));
  const H = Math.max(10, Math.floor(r.height));
  if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}

/**
 * 1. 24-Bus Voltage Profile Bar Chart (0.85 pu to 1.25 pu)
 */
export function drawVoltageProfile(
  canvas: HTMLCanvasElement,
  sim: Simulation,
  selectedBus: number | null,
  lastTripPeakPu = 0
) {
  const { ctx, W, H } = prepCanvas(canvas);
  const padL = 34;
  const padR = 10;
  const padT = 18;
  const padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const vMin = 0.85;
  const vMax = 1.25;
  const yOf = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // Nominal 0.95 - 1.05 pu green band
  ctx.fillStyle = "rgba(20, 240, 160, 0.08)";
  ctx.fillRect(padL, yOf(1.05), plotW, yOf(0.95) - yOf(1.05));

  // Reference lines: 0.95, 1.05, 1.20 PRC-024 Instant Trip
  const refs: [number, string, string][] = [
    [1.2, "rgba(255, 59, 92, 0.65)", "1.20"],
    [1.05, "rgba(20, 240, 160, 0.35)", "1.05"],
    [0.95, "rgba(255, 176, 32, 0.35)", "0.95"],
  ];

  ctx.font = `600 8.5px "JetBrains Mono", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const [v, col, lbl] of refs) {
    const y = yOf(v);
    ctx.strokeStyle = col;
    ctx.lineWidth = v === 1.2 ? 1.2 : 1;
    if (v === 1.2) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = v === 1.2 ? C.danger : "#94A3B8";
    ctx.fillText(lbl, padL - 4, y);
  }

  // 24 Bus Bars
  const nb = sim.buses.length;
  const step = plotW / nb;
  const barW = Math.max(3, step - 3);
  const yBase = yOf(1.0);

  for (let i = 0; i < nb; i++) {
    const b = sim.buses[i];
    const x = padL + i * step + 1.5;

    if (selectedBus === i) {
      ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
      ctx.fillRect(x - 1, padT, barW + 2, plotH);
    }

    if (!b.energized) {
      ctx.fillStyle = "rgba(100, 116, 139, 0.28)";
      ctx.fillRect(x, padT + plotH - 3, barW, 3);
    } else {
      const vClamped = Math.max(vMin, Math.min(vMax, b.Vm));
      const y = yOf(vClamped);
      const col = b.Vm >= 1.12 || b.Vm < 0.88 ? C.danger : b.Vm > 1.05 || b.Vm < 0.95 ? C.warn : C.nominal;
      ctx.fillStyle = col;
      const top = Math.min(y, yBase);
      const h = Math.max(3, Math.abs(y - yBase));
      ctx.fillRect(x, top, barW, h);
    }

    // Bus number ticks (spaced cleanly across all 24 buses, highlighting Bus 22 Aubrey)
    if ([1, 6, 12, 17, 22].includes(i + 1)) {
      ctx.fillStyle = i === 21 ? C.cyan : "#64748B";
      ctx.font = `600 8px "JetBrains Mono", monospace`;
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), x + barW / 2, H - 6);
    }
  }

  // If a recent Ferranti trip happened, show the ghost peak marker at Bus 22 (1.211 pu)
  if (lastTripPeakPu >= 1.18 && !sim.buses[21].energized) {
    const x22 = padL + 21 * step + 1.5;
    const yPeak = yOf(Math.min(vMax, lastTripPeakPu));
    ctx.strokeStyle = C.danger;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x22 - 1, yPeak, barW + 2, yBase - yPeak);

    const lbl = `TRIP PEAK ${lastTripPeakPu.toFixed(3)} pu`;
    ctx.font = `700 8px "JetBrains Mono", monospace`;
    const tw = ctx.measureText(lbl).width + 8;
    const lx = Math.max(padL + 4, x22 - tw - 6);
    const ly = yPeak + 2;
    ctx.fillStyle = "rgba(6, 11, 21, 0.92)";
    ctx.strokeStyle = C.danger;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw, 13, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#FFE4E8";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(lbl, lx + 4, ly + 7);
  }
}

/**
 * 2. Q-V Ferranti Under-Excitation Runaway Curve (3 Units vs 6 Units at 22 Aubrey)
 */
export function drawQvFerrantiCurve(
  canvas: HTMLCanvasElement,
  sim: Simulation,
  lastTripPeakPu = 0
) {
  const { ctx, W, H } = prepCanvas(canvas);
  const padL = 34;
  const padR = 12;
  const padT = 18;
  const padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const qMaxCharge = 45; // Mvar line charging
  const vMin = 0.94;
  const vMax = 1.25;

  const xOf = (qMvar: number) => padL + 8 + (Math.min(qMaxCharge, Math.max(0, qMvar)) / qMaxCharge) * (plotW - 8);
  const yOf = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // Grid & PRC-024 1.20 pu Trip Ceiling
  const yTrip = yOf(1.2);
  ctx.strokeStyle = "rgba(255, 59, 92, 0.65)";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padL, yTrip);
  ctx.lineTo(W - padR, yTrip);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = C.danger;
  ctx.font = `700 8px "JetBrains Mono", monospace`;
  ctx.textAlign = "left";
  ctx.fillText("1.20 pu PRC-024 TRIP", padL + 6, yTrip + 10);

  const yNom = yOf(0.98);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  ctx.beginPath();
  ctx.moveTo(padL, yNom);
  ctx.lineTo(W - padR, yNom);
  ctx.stroke();

  // Plot verified 6-unit curve (holds 0.980 pu across all 45 Mvar)
  const qvPts = verifiedData.curves.qv_ferranti_curve;
  ctx.strokeStyle = C.nominal;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  qvPts.forEach((pt, idx) => {
    const x = xOf(pt.charging_mvar);
    const y = yOf(pt.v_6units_pu);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Plot verified 3-unit Ferranti runaway curve (0.980 -> 1.080 -> 1.211 pu!)
  const trapSteps = [
    { q: 0, v: 0.98, lbl: "0L" },
    { q: 13.7, v: 0.98, lbl: "21–22 (0.980)" },
    { q: 30.0, v: 0.98, lbl: "Qmin (-30M)" },
    { q: 36.4, v: 1.08, lbl: "17–22 (1.080)" },
    { q: 41.9, v: 1.2113, lbl: "16–17 (1.211!)" },
  ];
  ctx.strokeStyle = C.warn;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  trapSteps.forEach((pt, idx) => {
    const x = xOf(pt.q);
    const y = yOf(pt.v);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw milestone dots on the 3-unit trajectory
  trapSteps.forEach((pt, idx) => {
    if (idx === 2) return; // knee point
    const x = xOf(pt.q);
    const y = yOf(pt.v);
    ctx.fillStyle = pt.v >= 1.2 ? C.danger : pt.v > 1.05 ? C.warn : C.cyan;
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  });

  // Live Operating Point Crosshair at 22 Aubrey (bus idx 21)
  const aubrey = sim.buses[21];
  const aubreyUnits = sim.sc.units.filter((u) => u.bus === 21);
  const qAbsorbed = Math.max(
    0,
    -aubreyUnits.reduce((s, u) => s + (sim.units[u.idx].status === "online" ? sim.units[u.idx].Q : 0), 0)
  );
  // Estimate active line charging connected to Aubrey's island
  let liveQ = Math.min(44, qAbsorbed);
  let liveV = aubrey.energized ? aubrey.Vm : lastTripPeakPu >= 1.18 ? lastTripPeakPu : 0.98;
  if (!aubrey.energized && lastTripPeakPu >= 1.18) {
    liveQ = 41.9;
  } else if (aubrey.energized && aubrey.qLimit === -1) {
    // Map along the saturated segment
    liveQ = aubrey.Vm >= 1.15 ? 41.9 : 36.4;
  }

  const cx = xOf(liveQ);
  const cy = yOf(Math.max(vMin, Math.min(vMax, liveV)));
  const ptCol = liveV >= 1.15 ? C.danger : liveV > 1.05 ? C.warn : C.nominal;

  ctx.save();
  ctx.strokeStyle = ptCol;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = ptCol;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Axis labels
  ctx.fillStyle = "#94A3B8";
  ctx.font = `600 8px "JetBrains Mono", monospace`;
  ctx.textAlign = "right";
  ctx.fillText("1.20", padL - 4, yOf(1.2));
  ctx.fillText("1.08", padL - 4, yOf(1.08));
  ctx.fillText("0.98", padL - 4, yOf(0.98));

  ctx.textAlign = "center";
  ctx.fillText("0 Mvar", xOf(0), H - 5);
  ctx.fillText("22 Mvar", xOf(22), H - 5);
  ctx.fillText("42 Mvar Qc", xOf(41), H - 5);
}

/**
 * 3. Synchrophasor Polar Rose (V_m angle delta_i) + Island Frequency Strip (Hz)
 */
export function drawPhasorAndFrequency(canvas: HTMLCanvasElement, sim: Simulation) {
  const { ctx, W, H } = prepCanvas(canvas);

  // Left 38%: Polar Synchrophasor Wheel
  const roseW = Math.min(H - 8, Math.floor(W * 0.38));
  const rx = Math.floor(roseW * 0.54);
  const ry = Math.floor(H * 0.52);
  const rad = Math.max(18, Math.min(rx - 8, H * 0.40));

  ctx.save();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.20)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(rx, ry, rad, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rx, ry, rad * 0.65, 0, Math.PI * 2);
  ctx.stroke();

  // Crosshair axes
  ctx.beginPath();
  ctx.moveTo(rx - rad - 3, ry);
  ctx.lineTo(rx + rad + 3, ry);
  ctx.moveTo(rx, ry - rad - 3);
  ctx.lineTo(rx, ry + rad + 3);
  ctx.stroke();

  // Plot energized bus voltage phasors V_m < Va
  for (let i = 0; i < sim.buses.length; i++) {
    const b = sim.buses[i];
    if (!b.energized) continue;
    const is230 = sim.sc.buses[i].kv >= 200;
    const len = Math.min(1.25, Math.max(0.5, b.Vm)) * (rad / 1.15);
    const ang = -b.Va; // standard CCW electrical angle
    const px = rx + Math.cos(ang) * len;
    const py = ry + Math.sin(ang) * len;

    ctx.strokeStyle = b.Vm > 1.05 ? C.warn : is230 ? C.nominal : C.cyan;
    ctx.lineWidth = i === 21 ? 2.2 : 1.3;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(px, py);
    ctx.stroke();

    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(px, py, i === 21 ? 2.8 : 2.0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#94A3B8";
  ctx.font = `600 8px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.fillText("PHASORS V∠δ", rx, H - 5);
  ctx.restore();

  // Right 62%: Island Frequency Trace (59.0 Hz to 60.6 Hz)
  const fLeft = roseW + 24;
  const fRight = W - 8;
  const fTop = 14;
  const fBot = H - 16;
  const fW = Math.max(20, fRight - fLeft);
  const fH = Math.max(16, fBot - fTop);

  const fMin = 59.0;
  const fMax = 60.6;
  const fyOf = (f: number) => fTop + (1 - (f - fMin) / (fMax - fMin)) * fH;

  // 60.00 Hz nominal & 59.30 Hz UFLS lines
  const y60 = fyOf(60.0);
  ctx.strokeStyle = "rgba(20, 240, 160, 0.30)";
  ctx.beginPath();
  ctx.moveTo(fLeft, y60);
  ctx.lineTo(fRight, y60);
  ctx.stroke();

  const yUfls = fyOf(59.3);
  ctx.strokeStyle = "rgba(255, 59, 92, 0.55)";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(fLeft, yUfls);
  ctx.lineTo(fRight, yUfls);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `600 8px "JetBrains Mono", monospace`;
  ctx.textAlign = "right";
  ctx.fillStyle = C.nominal;
  ctx.fillText("60.0", fLeft - 3, y60 + 2);
  ctx.fillStyle = C.danger;
  ctx.fillText("59.3", fLeft - 3, yUfls + 2);

  // Plot island frequency traces
  const colors = [C.nominal, C.cyan, C.warn, C.violet];
  sim.islands.forEach((isl, idx) => {
    const tr = isl.fTrace;
    if (tr.length < 2) return;
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < tr.length; i++) {
      const x = fLeft + (i / Math.max(1, tr.length - 1)) * fW;
      const y = fyOf(Math.max(fMin, Math.min(fMax, tr[i])));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}
