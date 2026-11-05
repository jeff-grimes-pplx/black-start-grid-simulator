export type UnitKind = "steam" | "ct" | "hydro" | "nuclear" | "syncon";
export type UnitStatus = "off" | "starting" | "online" | "tripped";

export interface ScenarioBus {
  idx: number; id: number; name: string; kv: number; type: number;
  pdPeak: number; qdPeak: number; pd: number; qd: number; gs: number; bs: number;
  vmin: number; vmax: number; x: number; y: number;
}
export interface ScenarioBranch {
  idx: number; id: string; f: number; t: number; r: number; x: number; b: number; ratio: number; shift: number;
  con: number; lte: number; ste: number; miles: number; kind: "line" | "transformer"; circuit: number; circuits: number;
  matpowerRates: number[]; paperX: number | null;
}
export interface ScenarioUnit {
  idx: number; bus: number; code: string; num: number; kind: UnitKind; fuel: string;
  pmax: number; pmin: number; qmax: number; qmin: number; vg: number;
  available: boolean; blackStart: boolean; startMin: number | null; agcRampMWmin: number; govRampMWs: number; H: number; crankMW: number;
  mvaBase: number; xd: number; // synchronous reactance, pu on mvaBase
}
export interface Scenario {
  name: string; baseMVA: number; f0: number; loadFactor: number;
  buses: ScenarioBus[]; branches: ScenarioBranch[]; units: ScenarioUnit[];
  reactors: { bus: number; mvar: number }[];
  sources: Record<string, string>;
  assumptions: { what: string; value: string; source: string; url: string | null }[];
  counts: Record<string, number>;
  provenance: Record<string, string>;
}

export type Action =
  | { t: number; type: "start"; unit: number }
  | { t: number; type: "stop"; unit: number }
  | { t: number; type: "close"; branch: number }
  | { t: number; type: "open"; branch: number }
  | { t: number; type: "pickup"; bus: number }
  | { t: number; type: "drop"; bus: number }
  | { t: number; type: "reactor"; bus: number; on: boolean }
  | { t: number; type: "avr"; bus: number; vg: number }
  | { t: number; type: "limit"; bus: number; mw: number };

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type Command = DistributiveOmit<Action, "t">;

export type EventLevel = "info" | "ok" | "warn" | "alarm" | "trip";
export interface GameEvent { t: number; level: EventLevel; text: string; bus?: number; branch?: number; unit?: number }

export interface UnitState {
  status: UnitStatus;
  startedAt: number; // sim s when the start command was accepted
  syncAt: number; // sim s when the unit will (or did) synchronize
  crank: number; // MW of auxiliaries drawn from the plant bus while starting (ramps off again after synchronizing)
  loading: boolean; // true from synchronizing until the setpoint first reaches minimum load (no upward primary response yet)
  Pset: number; // dispatch setpoint, MW (moved by secondary control)
  Pgov: number; // governor (primary) contribution, MW
  P: number; // electrical output from the last power flow, MW
  Q: number; // Mvar
  tripReason: string;
  uvTimer: number; ovTimer: number; ufTimer: number; ofTimer: number;
}
export interface BranchState {
  closed: boolean; damaged: boolean; tripped: boolean;
  loading: number; // Smax / continuous rating
  Smax: number; Pf: number; Qf: number; Pt: number; Qt: number;
  steTimer: number; lteTimer: number; // s spent above STE / above LTE
  energized: boolean;
}
export interface BusState {
  energized: boolean; island: number; Vm: number; Va: number; blocks: number; // picked-up blocks
  Pd: number; Qd: number; // MW / Mvar currently served (incl. cranking)
  qLimit: number; reactorOn: boolean; uvTimer: number;
  vset: number; // AVR voltage setpoint shared by the plant's units, pu
  plimit: number; // dispatch limit for the plant, MW (secondary control keeps the plant at or below it)
}
export interface IslandState {
  id: number; buses: number[]; f: number; slackBus: number; Pgen: number; Pload: number; Hsum: number; // MJ
  converged: boolean; iterations: number; collapsed: boolean; genCap: number; droopK: number; // MW per Hz
  fTrace: number[]; // recent frequency samples (one per physics step)
}

export interface LoadBlock { bus: number; mw: number; mvar: number; label: string }
