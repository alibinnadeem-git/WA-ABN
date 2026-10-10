import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { WASocket } from "baileys";
import { audit } from "./audit.js";
import { CampaignManager } from "./campaigns.js";
import { config } from "./config.js";
import { opsSnapshot } from "./ops.js";
import { publishGatewayEvent, recentGatewayEvents, subscribeGatewayEvents } from "./gateway-events.js";
import { filterCrmQueue } from "./filter-runtime.js";
import type { FilterDisposition } from "./filter-classifier.js";
import { authenticateRole, authorizedRecipient, hasRole, MessageQuota, type ApiRole } from "./gateway-policy.js";

type Json = Record<string, unknown>;
function reply(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(payload));
}

function value(x: unknown, field: string, max = 4000): string {
  if (typeof x !== "string" || !x.trim() || x.length > max) throw new Error("Invalid " + field);
  return x.trim();
}

async function readBody(req: IncomingMessage): Promise<Json> {
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new Error("JSON content type required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request exceeds 8 MiB");
    chunks.push(b);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Json;
}

function openapi(): Json {
  return {
    openapi: "3.0.3",
    info: { title: config.appName + " Operations API", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:" + config.advancedApiPort }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    security: [{ bearerAuth: [] }],
    paths: [
      ["GET /v1/status", "Runtime state"],
      ["GET /v1/groups", "Permitted WhatsApp groups"],
      ["GET /v1/campaigns", "Campaign status"],
      ["GET /v1/events/recent", "Recent vendor-local events"],
      ["GET /v1/filter/leads", "Admin: inspect classified Filter CRM leads"],
      ["POST /v1/filter/leads/{id}/decision", "Admin: approve/reject/review classification"],
      ["POST /v1/filter/leads/{id}/dispatch", "Admin: send approved lead to STRATUM CRM"],
      ["GET /v1/events/stream", "Authenticated server-sent event stream"],
      ["POST /v1/integrations/notify", "Authenticated workflow sends an approved notification"],
      ["POST /v1/integrations/events", "Authenticated workflow publishes a vendor-local event"],
      ["POST /v1/messages/text", "Send scoped text"],
      ["POST /v1/messages/media", "Send base64 image, audio, video or PDF (opt-in)"],
      ["POST /v1/messages/poll", "Create poll in permitted group"],
      ["POST /v1/messages/reaction", "React to a message in an authorized destination"],
      ["POST /v1/messages/location", "Send location information to an authorized destination"],
      ["POST /v1/messages/contact", "Share a contact vCard to an authorized destination"],
      ["POST /v1/profile/name", "Admin-change linked-account profile name"],
      ["POST /v1/campaigns", "Create approval-required campaign"],
      ["POST /v1/campaigns/{id}/approve", "Admin-approve campaign"],
      ["POST /v1/campaigns/{id}/pause", "Pause campaign"],
      ["POST /v1/campaigns/{id}/resume", "Resume reviewed campaign"],
      ["POST /v1/campaigns/{id}/cancel", "Cancel campaign"],
      ["POST /v1/groups/{jid}/subject", "Admin-update authorized group subject"],
      ["POST /v1/groups/{jid}/description", "Admin-update authorized group description"],
      ["POST /v1/groups/{jid}/participants", "Admin-manage authorized group participants"],
      ["POST /v1/groups/new", "Admin-create group; operator must then allowlist returned JID"],
      ["POST /v1/groups/join", "Admin-join group; operator must then allowlist returned JID"],
    ].map(([operation, summary]) => {
      const i = operation.indexOf(" ");
      const method = operation.slice(0, i).toLowerCase();
      const path = operation.slice(i + 1);
      return [path, { [method]: { summary, responses: { "200": { description: "Response" } } } }];
    }).reduce((acc, [path, spec]) => {
      Object.assign((acc[path as string] ??= {}), spec);
      return acc;
    }, {} as Record<string, Json>),
  };
}

export function startAdvancedApi(socket: () => WASocket | null): void {
  if (!config.features.advancedApi) return;
  const tokens = {
    viewer: config.advancedViewToken,
    operator: config.advancedOperatorToken,
    admin: config.advancedAdminToken,
  };
  const quota = new MessageQuota(config.advancedPerMinute, config.advancedPerDay);
  const ensureDestination = (jid: unknown): string => {
    const dest = value(jid, "destination", 120);
    if (!authorizedRecipient(dest, config.allowedGroupJids, config.advancedRecipientJids)) throw new Error("Destination is not approved for this vendor");
    return dest;
  };
  const online = (): WASocket => {
    const s = socket();
    if (!s) throw new Error("WhatsApp session not connected");
    return s;
  };
  const sendRaw = async (jid: string, text: string): Promise<void> => {
    ensureDestination(jid);
    await online().sendMessage(jid, { text });
  };
  const campaigns = config.features.campaigns
    ? new CampaignManager(config.advancedCampaignPath, {
        contacts: config.advancedRecipientJids,
        groups: config.allowedGroupJids,
        maxRecipients: config.advancedCampaignMax,
        intervalMs: config.advancedCampaignIntervalMs,
        quota,
        send: sendRaw,
        audit: (event, details) => audit(event, details),
      })
    : null;
  if (campaigns) setInterval(() => { if (socket()) void campaigns.tick().catch((e) => console.error("Campaign dispatch error", e)); }, 2000);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const role = authenticateRole(req.headers.authorization, tokens);
    if (!role) { reply(res, 401, { error: "Unauthorized" }); return; }
    let status = 200;
    try {
      const requireRole = (minimum: ApiRole) => {
        if (!hasRole(role, minimum)) { status = 403; throw new Error("Insufficient privileges"); }
      };
      const requireCampaigns = (): CampaignManager => {
        if (!campaigns) { status = 404; throw new Error("Campaigns disabled"); }
        return campaigns;
      };
      if (req.method === "GET" && url.pathname === "/v1/status") {
        reply(res, 200, { appName: config.appName, runtime: opsSnapshot(), features: { campaigns: Boolean(campaigns), media: config.features.apiMedia, groupAdmin: config.features.groupAdmin } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openapi.json") {
        reply(res, 200, openapi());
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events/recent") {
        if (!config.features.eventStream) { reply(res, 404, { error: "Event stream disabled" }); return; }
        reply(res, 200, { events: recentGatewayEvents(50) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events/stream") {
        if (!config.features.eventStream) { reply(res, 404, { error: "Event stream disabled" }); return; }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        res.write(": vendor event stream connected\n\n");
        const unsubscribe = subscribeGatewayEvents((event) => {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(event) + "\n\n");
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": heartbeat\n\n");
        }, 25000);
        res.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/filter/leads") {
        requireRole("admin"); // Lead data is more sensitive than generic runtime stats.
        const queue = filterCrmQueue();
        if (!queue) { reply(res, 404, { error: "Filter CRM disabled" }); return; }
        const allowed = ["STRATUM_RELATED", "UNRELATED", "NEEDS_REVIEW"];
        const selected = url.searchParams.get("disposition");
        if (selected && !allowed.includes(selected)) throw new Error("Invalid disposition filter");
        const entries = queue.list();
        reply(res, 200, {
          counts: {
            stratumRelated: entries.filter((e) => e.disposition === "STRATUM_RELATED").length,
            unrelated: entries.filter((e) => e.disposition === "UNRELATED").length,
            needsReview: entries.filter((e) => e.disposition === "NEEDS_REVIEW").length,
            delivered: entries.filter((e) => e.delivery === "delivered").length,
          },
          leads: entries.filter((e) => !selected || e.disposition === selected).slice(-200),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/groups") {
        const groups = await Promise.all([...config.allowedGroupJids].map(async (jid) => {
          const meta = await socket()?.groupMetadata(jid).catch(() => null);
          return { jid, subject: meta?.subject ?? null, participants: meta?.participants.length ?? null };
        }));
        reply(res, 200, { groups });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/campaigns") {
        reply(res, 200, { campaigns: requireCampaigns().list() });
        return;
      }
      if (req.method !== "POST") { reply(res, 404, { error: "Not found" }); return; }
      const body = await readBody(req);

      const filterAction = url.pathname.match(new RegExp("^/v1/filter/leads/([a-f0-9-]{36})/(decision|dispatch)$"));
      if (filterAction) {
        requireRole("admin");
        const queue = filterCrmQueue();
        if (!queue) { reply(res, 404, { error: "Filter CRM disabled" }); return; }
        const id = filterAction[1];
        if (filterAction[2] === "decision") {
          const reviewer = value(body.reviewer, "reviewer", 150);
          const note = value(body.note, "note", 500);
          const disposition = value(body.disposition, "disposition", 50) as FilterDisposition;
          const reviewed = queue.decide(id, reviewer, disposition, note);
          audit("filtercrm.reviewed", { leadId: id, disposition, reviewer });
          publishGatewayEvent("filtercrm.reviewed", { id, disposition });
          const result = disposition === "STRATUM_RELATED" && config.filterCrmAutoDispatch
            ? await queue.dispatch(id) : reviewed;
          reply(res, 200, result);
          return;
        }
        const result = await queue.dispatch(id);
        audit("filtercrm.dispatch", { leadId: id, status: result.delivery });
        publishGatewayEvent("filtercrm.dispatched", { id, status: result.delivery });
        reply(res, result.delivery === "failed" ? 502 : 200, result);
        return;
      }

      if (url.pathname === "/v1/integrations/events") {
        requireRole("operator");
        if (!config.features.inboundWorkflows) { reply(res, 404, { error: "Inbound workflows disabled" }); return; }
        const name = value(body.event, "event", 100);
        if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error("Invalid event type");
        const data = body.data;
        if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 4000) throw new Error("Invalid event data");
        publishGatewayEvent("integration." + name, data as Record<string, unknown>);
        audit("advanced.integration_event", { role, event: name });
        reply(res, 202, { accepted: true });
        return;
      }
      if (url.pathname === "/v1/integrations/notify") {
        requireRole("operator");
        if (!config.features.inboundWorkflows) { reply(res, 404, { error: "Inbound workflows disabled" }); return; }
        const jid = ensureDestination(body.jid);
        const text = value(body.text, "text", 4000);
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const sent = await online().sendMessage(jid, { text });
        audit("advanced.integration_notification", { role, destinationType: jid.endsWith("@g.us") ? "group" : "contact" });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/messages/text") {
        requireRole("operator");
        const jid = ensureDestination(body.jid);
        const text = value(body.text, "text");
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const sent = await online().sendMessage(jid, { text });
        audit("advanced.text_sent", { role, destinationType: jid.endsWith("@g.us") ? "group" : "contact" });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/messages/media") {
        requireRole("operator");
        if (!config.features.apiMedia) { reply(res, 404, { error: "Media API disabled" }); return; }
        const jid = ensureDestination(body.jid);
        const mime = value(body.mimeType, "mimeType", 100);
        const b64 = value(body.dataBase64, "dataBase64", 8 * 1024 * 1024);
        const caption = typeof body.caption === "string" ? body.caption.slice(0, 1000) : "";
        if (!/^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg)|video\/mp4|application\/pdf)$/.test(mime)) throw new Error("Unsupported MIME type");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("Malformed base64");
        const bytes = Buffer.from(b64, "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("Media must be 1 byte to 5 MiB");
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const s = online();
        const sent = mime.startsWith("image/") ? await s.sendMessage(jid, { image: bytes, caption, mimetype: mime })
          : mime.startsWith("audio/") ? await s.sendMessage(jid, { audio: bytes, mimetype: mime })
          : mime.startsWith("video/") ? await s.sendMessage(jid, { video: bytes, caption, mimetype: mime })
          : await s.sendMessage(jid, { document: bytes, fileName: "attachment.pdf", mimetype: mime, caption });
        audit("advanced.media_sent", { role, mime });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/messages/poll") {
        requireRole("operator");
        const jid = ensureDestination(body.jid);
        if (!jid.endsWith("@g.us")) throw new Error("Poll destination must be an authorized group");
        const name = value(body.question, "question", 200);
        if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 12) throw new Error("Poll needs 2-12 options");
        const values = body.options.map((v) => value(v, "option", 100));
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const sent = await online().sendMessage(jid, { poll: { name, values, selectableCount: 1 } });
        audit("advanced.poll_created", { role });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/messages/reaction") {
        requireRole("operator");
        const jid = ensureDestination(body.jid);
        const id = value(body.messageId, "messageId", 128);
        const emoji = value(body.emoji, "emoji", 16);
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        await online().sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id, fromMe: body.fromMe === true } } });
        audit("advanced.reaction_sent", { role });
        reply(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/v1/messages/location") {
        requireRole("operator");
        const jid = ensureDestination(body.jid);
        const lat = Number(body.latitude);
        const lon = Number(body.longitude);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("Invalid coordinates");
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const sent = await online().sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lon } });
        audit("advanced.location_sent", { role });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/messages/contact") {
        requireRole("operator");
        const jid = ensureDestination(body.jid);
        const displayName = value(body.displayName, "displayName", 150);
        const vcard = value(body.vcard, "vcard", 4096);
        if (!vcard.startsWith("BEGIN:VCARD") || !vcard.includes("END:VCARD")) throw new Error("Invalid vCard");
        if (!quota.consume()) { reply(res, 429, { error: "Outbound quota reached" }); return; }
        const sent = await online().sendMessage(jid, { contacts: { displayName, contacts: [{ displayName, vcard }] } });
        audit("advanced.contact_shared", { role });
        reply(res, 200, { id: sent?.key.id ?? null });
        return;
      }
      if (url.pathname === "/v1/profile/name") {
        requireRole("admin");
        if (!config.features.groupAdmin) { reply(res, 404, { error: "Account administration disabled" }); return; }
        const name = value(body.name, "name", 100);
        await online().updateProfileName(name);
        audit("advanced.profile_name_changed", { role });
        reply(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/v1/campaigns") {
        requireRole("operator");
        const mgr = requireCampaigns();
        const created = mgr.create({
          name: value(body.name, "name", 120),
          purpose: value(body.purpose, "purpose", 200),
          text: value(body.text, "text"),
          recipients: body.recipients,
          consentAttested: body.consentAttested === true,
        });
        reply(res, 201, created);
        return;
      }
      const campaignAction = url.pathname.match(/^\/v1\/campaigns\/([a-f0-9-]{36})\/(approve|pause|resume|cancel)$/);
      if (campaignAction) {
        requireRole("admin");
        if (campaignAction[2] === "approve" && body.confirm !== "APPROVE_SEND") throw new Error("Approval confirmation required");
        const mgr = requireCampaigns();
        const item = campaignAction[2] === "approve" ? mgr.approve(campaignAction[1])
          : campaignAction[2] === "pause" ? mgr.pause(campaignAction[1])
          : campaignAction[2] === "resume" ? mgr.resume(campaignAction[1])
          : mgr.cancel(campaignAction[1]);
        reply(res, 200, item);
        return;
      }
      if (url.pathname.startsWith("/v1/groups/")) {
        requireRole("admin");
        if (!config.features.groupAdmin) { reply(res, 404, { error: "Group administration disabled" }); return; }
        if (url.pathname === "/v1/groups/new") {
          const subject = value(body.subject, "subject", 100);
          const participants = body.participants;
          if (!Array.isArray(participants) || participants.length < 1 || participants.length > 20
              || participants.some((p) => typeof p !== "string" || !config.advancedRecipientJids.has(p))) throw new Error("Unapproved group participant");
          const created = await online().groupCreate(subject, participants as string[]);
          audit("advanced.group_created", { role });
          reply(res, 201, { id: created.id, authorized: false, note: "Add new group JID to WA_ALLOWED_GROUP_JIDS and restart to authorize processing" });
          return;
        }
        if (url.pathname === "/v1/groups/join") {
          const code = value(body.inviteCode, "inviteCode", 100);
          if (!/^[A-Za-z0-9_-]{10,64}$/.test(code)) throw new Error("Invalid invite code");
          const id = await online().groupAcceptInvite(code);
          audit("advanced.group_joined", { role });
          reply(res, 200, { id, authorized: false, note: "Allowlist group JID and restart before processing messages" });
          return;
        }
        const match = url.pathname.match(/^\/v1\/groups\/([^/]+)\/(subject|description|participants)$/);
        if (!match) { reply(res, 404, { error: "Not found" }); return; }
        const jid = decodeURIComponent(match[1]);
        if (!config.allowedGroupJids.has(jid)) throw new Error("Group not authorized for this vendor");
        if (match[2] === "subject") await online().groupUpdateSubject(jid, value(body.subject, "subject", 100));
        if (match[2] === "description") await online().groupUpdateDescription(jid, value(body.description, "description", 1000));
        if (match[2] === "participants") {
          const action = value(body.action, "action", 20);
          if (!["add", "remove", "promote", "demote"].includes(action)) throw new Error("Invalid group action");
          const participants = body.participants;
          if (!Array.isArray(participants) || !participants.length || participants.length > 20 ||
              participants.some((p) => typeof p !== "string" || !config.advancedRecipientJids.has(p))) throw new Error("Unapproved group participant");
          await online().groupParticipantsUpdate(jid, participants as string[], action as "add" | "remove" | "promote" | "demote");
        }
        audit("advanced.group_updated", { role, action: match[2] });
        reply(res, 200, { ok: true });
        return;
      }
      reply(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      const safe = ["Insufficient privileges"].includes(message) ? message
        : /Invalid|required|disabled|not authorized|not approved|recipient|Campaign|quota|Unsupported|Malformed|Unapproved|Poll|Group|Media|Request|not connected|not found/i.test(message)
        ? message : "Request failed";
      reply(res, status === 403 ? 403 : 400, { error: safe });
      audit("advanced.request_rejected", { role, endpoint: url.pathname, reason: safe });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  server.listen(config.advancedApiPort, config.advancedApiHost, () => {
    console.log(config.appName + " advanced gateway listening on localhost:" + config.advancedApiPort);
  });
}
