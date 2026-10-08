import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { opsSnapshot, prometheusMetrics } from "./ops.js";
import { leadSummary, pipelineSummary, searchLeads } from "./sheets.js";
import { historyStats, searchHistory } from "./history.js";
import { listReminders } from "./scheduler.js";
import { listBackups } from "./backup.js";
import { listRetries } from "./retry.js";

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="WA-ABN Ops", charset="UTF-8"',
    "Cache-Control": "no-store",
  });
  res.end("Authentication required");
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (user !== "admin") return false;
  const a = Buffer.from(password);
  const b = Buffer.from(config.opsDashboardToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(JSON.stringify(value));
}

async function recentAudit(limit = 100): Promise<unknown[]> {
  try {
    const raw = await readFile(config.auditPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((line) => {
        try { return JSON.parse(line); } catch { return { event: "malformed-audit-line" }; }
      });
  } catch {
    return [];
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.appName} Ops</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#111827;background:#f3f4f6}
body{margin:0;padding:24px}.wrap{max-width:1200px;margin:auto}
h1{margin:0 0 4px}.sub{color:#6b7280;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 2px #0000000d}
.k{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em}.v{font-size:24px;font-weight:700;margin-top:4px}
section{margin-top:20px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;font-size:12px}
.ok{color:#047857}.bad{color:#b91c1c}
</style>
</head>
<body><div class="wrap">
<h1>${config.appName} Ops</h1><div class="sub">${config.appDescription}</div>
<div id="cards" class="grid"></div>
<section class="card"><h3>Search</h3><input id="q" placeholder="Search CRM/history…"><div id="leads"></div></section>
<section class="card"><h3>Recent security events</h3><div id="audit"></div></section>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function get(url){const r=await fetch(url,{cache:"no-store"});if(!r.ok)throw new Error(r.status);return r.json()}
async function refresh(){
 const [s,a]=await Promise.all([get("/api/status"),get("/api/audit?limit=50")]);
 const c=s.runtime.counters;
 document.getElementById("cards").innerHTML=[
 ["WhatsApp",s.runtime.connection],["Uptime",Math.floor(s.runtime.uptimeSeconds/60)+" min"],
 ["Leads",s.leads?s.leads.total:"Off"],["Hot",s.leads?s.leads.hot:"—"],["Warm",s.leads?s.leads.warm:"—"],
 ["Processed",c.messagesProcessed],["Rejected",c.senderRejected],["Rate limited",c.rateLimited],
 ["Pending",s.runtime.pendingLeads],["Event",s.runtime.currentEvent||"None"]
 ].map(([k,v])=>"<div class=\"card\"><div class=\"k\">"+esc(k)+"</div><div class=\"v\">"+esc(v)+"</div></div>").join("");
 document.getElementById("audit").innerHTML="<table><tr><th>Time</th><th>Event</th><th>Details</th></tr>"+a.map(x=>"<tr><td>"+esc(x.ts)+"</td><td>"+esc(x.event)+"</td><td><pre>"+esc(JSON.stringify(x,null,2))+"</pre></td></tr>").join("")+"</table>";
}
let t;document.getElementById("q").addEventListener("input",e=>{clearTimeout(t);t=setTimeout(async()=>{const q=e.target.value.trim();if(!q){document.getElementById("leads").innerHTML="";return}const rows=await get("/api/search?q="+encodeURIComponent(q));document.getElementById("leads").innerHTML="<pre>"+esc(JSON.stringify(rows,null,2))+"</pre>"},250)});
refresh();setInterval(refresh,15000);
</script></body></html>`;

export function startOpsDashboard(): void {
  if (!config.opsDashboardEnabled) return;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("ok\n");
      return;
    }

    if (!authorized(req)) {
      unauthorized(res);
      return;
    }

    try {
      if (url.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(html);
        return;
      }
      if (url.pathname === "/api/status") {
        json(res, { app: { id: config.appId, name: config.appName, profile: config.profile, sessionId: config.sessionId }, runtime: opsSnapshot(), features: config.features, leads: config.features.leadCrm ? await leadSummary() : null, pipeline: config.features.leadCrm && config.features.pipeline ? await pipelineSummary() : null, history: historyStats(), reminders: listReminders().length, retries: config.features.retryQueue ? listRetries().length : 0, backups: config.features.backups ? listBackups().length : 0 });
        return;
      }
      if (url.pathname === "/api/audit") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        json(res, await recentAudit(Number.isFinite(limit) ? limit : 100));
        return;
      }
      if (url.pathname === "/api/leads") {
        const query = (url.searchParams.get("q") ?? "").trim();
        json(res, config.features.leadCrm && query ? await searchLeads(query, 50) : []);
        return;
      }
      if (url.pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        json(res, {
          crm: config.features.leadCrm && query ? await searchLeads(query, 25) : [],
          history: config.features.messageHistory && query ? searchHistory(query, 25) : [],
        });
        return;
      }
      if (url.pathname === "/api/retries") {
        json(res, config.features.retryQueue ? listRetries() : []);
        return;
      }
      if (url.pathname === "/api/backups") {
        json(res, config.features.backups ? listBackups() : []);
        return;
      }
      if (url.pathname === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
        res.end(prometheusMetrics());
        return;
      }
      json(res, { error: "not found" }, 404);
    } catch (error) {
      json(res, { error: "internal error" }, 500);
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.listen(config.opsDashboardPort, config.opsDashboardHost, () => {
    console.log(`🛡️ WA-ABN Ops dashboard: http://${config.opsDashboardHost}:${config.opsDashboardPort}`);
  });
}
