/**
 * The console: a read-only, server-rendered view of the boxes. No scripts.
 * Colours are Apple's system palette, light and dark.
 */

import type { Deployment } from "./deployment.ts";
import { CONFIDENCE_LABEL, type ProcessBox, type RefLink } from "./model.ts";
import { formatDuration, type Report } from "./report.ts";
import type { StoredEvent } from "./store.ts";

const STYLE = `
:root {
  --bg: #F2F2F7; --surface: #FFFFFF; --text: #000000; --secondary: #3C3C4399; --separator: #3C3C4329;
  --blue: #007AFF; --red: #FF3B30; --yellow: #FFCC00; --green: #34C759; --fill: #7676801F;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000; --surface: #1C1C1E; --text: #FFFFFF; --secondary: #EBEBF599; --separator: #54545899;
    --blue: #0A84FF; --red: #FF453A; --yellow: #FFD60A; --green: #30D158; --fill: #7676803D;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
h1 { font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 20px; font-weight: 600; margin: 28px 0 10px; }
.muted { color: var(--secondary); }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
.card { background: var(--surface); border-radius: 12px; padding: 16px; margin-bottom: 12px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 0.5px solid var(--separator); white-space: nowrap; }
th { font-size: 12px; font-weight: 600; color: var(--secondary); text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--fill); }
.pill.closed { background: var(--green); color: #fff; }
.pill.open { background: var(--yellow); color: #000; }
.pill.A { background: var(--blue); color: #fff; }
.pill.D { background: var(--red); color: #fff; }
.faster { color: var(--green); font-weight: 600; }
.slower { color: var(--red); font-weight: 600; }
.flow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 17px; }
.flow .box { border: 2px solid var(--blue); border-radius: 10px; padding: 10px 16px; font-weight: 600; }
.note { font-size: 13px; color: var(--secondary); }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function renderConsole(args: { tenantId: string; deployment: Deployment; report: Report; boxes: ProcessBox[] }): string {
  const { report, deployment } = args;
  const labels = new Map(deployment.boxes.map((b) => [b.boxType, b.label]));
  const reportHtml = report.boxTypes
    .map((bt) => {
      const rows = bt.modes
        .filter((m) => m.closed + m.open > 0 || m.mode === "BASELINE")
        .map((m) => {
          const change =
            m.medianChangeVsBaseline === null
              ? ""
              : `<span class="${m.medianChangeVsBaseline < 0 ? "faster" : "slower"}">${m.medianChangeVsBaseline > 0 ? "+" : ""}${Math.round(m.medianChangeVsBaseline * 100)} %</span>`;
          const conf = (["A", "B", "C", "D"] as const)
            .filter((c) => m.byConfidence[c] > 0)
            .map((c) => `<span class="pill ${c}" title="${CONFIDENCE_LABEL[c]}">${c} ${m.byConfidence[c]}</span>`)
            .join(" ");
          return `<tr><td>${m.mode}</td><td>${m.closed}</td><td>${m.open}</td><td>${formatDuration(m.elapsed.medianMs)}</td><td>${formatDuration(m.elapsed.p90Ms)}</td><td>${formatDuration(m.active.medianMs)}</td><td>${change}</td><td>${conf}</td></tr>`;
        })
        .join("");
      const estimates = bt.estimates.length
        ? `<p class="note">Interview estimates (confidence D): ${bt.estimates.map((e) => `${esc(e.label)} ≈ ${formatDuration(e.minutes * 60_000)} (${esc(e.role)})`).join(" · ")}</p>`
        : "";
      return `<div class="card"><h2 style="margin-top:0">${esc(bt.label)}${bt.parent ? ` <span class="muted">inside ${esc(labels.get(bt.parent) ?? bt.parent)}</span>` : ""}</h2>
<table><thead><tr><th>Mode</th><th>Measured</th><th>Open</th><th>Median elapsed</th><th>P90 elapsed</th><th>Median active</th><th>vs baseline</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>${estimates}</div>`;
    })
    .join("");

  const boxRows = args.boxes
    .map(
      (b) =>
        `<tr><td><a href="/console/boxes/${b.id}">${esc(labels.get(b.boxType) ?? b.boxType)}</a></td><td>${b.in ? esc(fmtTime(b.in.at)) : "—"}</td><td>${b.out ? esc(fmtTime(b.out.at)) : "—"}</td><td>${formatDuration(b.elapsedMs)}</td><td>${b.mode}</td><td><span class="pill ${b.status}">${b.status}</span></td><td>${b.confidence ? `<span class="pill ${b.confidence}">${b.confidence}</span>` : ""}</td></tr>`,
    )
    .join("");

  return page(
    "Farai Metrix",
    `<header><h1>Farai Metrix</h1><span class="muted">${esc(args.tenantId)} · ${esc(deployment.name)}</span></header>
