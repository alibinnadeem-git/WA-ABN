import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHmac } from "node:crypto";
import { FilterQueue } from "../src/filter-queue.js";

const host="stratum-electric-crm.vercel.app", endpoint="https://stratum-electric-crm.vercel.app/api/integrations/filter-crm/leads", secret="s".repeat(40);
const lead={name:"Jane Smith",company:"Engineering Services",email:"jane@example.com",phone:"",notes:"Need bid on substation transformer installation",sourceMessageId:"msg1"};
test("unrelated is never sent, related requires reviewer and signed HTTPS URL", async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"filter-crm-"));
 try {
  let calls=0;
  const queue=new FilterQueue(path.join(dir,"queue.json"),{endpoint,allowedHost:host,secret,fetchFn:async(input,opts)=>{
   calls++;
   const timestamp=String((opts?.headers as Record<string,string>)["x-filter-crm-timestamp"]);
   const body=String(opts?.body);
   const signed=(opts?.headers as Record<string,string>)["x-filter-crm-signature"];
   assert.equal(signed,createHmac("sha256",secret).update(timestamp+"."+body).digest("hex"));
   assert.equal(JSON.parse(body).classification.disposition,"STRATUM_RELATED");
   return new Response(JSON.stringify({status:"created",recordId:"record-1"}),{status:201});
  }});
  const staged=queue.stage(lead,"whatsapp");
  assert.equal(staged.disposition,"STRATUM_RELATED");
  assert.equal(queue.stage(lead,"whatsapp").id,staged.id);
  await assert.rejects(()=>queue.dispatch(staged.id),/reviewed/);
  queue.decide(staged.id,"Reviewer JID","STRATUM_RELATED","Confirmed electrical contracting request");
  const delivered=await queue.dispatch(staged.id);
  assert.equal(delivered.delivery,"delivered"); assert.equal(calls,1);
  await queue.dispatch(staged.id); assert.equal(calls,1);
  const unrelated=queue.stage({...lead,sourceMessageId:"msg2",company:"Fashion boutique",notes:"Retail fashion boutique"},"whatsapp");
  assert.equal(unrelated.disposition,"UNRELATED");
  await assert.rejects(()=>queue.dispatch(unrelated.id),/reviewed/);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test("wrong host and ambiguous review are never delivered", async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"filter-crm-"));
 try{
  const q=new FilterQueue(path.join(dir,"queue.json"),{endpoint:"https://evil.example/api/integrations/filter-crm/leads",allowedHost:host,secret});
  const l=q.stage({...lead,sourceMessageId:"new",notes:"Met at event",company:"Facilities"},"whatsapp");
  assert.equal(l.disposition,"NEEDS_REVIEW");
  await assert.rejects(()=>q.dispatch(l.id),/reviewed/);
  q.decide(l.id,"reviewer","STRATUM_RELATED","Verified direct electrical infrastructure need");
  await assert.rejects(()=>q.dispatch(l.id),/Unsafe/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
