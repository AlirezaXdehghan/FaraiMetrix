import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseTenants } from "../src/config.ts";
import { Metrix } from "../src/engine.ts";
import { createApp } from "../src/http.ts";
import { signCallDash } from "../src/sensors/calldash.ts";
import { Store } from "../src/store.ts";
import { envelope, MAILBOX } from "./helpers.ts";

const KEY = "brusato-api-key-0123456789abcdef";
const CONSOLE = "brusato-console-password-012345";
const HOOK_SECRET = "calldash-metrix-secret-0123456789";
const OTHER_KEY = "other-tenant-key-0123456789abcdef";

const tenants = parseTenants(
  {
    tenants: [
      { id: "brusato", deployment: "brusato.json", apiKeys: ["env:BRUSATO_KEY"], consolePassword: CONSOLE, calldash: { secret: HOOK_SECRET, tenantId: "brusato" } },
      { id: "other", deployment: "brusato.json", apiKeys: [OTHER_KEY] },
    ],
  },
  fileURLToPath(new URL("../deployments/", import.meta.url)),
  { BRUSATO_KEY: KEY },
);
const store = new Store(":memory:");
const server = createApp({ metrix: new Metrix(store, new Map(tenants.map((t) => [t.id, t.deployment]))), store, tenants });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  store.close();
});

const post = (path: string, body: unknown, key = KEY) =>
  fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, key = KEY) => fetch(base + path, { headers: { authorization: `Bearer ${key}` } });

function hook(body: string, opts: { secret?: string; ts?: number; tenant?: string } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return fetch(`${base}/hooks/calldash/${opts.tenant ?? "brusato"}`, {
    method: "POST",
    headers: { "x-calldash-signature": signCallDash(opts.secret ?? HOOK_SECRET, body, ts), "x-calldash-timestamp": String(ts), "content-type": "application/json" },
    body,
  });
}

