import assert from "node:assert/strict";
import test from "node:test";
import { answerLeadQuestion, findLead, groupLeads, isQuotedLeadQuestion, parseConversationalQuestion, splitAskArgument } from "../src/filter-whatsapp.js";
import type { FilterEntry } from "../src/filter-queue.js";

function sample(id:string,group:string,name:string): FilterEntry {
 return {
  id, source:"WhatsApp photo", disposition:"STRATUM_RELATED", reasons:["Electrical project signal"], score:0.86,
  classifierVersion:"stratum-rules-v1", createdAt:"2026-10-09T21:00:00Z", delivery:"awaiting_review", attempts:0,
  lead:{ name, company:"Example Electrical",email:"jane@example.com",phone:"",notes:"Medium-voltage transformer request",sourceGroupJid:group,sourceMessageId:"m100:0",capturedAt:"2026-10-09T21:00:00Z" }
 };
}
test("same tenant, separate WhatsApp groups cannot query each other's lead",()=>{
 const a=sample("abcd1234-aaaa-4aaa-aaaa-aaaa00000001","group-a@g.us","Jane");
 const b=sample("abcd1234-bbbb-4bbb-bbbb-bbbb00000002","group-b@g.us","Bob");
 assert.deepEqual(groupLeads([a,b],"group-a@g.us"),[a]);
 assert.equal(findLead([a,b],"group-a@g.us","Bob").match,null);
 assert.equal(findLead([a,b],"group-a@g.us",b.id).match,null);
 assert.equal(findLead([a,b],"group-a@g.us","Jane").match?.id,a.id);
 assert.equal(findLead([a,b],"group-a@g.us","", "m100").match?.id,a.id);
});
test("questions only reflect recorded contact evidence",()=>{
 const a=sample("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa","g@g.us","Jane");
 assert.match(answerLeadQuestion(a,"What is their email?"),/jane@example.com/);
 assert.match(answerLeadQuestion(a,"Why STRATUM?"),/Electrical project signal/);
 assert.match(answerLeadQuestion(a,"Has it been sent to CRM?"),/No confirmed STRATUM CRM record ID/);
 assert.match(answerLeadQuestion(a,"What else do we know?"),/Context:/);
});
test("natural questions need deliberate bot address and never intercept chatter",()=>{
 assert.equal(parseConversationalQuestion("How is everyone doing today?"),null);
 assert.equal(parseConversationalQuestion("Filter: what do we know about Jane?"),"what do we know about Jane?");
 assert.deepEqual(splitAskArgument("Jane | Why is this relevant?"),{lead:"Jane",question:"Why is this relevant?"});
 assert.equal(splitAskArgument("Jane"),null);
});

test("Only quoted questions about an indexed lead wake the WhatsApp bot",()=>{
 assert.equal(isQuotedLeadQuestion("What is their email?",true),true);
 assert.equal(isQuotedLeadQuestion("Why is it relevant?",true),true);
 assert.equal(isQuotedLeadQuestion("What is their email?",false),false);
 assert.equal(isQuotedLeadQuestion("Thanks, let us discuss later",true),false);
 assert.equal(isQuotedLeadQuestion("Hello group?",true),false);
});
