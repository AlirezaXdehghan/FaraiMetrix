import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessBox } from "../src/model.ts";
import { buildReport, distribution, formatDuration, percentile } from "../src/report.ts";

const HOUR = 3_600_000;

function box(mode: ProcessBox["mode"], elapsedHours: number | null, extra: Partial<ProcessBox> = {}): ProcessBox {
  const closed = elapsedHours !== null;
  return {
    id: crypto.randomUUID(),
    tenantId: "t",
    jobId: "j",
    boxType: "quotation",
    parentId: null,
    in: null,
    out: null,
    elapsedMs: closed ? elapsedHours * HOUR : null,
    activeMs: null,
    mode,
    confidence: closed ? "B" : null,
    laterOutCount: 0,
    status: closed ? "closed" : "open",
    updatedAt: "",
    ...extra,
  };
}

test("percentiles interpolate; the median of an even count is the midpoint", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 3); // 2.5 rounds to 3 (ms precision)
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 46);
  assert.deepEqual(distribution([]), { count: 0, medianMs: null, p75Ms: null, p90Ms: null, meanMs: null });
});

test("report compares modes of the same box type against BASELINE", () => {
  const r = buildReport({
    boxes: [
      box("BASELINE", 4),
      box("BASELINE", 6),
      box("BASELINE", null),
      box("ASSISTED", 2),
      box("ASSISTED", 4, { activeMs: 0.5 * HOUR, confidence: "A" }),
    ],
    definitions: [{ boxType: "quotation", label: "Quotation" }],
    estimates: [{ id: "e", tenantId: "t", boxType: "quotation", label: "straightforward", minutes: 120, role: "estimator", recordedAt: "" }],
    uncorrelatedEvents: 2,
  });
  const [q] = r.boxTypes;
  const [base, assisted, automated] = q!.modes;
  assert.equal(base!.closed, 2);
  assert.equal(base!.open, 1);
  assert.equal(base!.elapsed.medianMs, 5 * HOUR);
  assert.equal(assisted!.elapsed.medianMs, 3 * HOUR);
  assert.equal(assisted!.medianChangeVsBaseline, -0.4);
  assert.equal(assisted!.active.medianMs, 0.5 * HOUR);
  assert.deepEqual(assisted!.byConfidence, { A: 1, B: 1, C: 0, D: 0 });
  assert.equal(automated!.medianChangeVsBaseline, null);
  assert.equal(q!.estimates.length, 1);
  assert.equal(r.uncorrelatedEvents, 2);
});

test("durations read like a person wrote them", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(45_000), "45 s");
  assert.equal(formatDuration(25 * 60_000), "25 min");
  assert.equal(formatDuration(2 * HOUR + 5 * 60_000), "2 h 05 min");
  assert.equal(formatDuration(76 * HOUR), "3 d 4 h");
});
