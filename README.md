# Black Start — IEEE RTS-24 AC Power-Flow Grid Restoration & Ferranti Overvoltage Simulator

An interactive Energy Management System (EMS) and Supervisory Control and Data Acquisition (SCADA) transmission restoration simulator built on the **IEEE 24-Bus Reliability Test System (RTS-24)**. Every breaker operation, generator synchronization, exciter setpoint change, shunt reactor switch, and cold-load pickup block solves the full complex nodal admittance matrix $Y = G + jB$ using polar **Newton–Raphson AC power flow** coupled with per-island **swing-equation frequency dynamics ($df/dt$)** and **NERC PRC-024-3 protective relays**.

---

## Live Interactive Modes

1. **Mode 1 — The Ferranti Overvoltage Trap (`22 Aubrey Hydro`)**
   - Demonstrates why black-start operators cannot blindly energize unloaded Extra-High-Voltage (230 kV) transmission corridors.
   - Starting with **3 of 6 hydro units** online at `22 Aubrey` ($Q_{\min} = -30\text{ Mvar}$ total absorbing capability, $V_{\text{set}} = 0.980\text{ pu}$):
     - **Stage 0 (0 Lines Closed)**: $V_{22} = 0.9800\text{ pu}$, $Q_{\text{gen}} = 0.00\text{ Mvar}$ (`AVR_ACTIVE`).
     - **Stage 1 (Close Line `21–22`, 47 mi, $+14.2\text{ Mvar}$ charging)**: $V_{22} = 0.9800\text{ pu}$, $V_{21} = 0.9848\text{ pu}$, $Q_{\text{gen}} = -13.71\text{ Mvar}$ (`AVR_ACTIVE`).
     - **Stage 2 (Close Line `17–22`, 73 mi, $+22.2\text{ Mvar}$ charging)**: Total capacitive charging exceeds the 3-unit $-30\text{ Mvar}$ under-excitation limit ($Q_{\min}$ saturates). The automatic voltage regulator loses control and holds fixed internal EMF $E_q$ behind synchronous reactance $X_d = 1.8\text{ pu}$: $V_{22}$ jumps to **$1.0800\text{ pu}$** ($V_{17} = 1.0927\text{ pu}$, $Q_{\text{gen}} = -42.60\text{ Mvar}$).
     - **Stage 3 (Close Line `16–17`, 18 mi, $+5.5\text{ Mvar}$ charging)**: Uncompensated capacitive charging drives $V_{22}$ to **$1.2113\text{ pu}$ ($+21.1\%$ overvoltage)** and $V_{16}$ to **$1.2336\text{ pu}$**, crossing the **$1.200\text{ pu}$ NERC PRC-024-3 instantaneous overvoltage trip boundary** and collapsing the island.
     - **Stage 4 (6-Unit Recovery)**: Starting all **6 hydro units** doubles under-excitation capability to $Q_{\min} = -60\text{ Mvar}$, absorbing $-40.47\text{ Mvar}$ across all three 230 kV lines while holding $V_{22} = 0.9800\text{ pu}$ and $V_{\max} = 0.9980\text{ pu}$.

2. **Mode 2 — Guided 163-Action System Restoration (`1,682 MW`)**
   - Step-by-step or auto-sequenced (`1x / 10x / 60x / 300x`) cranking path from cold blackout to **100% restored load (`1,681.5 / 1,681.5 MW` across 85 feeder blocks / 120 substation bays)** at `60.00 Hz`, with instant milestone jumpers:
     - `0 · Blackout`
     - `1 · North 230 kV Spine`
     - `2 · Multi-Island Sync`
     - `3 · 6–10 Cable & 100 Mvar Shunt Reactor`
     - `4 · Full 1,682 MW Restored`

3. **Mode 3 — Operator Sandbox, N−1 Contingency & 163-Action Replay Scrubber**
   - Click any of the 24 substations or 38 transmission branches to inspect real-time phasors ($V\angle\delta$), generator $P/Q$ telemetry, $\pi$-equivalent branch parameters ($R, X, B_c$), and protective relay margins.
   - Toggle the **N−1 Damaged Line `17–22` Contingency** or scrub through all 163 verified restoration actions.

---

## Independent Python (`SciPy` / `PYPOWER` / `pandapower`) Verification

All network equations, Jacobian matrices, Q-limit transitions, and restoration trajectories are independently verified in Python (`verification/verify_grid_restoration.py` and `tests/verify_pypower.py`):

| Benchmark Check | Result |
| :--- | :--- |
| **IEEE RTS-24 Base Case (`scipy.optimize.root` vs `PYPOWER` / `pandapower`)** | Max $\|\Delta V\| = 4.44 \times 10^{-16}\text{ pu}$, Max $\|\Delta\delta\| = 4.09 \times 10^{-14}\text{ deg}$ |
| **13-Case Perturbation Suite vs `PYPOWER 5.1.21` / `pandapower 3.5.6`** | 13 / 13 converged, Max $\|\Delta V\| = 2.66 \times 10^{-15}\text{ pu}$ |
| **Ferranti Overvoltage Trap (`22 Aubrey`, 3 Units vs 6 Units)** | `0.9800 pu` $\to$ `0.9800 pu` $\to$ `1.0800 pu` ($Q_{\min}$) $\to$ **`1.2113 pu` (`PRC-024` Trip)** $\to$ `0.9800 pu` (6-Unit Recovery) |
| **163-Action Guided Restoration Sequence** | `1,681.5 / 1,681.5 MW` (`85/85` blocks), `24/24` buses inside `0.95–1.05 pu`, `0` trips, `0` sheds |

---

## Quick Start

```bash
npm install
npm run dev          # Launch interactive EMS/SCADA simulator
npm run build        # Type-check and build production bundle in dist/
npx tsx tests/acceptance.ts                 # Run 16-check TypeScript physics & protection suite
python3 verification/verify_grid_restoration.py  # Run SciPy AC power-flow & Ferranti verification suite
```
