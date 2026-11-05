// Newton–Raphson AC power flow in polar coordinates.
//
// Modeling follows the MATPOWER / PYPOWER conventions so results can be
// checked bus-by-bus against those independent references:
//   - branch pi model: series admittance ys = 1/(r + jx), total line charging
//     b split half per end, off-nominal tap ratio and phase shift at the
//     "from" end
//   - bus shunts (Gs + jBs) in MW/Mvar at V = 1 pu
//   - bus types 1 = PQ, 2 = PV, 3 = reference (angle reference + slack)
//   - several generating units may sit on one bus; they share the bus voltage
//     setpoint and their reactive limits add up (the published RTS data has up
//     to six units per bus)
//   - optional reactive-limit enforcement: a PV bus whose units reach Qmax or
//     Qmin becomes a PQ bus held at that limit, and (unlike MATPOWER/PYPOWER)
//     goes back to voltage control if its voltage later crosses the setpoint
//     in the direction the limit cannot follow. If the reference bus itself
//     reaches a limit it keeps the angle reference but releases its voltage
//     magnitude (Q fixed at the limit, P still free), which is how a single
//     islanded plant with its AVR on the ceiling behaves. MATPOWER instead
//     moves the reference; the validation scenarios avoid that situation.
// Everything is dense: the networks this game solves have at most a few dozen
// buses, so a dense LU per Newton step is the fastest honest choice.

export type BusType = 1 | 2 | 3;

export interface Branch {
  f: number; // from-bus index (0-based)
  t: number; // to-bus index (0-based)
  r: number; // pu
  x: number; // pu
  b: number; // total line charging susceptance, pu
  ratio: number; // tap ratio (0 or 1 = nominal)
  shift: number; // phase shift, degrees
  rateA: number; // continuous MVA rating (0 = unlimited)
  rateB: number; // long-term emergency MVA rating
  rateC: number; // short-term emergency MVA rating
  status: number; // 1 in service, 0 out
}

export interface Gen {
  bus: number; // 0-based bus index
  Pg: number; // MW
  Qg: number; // Mvar (only used for reporting / fixed-Q units)
  Qmax: number; // Mvar
  Qmin: number; // Mvar
  Vg: number; // voltage setpoint, pu
  status: number; // 1 online
  Pmax: number; // MW
  Pmin: number; // MW
  /** Optional synchronous reactance, pu on the system base. When every online unit at a bus has one, a unit held at its
   *  under-excitation limit keeps a fixed internal EMF behind Xd instead of a fixed Q, so excess line charging raises the
   *  bus voltage (the physical direction) rather than lowering it. Omit for the MATPOWER/PYPOWER fixed-Q convention. */
  Xd?: number;
}

export interface Network {
  baseMVA: number;
  nb: number;
  busType: BusType[];
  Pd: number[]; // MW
  Qd: number[]; // Mvar
  Gs: number[]; // MW at 1 pu
  Bs: number[]; // Mvar at 1 pu
  Vmax: number[];
  Vmin: number[];
  baseKV: number[];
  branches: Branch[];
  gens: Gen[];
}

/** A plant held at a reactive limit is released back to voltage control only when its bus voltage is more than
 *  this far past the setpoint (pu). The same tolerance defines the complementarity check in validation/compare.py. */
export const QLIM_V_TOL = 1e-4;

export interface SolveOptions {
  tol?: number; // max |mismatch| in pu
  maxIter?: number;
  enforceQLims?: boolean;
  /** Let a bus held at a reactive limit return to voltage control when its voltage crosses back over the setpoint
   *  (default true). Set false for the MATPOWER/PYPOWER convention, which never releases a limited bus. */
  releaseQLims?: boolean;
  Vm0?: ArrayLike<number>; // flat start if omitted
  Va0?: ArrayLike<number>; // radians
  /** Bus subset to solve (an energized island). Omit for the full network. */
  buses?: number[];
}

export interface BranchFlow {
  idx: number;
  Pf: number; Qf: number; // MW, Mvar entering the branch at the from end
  Pt: number; Qt: number; // MW, Mvar entering the branch at the to end
  Sf: number; St: number; // MVA
  Smax: number; // max(Sf, St)
  loading: number; // Smax / rateA (0 when unlimited) — the MVA convention of the published ratings
  loadingI: number; // current-based: |I| / (rateA / baseMVA), pandapower's convention
  If: number; It: number; // current magnitude, pu on system base
  energized: boolean;
}

