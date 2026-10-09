import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CampaignManager } from "../src/campaigns.js";
import { MessageQuota } from "../src/gateway-policy.js";

test("Campaign cannot send before explicit admin approval", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "campaign-"));
  const sent: string[] = [];
  try {
    const mk = () => new CampaignManager(path.join(dir, "queue.json"), {
      contacts: new Set(["12025550123@s.whatsapp.net"]),
      groups: new Set(["1234@g.us"]),
      maxRecipients: 10, intervalMs: 5000, quota: new MessageQuota(3, 5),
      send: async (jid, text) => { sent.push(jid + ":" + text); },
      audit: () => {},
    });
    const mgr = mk();
    assert.throws(() => mgr.create({ name:"test", purpose:"notice", text:"hello", recipients:["1234@g.us"], consentAttested:false }), /attested/);
    assert.throws(() => mgr.create({ name:"test", purpose:"notice", text:"hello", recipients:["9999@g.us"], consentAttested:true }), /approved/);
    const c = mgr.create({ name:"test", purpose:"service update", text:"hello", recipients:["1234@g.us","12025550123@s.whatsapp.net"], consentAttested:true });
    await mgr.tick(1000000);
    assert.equal(sent.length, 0);
    mgr.approve(c.id);
    await mgr.tick(1000000);
    assert.equal(sent.length, 1);
    await mgr.tick(1000001);
    assert.equal(sent.length, 1);
    await mgr.tick(1005001);
    assert.equal(sent.length, 2);
    assert.equal(mgr.get(c.id).status, "completed");
    assert.equal(mk().get(c.id).status, "completed");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test("A failed send pauses the queue for review; cancel prevents further sends", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "campaign-"));
  try {
    let called = 0;
    const mgr = new CampaignManager(path.join(dir, "queue.json"), {
      contacts: new Set(), groups: new Set(["1234@g.us"]),
      maxRecipients: 2, intervalMs: 1000, quota: new MessageQuota(10,100),
      send: async () => { called++; throw new Error("network offline"); },
      audit: () => {},
    });
    const c = mgr.create({name:"notice",purpose:"update",text:"Hello",recipients:["1234@g.us"],consentAttested:true});
    mgr.approve(c.id);
    await mgr.tick(100);
    assert.equal(mgr.get(c.id).status, "paused");
    await mgr.tick(5000);
    assert.equal(called,1);
    mgr.cancel(c.id);
    await mgr.tick(6000);
    assert.equal(called,1);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
