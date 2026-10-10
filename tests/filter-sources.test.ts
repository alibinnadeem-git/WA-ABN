import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilterSourceRegistry, safeSourceText } from "../src/filter-sources.js";

test("Source metadata stays inside its WhatsApp group and deduplicates",()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"filter-sources-"));
  try {
    const store=new FilterSourceRegistry(path.join(dir,"sources.json"));
    const a=store.record({groupJid:"group-a@g.us",messageId:"m1",senderJid:"person",kind:"document",mimeType:"text/plain",
      fileName:"client.txt",caption:"Lead notes",body:Buffer.from("Need substation work"),extractedText:"Need substation work",processing:"text_indexed"});
    assert.equal(store.record({groupJid:"group-a@g.us",messageId:"m1",senderJid:"person",kind:"document",mimeType:"text/plain",
      fileName:"client.txt",caption:"Lead notes",processing:"metadata_indexed"}).id,a.id);
    assert.equal(store.forGroup("group-b@g.us").length,0);
    assert.equal(store.getForGroup(a.id,"group-b@g.us"),null);
    assert.ok(a.contentHash?.length===64);
    assert.match(store.getForGroup(a.id,"group-a@g.us")?.excerpt ?? "",/substation/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Plain text is inspectable; binary media are not treated as extracted",()=>{
  assert.equal(safeSourceText(Buffer.from("Jane, Example Electrical"),"text/plain"),"Jane, Example Electrical");
  assert.equal(safeSourceText(Buffer.from("%PDF-1.7"),"application/pdf"),null);
  assert.equal(safeSourceText(Buffer.from([0,1,2]),"text/plain"),null);
});
