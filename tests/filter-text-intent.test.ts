import assert from "node:assert/strict";
import test from "node:test";
import { passiveLeadFromText } from "../src/filter-text-intent.js";

test("Passive capture recognizes explicit shared lead details",()=>{
 const lead=passiveLeadFromText("Met Jane Smith from a contractor; Company: Example Electrical; email: jane@example.com. Need substation quote.");
 assert.equal(lead?.name,"Jane Smith");
 assert.equal(lead?.company,"Example Electrical");
 assert.equal(lead?.email,"jane@example.com");
});
test("Ordinary chat, stand-alone addresses and unrelated questions are not captured",()=>{
 for(const text of [
 "How is everyone doing?", "My email is jane@example.com", "See you at 2pm",
 "Filter: what do we know about Jane?", "!lead Jane | Example | jane@example.com | |",
 "Here's https://example.com/meeting", "Contact our office tomorrow"
 ]) assert.equal(passiveLeadFromText(text),null);
});
test("Missing person stays unresolved rather than fabricating identity",()=>{
 const lead=passiveLeadFromText("Lead at expo: email sales@example.com, looking for electrical contractor");
 assert.equal(lead?.name,"Unidentified contact");
});

test("Named company lead without email/phone is retained as review-only",()=>{
 const lead = passiveLeadFromText("Met Jane Smith yesterday. Company: Example Electrical; need transformer upgrade.");
 assert.equal(lead?.name,"Jane Smith");
 assert.equal(lead?.company,"Example Electrical");
 assert.equal(lead?.email,"");
 assert.equal(lead?.phone,"");
});
