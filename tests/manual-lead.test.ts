import assert from "node:assert/strict";
import test from "node:test";
import { parseManualLead } from "../src/manual-lead.js";

test("Capture a complete manually entered lead without AI", () => {
  const lead = parseManualLead("Jane Smith | Example Engineering | JANE@EXAMPLE.COM | +1 (415) 555-0123 | Electrical facilities lead");
  assert.deepEqual(lead, {
    name: "Jane Smith",
    company: "Example Engineering",
    email: "jane@example.com",
    phone: "+1 (415) 555-0123",
    notes: "Electrical facilities lead",
  });
});

test("Allow empty email or phone but not both", () => {
  assert.equal(parseManualLead("Jane | Example | | 4155550123 | Met on-site").email, "");
  assert.equal(parseManualLead("Jane | Example | jane@example.com | |").phone, "");
  assert.throws(() => parseManualLead("Jane | Example | | |"), /Either email or phone/);
});

test("Reject malformed or oversized input", () => {
  for (const input of [
    "Jane, Example",
    "Jane | Example | not-an-email | +14155550123 | note",
    "Jane | Example | jane@example.com | 1234 | note",
    "Jane | Example | jane@example.com | |" + "x".repeat(1001),
    " | Example | jane@example.com | |",
  ]) assert.throws(() => parseManualLead(input));
});
