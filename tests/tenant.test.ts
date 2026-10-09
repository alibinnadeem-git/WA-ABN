import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveTenantPaths, validateIsolationId } from "../src/tenant.js";

test("different vendors and sessions have distinct private state and backup paths", () => {
  const a = resolveTenantPaths("/srv/private", "vendor-alpha", "primary");
  const b = resolveTenantPaths("/srv/private", "vendor-beta", "primary");
  const a2 = resolveTenantPaths("/srv/private", "vendor-alpha", "secondary");

  for (const key of ["sessionDir", "authDir", "statePath", "auditPath", "historyPath", "schedulerPath", "retryPath", "backupDir"] as const) {
    assert.notEqual(a[key], b[key]);
    assert.notEqual(a[key], a2[key]);
    assert.equal(a[key].startsWith(a.sessionDir + path.sep) || a[key] === a.sessionDir, true);
    assert.equal(b[key].startsWith(b.sessionDir + path.sep) || b[key] === b.sessionDir, true);
  }
});

test("missing tenant or session fails closed (no legacy shared/default data access)", () => {
  assert.throws(() => resolveTenantPaths("/data", undefined, "primary"), /TENANT_ID/);
  assert.throws(() => resolveTenantPaths("/data", "vendor-a", undefined), /WA_SESSION_ID/);
  assert.throws(() => validateIsolationId("default", "TENANT_ID"), /prohibited/);
  assert.throws(() => validateIsolationId("shared", "TENANT_ID"), /prohibited/);
});

test("tenant and session cannot escape the scoped directory", () => {
  for (const id of ["../alpha", "../", ".", "..", "a/b", "a\\b", "/root", "a%2fb", "ACME", "a b", "", "_hidden", "a.", "x".repeat(65)]) {
    assert.throws(() => validateIsolationId(id, "TENANT_ID"), /TENANT_ID/);
    assert.throws(() => validateIsolationId(id, "WA_SESSION_ID"), /WA_SESSION_ID/);
  }
  assert.equal(validateIsolationId("vendor-01", "TENANT_ID"), "vendor-01");
  assert.equal(validateIsolationId("primary", "WA_SESSION_ID"), "primary");
});
