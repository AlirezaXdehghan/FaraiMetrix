/**
 * The comparison report (spec §7, §12): for each box type, elapsed time per
 * mode, side by side, with the confidence mix and the Discovery estimates.
 *
 * Elapsed time is reported as measured. The gap between elapsed and active
 * time is NOT labelled waste: it may be legitimate waiting, a customer's
 * reply, a queue. The report shows both numbers and lets people read them.
 */

import { MODES, type Confidence, type Estimate, type Mode, type ProcessBox } from "./model.ts";

export interface Distribution {
  count: number;
  medianMs: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  meanMs: number | null;
}

export interface ModeStats {
  mode: Mode;
  closed: number;
  open: number;
  elapsed: Distribution;
  /** Only over boxes the agent timed. */
  active: Distribution;
  byConfidence: Record<Confidence, number>;
  /** Median change against BASELINE, as a fraction (-0.4 = 40 % faster). Null without both medians. */
  medianChangeVsBaseline: number | null;
}

export interface BoxTypeReport {
  boxType: string;
  label: string;
  parent: string | null;
  modes: ModeStats[];
  estimates: Estimate[];
}

export interface Report {
  from: string | null;
  to: string | null;
  boxTypes: BoxTypeReport[];
  /** Events with no identifier: they could not be put on any job. */
  uncorrelatedEvents: number;
}

export function buildReport(args: {
  boxes: ProcessBox[];
  definitions: Array<{ boxType: string; label: string; parent?: string }>;
  estimates: Estimate[];
  uncorrelatedEvents: number;
  from?: string;
  to?: string;
}): Report {
  const boxTypes = args.definitions.map((def) => {
    const ofType = args.boxes.filter((b) => b.boxType === def.boxType);
    const modes = MODES.map((mode) => modeStats(mode, ofType.filter((b) => b.mode === mode)));
    const base = modes[0]!.elapsed.medianMs;
    for (const m of modes) {
      m.medianChangeVsBaseline =
        m.mode !== "BASELINE" && base && m.elapsed.medianMs !== null ? (m.elapsed.medianMs - base) / base : null;
    }
    return {
      boxType: def.boxType,
      label: def.label,
      parent: def.parent ?? null,
      modes,
      estimates: args.estimates.filter((e) => e.boxType === def.boxType),
    };
  });
  return { from: args.from ?? null, to: args.to ?? null, boxTypes, uncorrelatedEvents: args.uncorrelatedEvents };
}

function modeStats(mode: Mode, boxes: ProcessBox[]): ModeStats {
  const closed = boxes.filter((b) => b.status === "closed" && b.elapsedMs !== null);
  const byConfidence: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const b of closed) if (b.confidence) byConfidence[b.confidence] += 1;
  return {
    mode,
    closed: closed.length,
    open: boxes.length - closed.length,
    elapsed: distribution(closed.map((b) => b.elapsedMs!)),
    active: distribution(boxes.flatMap((b) => (b.activeMs === null ? [] : [b.activeMs]))),
    byConfidence,
    medianChangeVsBaseline: null,
  };
}

export function distribution(values: number[]): Distribution {
  if (!values.length) return { count: 0, medianMs: null, p75Ms: null, p90Ms: null, meanMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p75Ms: percentile(sorted, 0.75),
    p90Ms: percentile(sorted, 0.9),
    meanMs: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
  };
}

/** Linear interpolation between closest ranks; exact for the median of an even count. */
export function percentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

/** "2 h 05 min", "3 d 4 h", "45 s". Business readers, not engineers. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