export interface SolveResult {
  converged: boolean;
  iterations: number; // Newton iterations of the final Q-limit pass
  totalIterations: number; // all Newton iterations including Q-limit re-solves
  qLimitPasses: number;
  maxMismatch: number; // pu
  Vm: Float64Array;
  Va: Float64Array; // radians
  Pinj: Float64Array; // net MW injection per bus (generation - load)
  Qinj: Float64Array;
  genP: Float64Array; // MW per gen (aligned with network.gens)
  genQ: Float64Array;
  busQLimit: Int8Array; // per bus: -1 held at Qmin, +1 at Qmax, 0 free
  flows: BranchFlow[];
  lossesMW: number;
  lossesMvar: number;
  solvedBuses: number[];
  reason?: string;
}

interface YbusParts {
  G: Float64Array; B: Float64Array; // nb*nb row-major
  Yff: Array<[number, number]>; Yft: Array<[number, number]>;
  Ytf: Array<[number, number]>; Ytt: Array<[number, number]>;
}

export function buildYbus(net: Network, active: boolean[]): YbusParts {
  const nb = net.nb;
  const G = new Float64Array(nb * nb);
  const B = new Float64Array(nb * nb);
  const Yff: Array<[number, number]> = [], Yft: Array<[number, number]> = [], Ytf: Array<[number, number]> = [], Ytt: Array<[number, number]> = [];
  for (let k = 0; k < net.branches.length; k++) {
    const br = net.branches[k];
    const on = br.status !== 0 && active[br.f] && active[br.t];
    if (!on) { Yff.push([0, 0]); Yft.push([0, 0]); Ytf.push([0, 0]); Ytt.push([0, 0]); continue; }
    const den = br.r * br.r + br.x * br.x;
    const ysr = br.r / den, ysi = -br.x / den; // ys = 1/(r+jx)
    const tap = br.ratio === 0 ? 1 : br.ratio;
    const sh = (br.shift * Math.PI) / 180;
    const tr = tap * Math.cos(sh), ti = tap * Math.sin(sh);
    const tap2 = tr * tr + ti * ti;
    const yttr = ysr, ytti = ysi + br.b / 2; // Ytt = ys + j b/2
    const yffr = yttr / tap2, yffi = ytti / tap2; // Yff = Ytt / |tap|^2
    const yftr = -(ysr * tr - ysi * ti) / tap2, yfti = -(ysr * ti + ysi * tr) / tap2; // Yft = -ys / conj(tap)
    const ytfr = -(ysr * tr + ysi * ti) / tap2, ytfi = -(ysi * tr - ysr * ti) / tap2; // Ytf = -ys / tap
    Yff.push([yffr, yffi]); Yft.push([yftr, yfti]); Ytf.push([ytfr, ytfi]); Ytt.push([yttr, ytti]);
    const f = br.f, t = br.t;
    G[f * nb + f] += yffr; B[f * nb + f] += yffi;
    G[t * nb + t] += yttr; B[t * nb + t] += ytti;
    G[f * nb + t] += yftr; B[f * nb + t] += yfti;
    G[t * nb + f] += ytfr; B[t * nb + f] += ytfi;
  }
  for (let i = 0; i < nb; i++) {
    if (!active[i]) continue;
    G[i * nb + i] += net.Gs[i] / net.baseMVA;
    B[i * nb + i] += net.Bs[i] / net.baseMVA;
  }
  return { G, B, Yff, Yft, Ytf, Ytt };
}

/** Solve A x = b in place (A row-major n*n, partial pivoting). Returns false if singular. */
export function luSolve(A: Float64Array, b: Float64Array, n: number): boolean {
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; p = r; } }
    if (best < 1e-14) return false;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const tmp = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = tmp; }
      const tb = b[c]; b[c] = b[p]; b[p] = tb;
    }
    const piv = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const fct = A[r * n + c] / piv;
      if (fct === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= fct * A[c * n + k];
      b[r] -= fct * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
    b[r] = s / A[r * n + r];
  }
  return true;
}

