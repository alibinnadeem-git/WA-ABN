import assert from "node:assert/strict";
import test from "node:test";
import { classifyStratumLead } from "../src/filter-classifier.js";

const item=(company:string,notes:string)=>({name:"Jane",company,notes,email:"jane@example.com",phone:""});
test("STRATUM project evidence gives explainable candidate, not automatic approval",()=>{
 const d=classifyStratumLead(item("Industrial Projects", "Request quote for substation transformer installation"));
 assert.equal(d.disposition,"STRATUM_RELATED"); assert.ok(d.reasons.length>=2);
});
test("non-electrical clear industry stays in Filter CRM",()=>{
 assert.equal(classifyStratumLead(item("Fashion boutique","Retail fashion boutique")).disposition,"UNRELATED");
});
test("vague construction, facilities or power references do not automatically qualify",()=>{
 for(const lead of [item("General Construction","Met at expo"),item("Facilities","Power"),item("Healthcare Group","New project"),item("Generator Inc","")]){
  assert.equal(classifyStratumLead(lead).disposition,"NEEDS_REVIEW");
 }
});
test("mixed signals require review",()=>{
 assert.equal(classifyStratumLead(item("Wedding photography studio","Substation project")).disposition,"NEEDS_REVIEW");
});
