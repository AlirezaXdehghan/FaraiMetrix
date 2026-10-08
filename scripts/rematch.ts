/**
 * After changing a deployment's rules: re-match every stored event and
 * re-measure every job.
 *
 *   node scripts/rematch.ts --tenant brusato
 *
 * Rules on source, event type and attributes are re-evaluated. Subject and
 * filename rules cannot be (that metadata is never stored): re-import the
 * mailbox with `scripts/import-eml.ts --refresh` for those.
 */

import { loadConfig } from "../src/config.ts";
import { Metrix } from "../src/engine.ts";
import { Store } from "../src/store.ts";

const i = process.argv.indexOf("--tenant");
const tenantId = i >= 0 ? process.argv[i + 1] : undefined;
const config = loadConfig();
const tenant = config.tenants.find((t) => t.id === tenantId);
if (!tenant) {
  console.error("usage: node scripts/rematch.ts --tenant <id>");
  process.exit(2);
}
const store = new Store(config.dbPath);
console.log(JSON.stringify(new Metrix(store, new Map([[tenant.id, tenant.deployment]])).rematch(tenant.id)));
store.close();
