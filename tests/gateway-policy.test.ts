import assert from "node:assert/strict";
import test from "node:test";
import { authenticateRole, hasRole, authorizedRecipient, approvedCampaignRecipients, MessageQuota } from "../src/gateway-policy.js";

const tokens = { viewer: "v".repeat(48), operator: "o".repeat(48), admin: "a".repeat(48) };
const groups = new Set(["1234@g.us"]);
const contacts = new Set(["12025550123@s.whatsapp.net"]);

test("Role authentication and privilege order", () => {
  assert.equal(authenticateRole("Bearer " + tokens.admin, tokens), "admin");
  assert.equal(authenticateRole("Bearer " + tokens.viewer, tokens), "viewer");
  assert.equal(authenticateRole("Bearer " + tokens.viewer + "x", tokens), null);
  assert.equal(authenticateRole("Basic abc", tokens), null);
  assert.equal(hasRole("viewer", "admin"), false);
  assert.equal(hasRole("operator", "viewer"), true);
});

test("Explicit destinations; no unauthorized recipient", () => {
  assert.equal(authorizedRecipient("1234@g.us", groups, contacts), true);
  assert.equal(authorizedRecipient("12025550123@s.whatsapp.net", groups, contacts), true);
  assert.equal(authorizedRecipient("9999@g.us", groups, contacts), false);
  assert.equal(authorizedRecipient("12025550124@s.whatsapp.net", groups, contacts), false);
  assert.equal(authorizedRecipient("../oops", groups, contacts), false);
  assert.deepEqual(approvedCampaignRecipients(["1234@g.us","1234@g.us"], contacts, groups, 3), ["1234@g.us"]);
  assert.throws(() => approvedCampaignRecipients(["9999@g.us"], contacts, groups, 3), /explicitly approved/);
  assert.throws(() => approvedCampaignRecipients(["1234@g.us","1234@g.us","1234@g.us","1234@g.us"], contacts, groups, 3));
});

test("Outbound per-minute and per-day limits", () => {
  const q = new MessageQuota(2, 3);
  assert.equal(q.consume(1000000), true);
  assert.equal(q.consume(1000001), true);
  assert.equal(q.consume(1000002), false);
  assert.equal(q.consume(1061002), true);
  assert.equal(q.consume(1061003), false);
  assert.equal(q.consume(1000000 + 86400001), true);
});
