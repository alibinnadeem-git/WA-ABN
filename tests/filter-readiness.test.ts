import assert from "node:assert/strict";
import test from "node:test";
import { assessFilterReadiness, type FilterReadinessInput } from "../src/filter-readiness.js";

const baseline: FilterReadinessInput = {
  filterCrmEnabled:true, sheetsCrmEnabled:false, advancedApiEnabled:true,
  groupJids:["123456789-123@g.us"],
  reviewerJids:["12025550100@s.whatsapp.net"],senderJids:["12025550100@s.whatsapp.net"],
  endpoint:"https://stratum-electric-crm.vercel.app/api/integrations/filter-crm/leads",
  endpointHost:"stratum-electric-crm.vercel.app",secretPresent:true,secretLength:48,
  dataWritable:true,aiEnabled:false,aiProviderReady:false,autoDispatch:false
};
test("valid private pilot configuration is ready without AI, DB access or live sends",()=>{
 const result=assessFilterReadiness(baseline);
 assert.equal(result.readyForPairingAndTest,true);
 assert.ok(result.checks.every(c=>c.status==="pass"));
 assert.ok(!JSON.stringify(result).includes("s".repeat(48)));
});
test("missing group, reviewer, signed receiver, volume, or HMAC secret is a blocker",()=>{
 for(const patch of [
  {groupJids:[]},{reviewerJids:[]},{endpoint:"https://evil.example/api/integrations/filter-crm/leads"},
  {endpoint:"http://stratum-electric-crm.vercel.app/api/integrations/filter-crm/leads"},
  {endpoint:"https://stratum-electric-crm.vercel.app/redirect"},
  {secretLength:0,secretPresent:false},{dataWritable:false},
  {reviewerJids:["other@s.whatsapp.net"]},{filterCrmEnabled:false},{sheetsCrmEnabled:true}
 ]){
  const value=assessFilterReadiness({...baseline,...patch});
  assert.equal(value.readyForPairingAndTest,false,JSON.stringify(patch));
 }
});
test("AI is optional and auto dispatch is surfaced as a warning",()=>{
 assert.equal(assessFilterReadiness({...baseline,aiEnabled:true}).readyForPairingAndTest,false);
 const state=assessFilterReadiness({...baseline,autoDispatch:true});
 assert.equal(state.readyForPairingAndTest,true);
 assert.ok(state.checks.some(c=>c.status==="warning"));
});
