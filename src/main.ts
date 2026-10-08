/**
 * Farai Metrix service. One process, one SQLite file.
 *
 *   METRIX_TENANTS=tenants.json METRIX_DB=.metrix-data/metrix.sqlite PORT=4000 node src/main.ts
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { Metrix } from "./engine.ts";
import { createApp } from "./http.ts";
import { Store } from "./store.ts";

const config = loadConfig();
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new Store(config.dbPath);
const metrix = new Metrix(store, new Map(config.tenants.map((t) => [t.id, t.deployment])));
const server = createApp({ metrix, store, tenants: config.tenants });

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "metrix_listening",
      port: config.port,
      db: config.dbPath,
      tenants: config.tenants.map((t) => ({ id: t.id, deployment: t.deployment.name, calldash: Boolean(t.calldash) })),
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