${reportHtml}
<p class="note">Elapsed = OUT − IN. Time between active work and elapsed is not waste by default: it can be waiting on the customer, a queue, or legitimate process time.${report.uncorrelatedEvents ? ` ${report.uncorrelatedEvents} event(s) carried no identifier and are not on any job.` : ""}</p>
<h2>Recent boxes</h2>
<div class="card"><table><thead><tr><th>Box</th><th>IN</th><th>OUT</th><th>Elapsed</th><th>Mode</th><th>Status</th><th>Conf.</th></tr></thead><tbody>${boxRows || `<tr><td colspan="7" class="muted">No boxes yet.</td></tr>`}</tbody></table></div>`,
  );
}

export function renderBoxPage(args: {
  tenantId: string;
  deployment: Deployment;
  box: ProcessBox;
  parent: ProcessBox | null;
  children: ProcessBox[];
  refs: RefLink[];
  events: StoredEvent[];
}): string {
  const { box } = args;
  const labels = new Map(args.deployment.boxes.map((b) => [b.boxType, b.label]));
  const label = labels.get(box.boxType) ?? box.boxType;
  const bnd = (b: ProcessBox["in"], name: string) =>
    b
      ? `<div><div class="muted">${name}</div><div>${esc(b.eventType)}</div><div>${esc(fmtTime(b.at))}</div><div><span class="pill ${b.confidence}">${b.confidence} · ${CONFIDENCE_LABEL[b.confidence]}</span> <span class="muted">${esc(b.source)}</span></div></div>`
      : `<div><div class="muted">${name}</div><div>not yet observed</div></div>`;
  const children = args.children.length
    ? `<h2>Inside this box</h2><div class="card"><table><thead><tr><th>Box</th><th>IN</th><th>OUT</th><th>Elapsed</th><th>Active</th></tr></thead><tbody>${[...args.children]
        .sort((a, b) => (a.in?.at ?? "~").localeCompare(b.in?.at ?? "~"))
        .map(
          (c) =>
            `<tr><td><a href="/console/boxes/${c.id}">${esc(labels.get(c.boxType) ?? c.boxType)}</a></td><td>${c.in ? esc(fmtTime(c.in.at)) : "—"}</td><td>${c.out ? esc(fmtTime(c.out.at)) : "—"}</td><td>${formatDuration(c.elapsedMs)}</td><td>${formatDuration(c.activeMs)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";
  const refs = args.refs
    .map((r) => `<tr><td>${esc(r.system)}</td><td>${esc(r.id)}</td><td>${esc(r.method)}${r.score < 1 ? ` (${r.score})` : ""}</td><td class="muted">${esc(r.reason)}</td></tr>`)
    .join("");
  const events = args.events
    .map(
      (e) =>
        `<tr><td>${esc(fmtTime(e.occurredAt))}</td><td>${esc(e.source)}</td><td>${esc(e.eventType)}</td><td>${esc(e.matches.map((m) => `${labels.get(m.boxType) ?? m.boxType}: ${m.role.toUpperCase()}`).join(", "))}</td><td><span class="pill ${e.confidence}">${e.confidence}</span></td></tr>`,
    )
    .join("");
  return page(
    `${label} · Farai Metrix`,
    `<header><h1>${esc(label)}</h1><span class="pill ${box.status}">${box.status}</span><span class="muted">${box.mode}</span><a href="/console">All boxes</a></header>
${args.parent ? `<p>Inside <a href="/console/boxes/${args.parent.id}">${esc(labels.get(args.parent.boxType) ?? args.parent.boxType)}</a></p>` : ""}
<div class="card"><div class="flow">${bnd(box.in, "IN")}<span>→</span><span class="box">${esc(label)} · ${formatDuration(box.elapsedMs)}</span><span>→</span>${bnd(box.out, "OUT")}</div>
${box.activeMs !== null ? `<p>Active work measured: <strong>${formatDuration(box.activeMs)}</strong></p>` : ""}
${box.laterOutCount ? `<p class="note">${box.laterOutCount} later OUT event(s) (revisions or resends) are counted, not measured.</p>` : ""}</div>
${children}
<h2>Identifiers</h2><div class="card"><table><thead><tr><th>System</th><th>Id</th><th>Link</th><th>Reason</th></tr></thead><tbody>${refs}</tbody></table></div>
<h2>Source events</h2><div class="card"><table><thead><tr><th>When</th><th>Source</th><th>Event</th><th>Boundary</th><th>Conf.</th></tr></thead><tbody>${events}</tbody></table></div>`,
  );
}

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