test("the API needs a tenant key", async () => {
  assert.equal((await get("/v1/boxes", "wrong-key")).status, 401);
  assert.equal((await fetch(`${base}/v1/boxes`)).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("CallDash hook → email sensor → closed box, visible in report and console; other tenant sees nothing", async () => {
  const bound = envelope("REQUEST_COMPLETE", "2026-10-09T09:00:00Z", {
    correlationId: "fc_http",
    externalRefs: [{ system: "brusato-quote", id: "500/2026" }],
  });
  const body = JSON.stringify(bound);
  assert.equal((await hook(body, { secret: "wrong-secret-0123456789abcdef" })).status, 401);
  assert.equal((await hook(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, "stale");
  assert.equal((await hook(body, { tenant: "other" })).status, 401, "tenant without a CallDash secret");
  assert.equal((await hook(JSON.stringify({ ...bound, tenantId: "someone-else" }))).status, 403);
  const first = await hook(body);
  assert.equal(first.status, 201);
  const again = await hook(body);
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { duplicate: boolean }).duplicate, true);

  const mail = await post("/v1/email", {
    messageId: "<q500@brusato.example>",
    direction: "outbound",
    mailbox: MAILBOX,
    date: "2026-10-09T10:15:00Z",
    subject: "Preventivo n. 500/2026",
    attachments: ["Preventivo_500_2026.pdf"],
  });
  assert.equal(mail.status, 201);
  const { boxes } = (await mail.json()) as { boxes: Array<{ id: string; boxType: string; elapsedMs: number; status: string }> };
  const q = boxes.find((b) => b.boxType === "quotation")!;
  assert.equal(q.status, "closed");
  assert.equal(q.elapsedMs, 75 * 60_000);

  const detail = (await (await get(`/v1/boxes/${q.id}`)).json()) as { refs: Array<{ system: string }>; events: unknown[] };
  assert.deepEqual(detail.refs.map((r) => r.system).sort(), ["brusato-quote", "calldash-call", "email-message"]);
  assert.equal((await get(`/v1/boxes/${q.id}`, OTHER_KEY)).status, 404, "tenant isolation");

  const job = await get("/v1/jobs?system=brusato-quote&id=500-2026");
  assert.equal(job.status, 200, "lookup by a non-canonical spelling of the quote number");

  const report = (await (await get("/v1/report")).json()) as { boxTypes: Array<{ boxType: string; modes: Array<{ mode: string; closed: number }> }> };
  assert.equal(report.boxTypes.find((b) => b.boxType === "quotation")!.modes[0]!.closed, 1);

  assert.equal((await fetch(`${base}/console`)).status, 401);
  const auth = { authorization: `Basic ${Buffer.from(`brusato:${CONSOLE}`).toString("base64")}` };
  const html = await (await fetch(`${base}/console`, { headers: auth })).text();
  assert.match(html, /Quotation/);
  assert.match(html, /1 h 15 min/);
  const page = await fetch(`${base}/console/boxes/${q.id}`, { headers: auth });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /500\/2026/);
  const otherConsole = { authorization: `Basic ${Buffer.from(`other:${CONSOLE}`).toString("base64")}` };
  assert.equal((await fetch(`${base}/console`, { headers: otherConsole })).status, 401, "other tenant has no console password");
});

test("agent, links and estimates validate their input", async () => {
  assert.equal((await post("/v1/agent", { action: "start", boxType: "nope", ref: { system: "brusato-quote", id: "1/2026" }, eventId: "a1" })).status, 400);
  assert.equal((await post("/v1/agent", { action: "jump", boxType: "quote-preparation", ref: { system: "brusato-quote", id: "1/2026" }, eventId: "a1" })).status, 400);
  const ok = await post("/v1/agent", { action: "start", boxType: "quote-preparation", ref: { system: "brusato-quote", id: "1/2026" }, eventId: "a1", at: "2026-10-09T09:00:00Z" });
  assert.equal(ok.status, 201);

  assert.equal((await post("/v1/links", { refs: [{ system: "a", id: "1" }], reason: "x" })).status, 400);
  assert.equal((await post("/v1/links", { refs: [{ system: "a", id: "1" }, { system: "b", id: "2" }] })).status, 400, "reason required");
  assert.equal((await post("/v1/links", { refs: [{ system: "a", id: "1" }, { system: "b", id: "2" }], reason: "same job", method: "inferred", score: 2 })).status, 400);
  assert.equal((await post("/v1/links", { refs: [{ system: "a", id: "1" }, { system: "b", id: "2" }], reason: "same job" })).status, 201);

  assert.equal((await post("/v1/estimates", { boxType: "quotation", label: "difficult", minutes: -1, role: "estimator" })).status, 400);
  assert.equal((await post("/v1/estimates", { boxType: "quotation", label: "difficult", minutes: 240, role: "estimator" })).status, 201);

  assert.equal((await post("/v1/events", { source: "system", sourceEventId: "a1", eventType: "QUOTE_SENT", occurredAt: "2026-10-09T09:00:00Z", confidence: "A" })).status, 400, "A is only for Farai instruments");
  assert.equal((await post("/v1/events", { source: "calldash", sourceEventId: "c1", eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z" })).status, 400, "CallDash only via its signed hook");
  assert.equal((await post("/v1/events", { source: "manual", sourceEventId: "m1", eventType: "REQUEST_COMPLETE", occurredAt: "2026-10-09T09:00:00Z" })).status, 400, "manual entries must state a confidence");
  assert.equal((await post("/v1/events", { source: "system", sourceEventId: "s1", eventType: "QUOTE_SENT", occurredAt: "not a date" })).status, 400);
  assert.equal((await post("/v1/events", { source: "system", sourceEventId: "s2", eventType: "QUOTE_SENT", occurredAt: "2026-10-09T09:00:00Z", attrs: { body: { nested: true } } })).status, 400);
  const big = await fetch(`${base}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "x".repeat(300 * 1024) });
  assert.equal(big.status, 413);
});

test("tenants file: env secrets, short secrets and shared keys are refused", () => {
  const dir = fileURLToPath(new URL("../deployments/", import.meta.url));
  assert.throws(
    () =>
      parseTenants(
        {
          tenants: [
            { id: "a", deployment: "brusato.json", apiKeys: ["env:MISSING"] },
            { id: "b", deployment: "brusato.json", apiKeys: ["short"] },
            { id: "c", deployment: "brusato.json", apiKeys: [KEY] },
            { id: "d", deployment: "brusato.json", apiKeys: [KEY] },
            { id: "Bad Id", deployment: "brusato.json", apiKeys: [KEY] },
          ],
        },
        dir,
        {},
      ),
    (err: Error) => ["MISSING is not set", "at least 24", "shared with another tenant", "lowercase"].every((s) => err.message.includes(s)),
  );
});