export function solvePowerFlow(net: Network, opts: SolveOptions = {}): SolveResult {
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 20;
  const nb = net.nb;
  const subset = opts.buses ?? Array.from({ length: nb }, (_, i) => i);
  const active = new Array<boolean>(nb).fill(false);
  for (const b of subset) active[b] = true;

  const Y = buildYbus(net, active);
  const G = Y.G, B = Y.B;

  // bus roles
  const type: number[] = net.busType.slice();
  const genOn = net.gens.map((g) => g.status !== 0 && active[g.bus]);
  const busGens: number[][] = Array.from({ length: nb }, () => []);
  for (let g = 0; g < net.gens.length; g++) if (genOn[g]) busGens[net.gens[g].bus].push(g);
  for (let i = 0; i < nb; i++) if ((type[i] === 2 || type[i] === 3) && busGens[i].length === 0) type[i] = 1;
  const busQmax = new Float64Array(nb), busQmin = new Float64Array(nb), busPg = new Float64Array(nb);
  for (let i = 0; i < nb; i++) for (const g of busGens[i]) { busQmax[i] += net.gens[g].Qmax; busQmin[i] += net.gens[g].Qmin; busPg[i] += net.gens[g].Pg; }
  const busQLimit = new Int8Array(nb); // -1 / 0 / +1
  const fixedQ = new Float64Array(nb); // Mvar held when limited
  const released = new Int8Array(nb); // how often a bus has gone back from a limit to regulating in this solve (max 2)
  // EMF-behind-reactance model for buses at their under-excitation limit (only when every unit at the bus has Xd)
  const busX = new Float64Array(nb).fill(NaN), busE = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    if (!busGens[i].length || busGens[i].some((g) => !(net.gens[g].Xd! > 0))) continue;
    let inv = 0; for (const g of busGens[i]) inv += 1 / net.gens[g].Xd!;
    busX[i] = 1 / inv;
  }
  const emf = (i: number) => busQLimit[i] === -1 && busX[i] > 0;
  const qEmf = (i: number) => (busE[i] * Vm[i] - Vm[i] * Vm[i]) / busX[i]; // pu generated (negative = absorbing)

  const Vm = new Float64Array(nb).fill(1);
  const Va = new Float64Array(nb);
  if (opts.Vm0) for (let i = 0; i < nb; i++) Vm[i] = opts.Vm0[i];
  if (opts.Va0) for (let i = 0; i < nb; i++) Va[i] = opts.Va0[i];
  for (let i = 0; i < nb; i++) {
    if (!active[i]) { Vm[i] = 0; Va[i] = 0; continue; }
    if ((type[i] === 2 || type[i] === 3) && busGens[i].length) Vm[i] = net.gens[busGens[i][0]].Vg;
    if (!(Vm[i] > 0.2)) Vm[i] = 1;
  }

  const Psch = new Float64Array(nb), Qsch = new Float64Array(nb);
  const Ir = new Float64Array(nb), Ii = new Float64Array(nb), Pc = new Float64Array(nb), Qc = new Float64Array(nb);
  const cosA = new Float64Array(nb), sinA = new Float64Array(nb);

  const computeInjections = () => {
    for (let k = 0; k < nb; k++) { cosA[k] = Math.cos(Va[k]); sinA[k] = Math.sin(Va[k]); }
    for (let i = 0; i < nb; i++) {
      if (!active[i]) { Ir[i] = Ii[i] = Pc[i] = Qc[i] = 0; continue; }
      let sr = 0, si = 0;
      const row = i * nb;
      for (let k = 0; k < nb; k++) {
        const g = G[row + k], b = B[row + k];
        if (g === 0 && b === 0) continue;
        const vr = Vm[k] * cosA[k], vi = Vm[k] * sinA[k];
        sr += g * vr - b * vi; si += g * vi + b * vr;
      }
      Ir[i] = sr; Ii[i] = si;
      const vr = Vm[i] * cosA[i], vi = Vm[i] * sinA[i];
      Pc[i] = vr * sr + vi * si; Qc[i] = vi * sr - vr * si; // S = V conj(I)
    }
  };

  let totalIter = 0, passes = 0, lastIter = 0, maxMis = Infinity, converged = false;
  let reason: string | undefined;
  const refBuses = subset.filter((i) => type[i] === 3);
  if (refBuses.length !== 1) {
    return emptyResult(net, subset, refBuses.length === 0 ? "no reference bus in island" : "more than one reference bus");
  }
  const ref = refBuses[0];

  for (passes = 0; passes < 12; passes++) {
    for (let i = 0; i < nb; i++) {
      if (!active[i]) { Psch[i] = Qsch[i] = 0; continue; }
      Psch[i] = (busPg[i] - net.Pd[i]) / net.baseMVA;
      Qsch[i] = ((busQLimit[i] !== 0 ? fixedQ[i] : 0) - net.Qd[i]) / net.baseMVA;
    }
    // unknown angles: every active bus except the reference; unknown magnitudes: PQ buses (incl. a Q-limited reference)
    const angSet: number[] = [], magSet: number[] = [];
    for (const i of subset) {
      if (i !== ref) angSet.push(i);
      if (type[i] === 1 || (i === ref && busQLimit[i] !== 0)) magSet.push(i);
    }
    const n1 = angSet.length, n2 = magSet.length, n = n1 + n2;
    const posA = new Int32Array(nb).fill(-1), posM = new Int32Array(nb).fill(-1);
    angSet.forEach((b, j) => (posA[b] = j));
    magSet.forEach((b, j) => (posM[b] = n1 + j));
    const J = new Float64Array(n * n), F = new Float64Array(n), dx = new Float64Array(n);
    converged = false;
    let it = 0;
    for (it = 0; it <= maxIter; it++) {
      computeInjections();
      for (const i of magSet) if (emf(i)) Qsch[i] = qEmf(i) - net.Qd[i] / net.baseMVA;
      let mis = 0;
      for (let j = 0; j < n1; j++) { const i = angSet[j]; F[j] = Pc[i] - Psch[i]; const a = Math.abs(F[j]); if (a > mis) mis = a; }
      for (let j = 0; j < n2; j++) { const i = magSet[j]; F[n1 + j] = Qc[i] - Qsch[i]; const a = Math.abs(F[n1 + j]); if (a > mis) mis = a; }
      maxMis = mis;
      if (!Number.isFinite(mis)) { reason = "numerical blow-up"; break; }
      if (mis < tol) { converged = true; break; }
      if (it === maxIter) break;
      J.fill(0);
      for (let i = 0; i < nb; i++) {
        if (!active[i]) continue;
        const ra = posA[i], rm = posM[i];
        if (ra < 0 && rm < 0) continue;
        const vri = Vm[i] * cosA[i], vii = Vm[i] * sinA[i];
        const row = i * nb;
        for (let k = 0; k < nb; k++) {
          if (!active[k]) continue;
          const ca = posA[k], cm = posM[k];
          if (ca < 0 && cm < 0) continue;
          const g = G[row + k], b = B[row + k];
          let dSa_r = 0, dSa_i = 0, dSm_r = 0, dSm_i = 0;
          if (i === k) {
            const yvr = g * vri - b * vii, yvi = g * vii + b * vri;
            const dr = Ir[i] - yvr, di = Ii[i] - yvi; // I_i - Y_ii V_i
            dSa_r = -(vii * dr - vri * di); // j V conj(d)
            dSa_i = vri * dr + vii * di;
            const nr = cosA[i], ni = sinA[i];
            const yn_r = g * nr - b * ni, yn_i = g * ni + b * nr; // Y_ii Vnorm_i
            dSm_r = vri * yn_r + vii * yn_i + Ir[i] * nr + Ii[i] * ni;
            dSm_i = vii * yn_r - vri * yn_i + Ir[i] * ni - Ii[i] * nr;
            if (emf(i)) dSm_i -= (busE[i] - 2 * Vm[i]) / busX[i]; // scheduled Q depends on V
          } else {
            if (g === 0 && b === 0) continue;
            const vrk = Vm[k] * cosA[k], vik = Vm[k] * sinA[k];
            const yvr = g * vrk - b * vik, yvi = g * vik + b * vrk; // Y_ik V_k
            const pr = vri * yvr + vii * yvi, pi = vii * yvr - vri * yvi; // V_i conj(Y_ik V_k)
            dSa_r = pi; dSa_i = -pr; // -j (pr + j pi)
            const nr = cosA[k], ni = sinA[k];
            const yn_r = g * nr - b * ni, yn_i = g * ni + b * nr;
            dSm_r = vri * yn_r + vii * yn_i;
            dSm_i = vii * yn_r - vri * yn_i;
          }
          if (ra >= 0 && ca >= 0) J[ra * n + ca] = dSa_r;
          if (ra >= 0 && cm >= 0) J[ra * n + cm] = dSm_r;
          if (rm >= 0 && ca >= 0) J[rm * n + ca] = dSa_i;
          if (rm >= 0 && cm >= 0) J[rm * n + cm] = dSm_i;
        }
      }
      for (let j = 0; j < n; j++) dx[j] = -F[j];
      if (!luSolve(J, dx, n)) { reason = "singular Jacobian"; break; }
      for (let j = 0; j < n1; j++) Va[angSet[j]] += dx[j];
      for (let j = 0; j < n2; j++) Vm[magSet[j]] += dx[n1 + j];
      let bad = false;
      for (let j = 0; j < n2; j++) { const v = Vm[magSet[j]]; if (!(v > 0.05) || !Number.isFinite(v) || v > 5) bad = true; }
      if (bad) { reason = "voltage solution collapsed"; it++; break; }
    }
    lastIter = it; totalIter += it;
    if (!converged) { if (!reason) reason = "did not converge in " + maxIter + " iterations"; break; }
    if (!opts.enforceQLims) break;
    computeInjections();
    let switched = false;
    // 1. a limited bus whose voltage has moved to the wrong side of its setpoint goes back to regulating: a plant held at
    //    Qmin (absorbing) with its bus below the setpoint would raise excitation, one held at Qmax with its bus above the
    //    setpoint would lower it. MATPOWER/PYPOWER never release (opts.releaseQLims = false reproduces them); the game
    //    needs the release because an all-at-once switch can land on a branch where a plant is pinned at a limit it no
    //    longer touches. A bus is released at most twice per solve and only when its voltage is more than
    //    QLIM_V_TOL past the setpoint, so a plant sitting exactly on a limit cannot make the passes cycle.
    if (opts.releaseQLims !== false) {
      for (const i of subset) {
        if (busQLimit[i] === 0 || released[i] >= 2) continue;
        const vset = net.gens[busGens[i][0]].Vg;
        if ((busQLimit[i] === -1 && Vm[i] < vset - QLIM_V_TOL) || (busQLimit[i] === 1 && Vm[i] > vset + QLIM_V_TOL)) {
          busQLimit[i] = 0; fixedQ[i] = 0; released[i]++; Vm[i] = vset; if (i !== ref) type[i] = 2; switched = true;
        }
      }
    }
    // 2. a regulating bus whose units are beyond a reactive limit is held at that limit
    for (const i of subset) {
      if (busQLimit[i] !== 0 || busGens[i].length === 0 || type[i] === 1) continue;
      const Qg = Qc[i] * net.baseMVA + net.Qd[i];
      if (Qg > busQmax[i] + 1e-9) { busQLimit[i] = 1; fixedQ[i] = busQmax[i]; if (i !== ref) type[i] = 1; switched = true; }
      else if (Qg < busQmin[i] - 1e-9) {
        busQLimit[i] = -1; fixedQ[i] = busQmin[i]; if (i !== ref) type[i] = 1; switched = true;
        if (busX[i] > 0) busE[i] = ((busQmin[i] / net.baseMVA) * busX[i] + Vm[i] * Vm[i]) / Vm[i]; // EMF that gives Qmin at the present voltage
      }
    }
    if (!switched) break;
  }
  for (let i = 0; i < nb; i++) if (emf(i)) fixedQ[i] = qEmf(i) * net.baseMVA;

  computeInjections();
  const Pinj = new Float64Array(nb), Qinj = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { Pinj[i] = active[i] ? Pc[i] * net.baseMVA : 0; Qinj[i] = active[i] ? Qc[i] * net.baseMVA : 0; }
  const genP = new Float64Array(net.gens.length), genQ = new Float64Array(net.gens.length);
  for (let i = 0; i < nb; i++) {
    const gs = busGens[i];
    if (!gs.length) continue;
    const Ptot = i === ref ? Pinj[i] + net.Pd[i] : busPg[i];
    const Qtot = busQLimit[i] !== 0 ? fixedQ[i] : Qinj[i] + net.Qd[i];
    // the reference bus's slack power goes to its units in proportion to Pmax; reactive power is shared in
    // proportion to each unit's reactive range (MATPOWER's pfsoln convention)
    let pmaxSum = 0, qrange = 0, qminSum = 0;
    for (const g of gs) { pmaxSum += net.gens[g].Pmax; qrange += net.gens[g].Qmax - net.gens[g].Qmin; qminSum += net.gens[g].Qmin; }
    for (const g of gs) {
      const gen = net.gens[g];
      genP[g] = i === ref ? (pmaxSum > 0 ? Ptot * gen.Pmax / pmaxSum : Ptot / gs.length) : gen.Pg;
      genQ[g] = qrange > 0 ? gen.Qmin + (Qtot - qminSum) * (gen.Qmax - gen.Qmin) / qrange : Qtot / gs.length;
    }
  }
  const flows: BranchFlow[] = [];
  let lossP = 0, lossQ = 0;
  for (let k = 0; k < net.branches.length; k++) {
    const br = net.branches[k];
    const on = br.status !== 0 && active[br.f] && active[br.t];
    if (!on) { flows.push({ idx: k, Pf: 0, Qf: 0, Pt: 0, Qt: 0, Sf: 0, St: 0, Smax: 0, loading: 0, loadingI: 0, If: 0, It: 0, energized: false }); continue; }
    const f = br.f, t = br.t;
    const vfr = Vm[f] * cosA[f], vfi = Vm[f] * sinA[f], vtr = Vm[t] * cosA[t], vti = Vm[t] * sinA[t];
    const [yffr, yffi] = Y.Yff[k], [yftr, yfti] = Y.Yft[k], [ytfr, ytfi] = Y.Ytf[k], [yttr, ytti] = Y.Ytt[k];
    const ifr = yffr * vfr - yffi * vfi + yftr * vtr - yfti * vti, ifi = yffr * vfi + yffi * vfr + yftr * vti + yfti * vtr;
    const itr = ytfr * vfr - ytfi * vfi + yttr * vtr - ytti * vti, iti = ytfr * vfi + ytfi * vfr + yttr * vti + ytti * vtr;
    const Pf = (vfr * ifr + vfi * ifi) * net.baseMVA, Qf = (vfi * ifr - vfr * ifi) * net.baseMVA;
    const Pt = (vtr * itr + vti * iti) * net.baseMVA, Qt = (vti * itr - vtr * iti) * net.baseMVA;
    const Sf = Math.hypot(Pf, Qf), St = Math.hypot(Pt, Qt), Smax = Math.max(Sf, St);
    const If = Math.hypot(ifr, ifi), It = Math.hypot(itr, iti);
    lossP += Pf + Pt; lossQ += Qf + Qt;
    flows.push({ idx: k, Pf, Qf, Pt, Qt, Sf, St, Smax, loading: br.rateA > 0 ? Smax / br.rateA : 0, loadingI: br.rateA > 0 ? (Math.max(If, It) * net.baseMVA) / br.rateA : 0, If, It, energized: true });
  }
  return { converged, iterations: lastIter, totalIterations: totalIter, qLimitPasses: passes + 1, maxMismatch: maxMis, Vm, Va, Pinj, Qinj, genP, genQ, busQLimit, flows, lossesMW: lossP, lossesMvar: lossQ, solvedBuses: subset, reason };
}

