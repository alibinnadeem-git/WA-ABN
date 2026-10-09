import assert from "node:assert/strict";
import test from "node:test";
import { columnName } from "../src/sheet-columns.js";

test("Google Sheets columns extend correctly beyond Z", () => {
  assert.equal(columnName(1), "A");
  assert.equal(columnName(24), "X");
  assert.equal(columnName(26), "Z");
  assert.equal(columnName(27), "AA");
  assert.equal(columnName(29), "AC");
  assert.equal(columnName(52), "AZ");
  assert.equal(columnName(53), "BA");
});

test("Reject invalid column indices", () => {
  for(const v of [0,-1,1.5,Number.NaN,Number.POSITIVE_INFINITY]) assert.throws(() => columnName(v));
});
