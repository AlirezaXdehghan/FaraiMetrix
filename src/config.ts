/**
 * Service configuration. The environment names the files; the tenants file
 * lists customers, their deployment and their credentials. A credential may be
 * written inline or as "env:NAME" so the tenants file can be committed to a
 * private ops repo without secrets in it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDeployment, type Deployment } from "./deployment.ts";

export interface TenantConfig {
  id: string;
  deployment: Deployment;
  /** Bearer keys for sensors and the API. */
  apiKeys: string[];
  /** Password for the read-only console (HTTP Basic, user = tenant id). */
  consolePassword?: string;
  /** CallDash webhook secret (CALLDASH_METRIX_SECRET on the CallDash side). */
  calldash?: { secret: string; tenantId?: string };
}

export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  tenants: TenantConfig[];
}

const MIN_SECRET = 24;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT is not a port: "${env.PORT}"`);
  const tenantsPath = resolve(env.METRIX_TENANTS ?? "tenants.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(tenantsPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read METRIX_TENANTS (${tenantsPath}): ${(err as Error).message}`);
  }
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.METRIX_DB ?? ".metrix-data/metrix.sqlite",
    tenants: parseTenants(raw, dirname(tenantsPath), env),
  };
}

export function parseTenants(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv): TenantConfig[] {
  const problems: string[] = [];
  const list = (raw as { tenants?: unknown })?.tenants;
  if (!Array.isArray(list) || list.length === 0) throw new Error("tenants file needs a non-empty `tenants` array");
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const tenants: TenantConfig[] = [];
  for (const [i, t] of (list as Array<Record<string, unknown>>).entries()) {
    const where = `tenants[${i}]`;
    const id = typeof t.id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(t.id) ? t.id : undefined;
    if (!id) {
      problems.push(`${where}.id must be lowercase letters, digits and dashes`);
      continue;
    }
    if (seenIds.has(id)) problems.push(`${where}.id "${id}" is listed twice`);
    seenIds.add(id);

    let deployment: Deployment | undefined;
    if (typeof t.deployment !== "string") problems.push(`${where}.deployment must be a path to a deployment JSON`);
    else {
      try {
        deployment = parseDeployment(JSON.parse(readFileSync(resolve(baseDir, t.deployment), "utf8")));
      } catch (err) {
        problems.push(`${where}.deployment: ${(err as Error).message}`);
      }
    }

    const apiKeys = (Array.isArray(t.apiKeys) ? t.apiKeys : []).map((k, j) => secret(k, `${where}.apiKeys[${j}]`, env, problems));
    if (!apiKeys.length) problems.push(`${where}.apiKeys needs at least one key`);
    for (const k of apiKeys) {
      if (k && seenKeys.has(k)) problems.push(`${where}: an API key is shared with another tenant`);
      seenKeys.add(k);
    }
    const consolePassword = t.consolePassword === undefined ? undefined : secret(t.consolePassword, `${where}.consolePassword`, env, problems);
    let calldash: TenantConfig["calldash"];
    if (t.calldash !== undefined) {
      const c = t.calldash as Record<string, unknown>;
      calldash = {
        secret: secret(c.secret, `${where}.calldash.secret`, env, problems),
        ...(typeof c.tenantId === "string" ? { tenantId: c.tenantId } : {}),
      };
    }
    if (deployment) {
      tenants.push({
        id,
        deployment,
        apiKeys: apiKeys.filter(Boolean),
        ...(consolePassword ? { consolePassword } : {}),
        ...(calldash ? { calldash } : {}),
      });
    }
  }
  if (problems.length) throw new Error(`invalid tenants file:\n  ${problems.join("\n  ")}`);
  return tenants;
}

function secret(value: unknown, where: string, env: NodeJS.ProcessEnv, problems: string[]): string {
  let v = typeof value === "string" ? value : "";
  if (v.startsWith("env:")) {
    const name = v.slice(4);
    v = env[name] ?? "";
    if (!v) {
      problems.push(`${where}: environment variable ${name} is not set`);
      return "";
    }
  }
  if (v.length < MIN_SECRET) {
    problems.push(`${where} must be at least ${MIN_SECRET} characters`);
    return "";
  }
  return v;
}