function emptyResult(net: Network, subset: number[], reason: string): SolveResult {
  const nb = net.nb;
  return { converged: false, iterations: 0, totalIterations: 0, qLimitPasses: 0, maxMismatch: Infinity, Vm: new Float64Array(nb), Va: new Float64Array(nb), Pinj: new Float64Array(nb), Qinj: new Float64Array(nb),
    genP: new Float64Array(net.gens.length), genQ: new Float64Array(net.gens.length), busQLimit: new Int8Array(nb),
    flows: net.branches.map((_, k) => ({ idx: k, Pf: 0, Qf: 0, Pt: 0, Qt: 0, Sf: 0, St: 0, Smax: 0, loading: 0, loadingI: 0, If: 0, It: 0, energized: false })), lossesMW: 0, lossesMvar: 0, solvedBuses: subset, reason };
}

/** Build a Network from a MATPOWER-style case object (0-based bus indices in bus_i / gen bus / branch f,t). */
export function networkFromCase(c: { baseMVA: number; bus: number[][]; gen: number[][]; branch: number[][] }): Network {
  const nb = c.bus.length;
  const idx = new Map<number, number>();
  c.bus.forEach((row, i) => idx.set(row[0], i));
  return {
    baseMVA: c.baseMVA, nb,
    busType: c.bus.map((r) => r[1] as BusType),
    Pd: c.bus.map((r) => r[2]), Qd: c.bus.map((r) => r[3]), Gs: c.bus.map((r) => r[4]), Bs: c.bus.map((r) => r[5]),
    Vmax: c.bus.map((r) => r[11]), Vmin: c.bus.map((r) => r[12]), baseKV: c.bus.map((r) => r[9]),
    gens: c.gen.map((r) => ({ bus: idx.get(r[0])!, Pg: r[1], Qg: r[2], Qmax: r[3], Qmin: r[4], Vg: r[5], status: r[7], Pmax: r[8], Pmin: r[9] })),
    branches: c.branch.map((r) => ({ f: idx.get(r[0])!, t: idx.get(r[1])!, r: r[2], x: r[3], b: r[4], rateA: r[5], rateB: r[6], rateC: r[7], ratio: r[8], shift: r[9], status: r[10] })),
  };
}
