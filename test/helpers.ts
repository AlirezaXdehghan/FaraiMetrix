import { readFileSync } from "node:fs";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { Metrix } from "../src/engine.ts";
import type { SourceEventInput } from "../src/model.ts";
import type { MetrixEnvelope } from "../src/sensors/calldash.ts";
import { Store } from "../src/store.ts";

export const BRUSATO = parseDeployment(JSON.parse(readFileSync(new URL("../deployments/brusato.json", import.meta.url), "utf8")));
export const MAILBOX = "preventivi@brusato.example";

export function setup(deployment: Deployment = BRUSATO, tenants: string[] = ["brusato"]) {
  const store = new Store(":memory:");
  let now = new Date("2026-10-09T08:00:00Z");
  const metrix = new Metrix(store, new Map(tenants.map((t) => [t, deployment])), () => now);
  return {
    store,
    metrix,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

let seq = 0;
export function envelope(eventType: string, occurredAt: string, extra: Partial<MetrixEnvelope> = {}): MetrixEnvelope {
  seq += 1;
  return {
    eventType,
    eventId: `evt_${seq}`,
    occurredAt,
    source: "calldash",
    tenantId: "brusato",
    correlationId: "fc_call1",
    externalRefs: [],
    callId: "call1",
    payload: {},
    ...extra,
  };
}

export function event(partial: Partial<SourceEventInput> & Pick<SourceEventInput, "eventType" | "occurredAt">): SourceEventInput {
  seq += 1;
  return { source: "system", sourceEventId: `sys_${seq}`, confidence: "B", refs: [], attrs: {}, ...partial };
}

export const HOUR = 3_600_000;
