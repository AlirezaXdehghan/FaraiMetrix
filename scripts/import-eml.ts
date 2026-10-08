/**
 * Historical import (spec §8, confidence C): read exported .eml files and
 * reconstruct quotation boxes from past email, before any live sensor exists.
 *
 *   node scripts/import-eml.ts --tenant brusato [--refresh] <dir-or-file>...
 *
 * Uses METRIX_TENANTS and METRIX_DB like the service. Only headers and
 * attachment filenames are read; bodies never are. Re-running is safe: each
 * message is keyed by its Message-ID. With --refresh, messages already
 * imported are matched again against the current rules (after a rule change).
 */

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Metrix } from "../src/engine.ts";
import { emlToMetadata, fromEmail, parseEml } from "../src/sensors/email.ts";
import { Store } from "../src/store.ts";

const args = process.argv.slice(2);
const tenantIdx = args.indexOf("--tenant");
const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
const refresh = args.includes("--refresh");
const paths = args.filter((a, i) => i !== tenantIdx && i !== tenantIdx + 1 && a !== "--refresh");
if (!tenantId || !paths.length) {
  console.error("usage: node scripts/import-eml.ts --tenant <id> <dir-or-file>...");
  process.exit(2);
}

const config = loadConfig();
const tenant = config.tenants.find((t) => t.id === tenantId);
if (!tenant) {
  console.error(`unknown tenant "${tenantId}"`);
  process.exit(2);
}
if (!tenant.deployment.mailboxes.length) {
  console.error(`deployment "${tenant.deployment.name}" lists no mailboxes: cannot tell sent from received`);
  process.exit(2);
}

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new Store(config.dbPath);
const metrix = new Metrix(store, new Map([[tenant.id, tenant.deployment]]));

const counts = { files: 0, imported: 0, duplicate: 0, notOurs: 0, unreadable: 0, boundaries: 0 };
for (const file of paths.flatMap(walk)) {
  counts.files += 1;
  const meta = emlToMetadata(parseEml(readFileSync(file, "utf8")), tenant.deployment.mailboxes);
  if (!meta) {
    counts.notOurs += 1;
    continue;
  }
  try {
    const { input, transient } = fromEmail(meta, { confidence: "C", threading: tenant.deployment.emailThreading });
    const r = metrix.ingest(tenant.id, input, transient, { refresh });
    if (r.duplicate) counts.duplicate += 1;
    else counts.imported += 1;
    if (r.event.matches.length) counts.boundaries += 1;
  } catch (err) {
    counts.unreadable += 1;
    console.error(`${file}: ${(err as Error).message}`);
  }
}
store.close();
console.log(JSON.stringify(counts));

function walk(p: string): string[] {
  if (statSync(p).isDirectory()) return readdirSync(p).flatMap((name) => walk(join(p, name)));
  return p.toLowerCase().endsWith(".eml") ? [p] : [];
}
