import { test, expect } from "@playwright/test";
import { testPool } from "./helpers";

// The test suite's own server never sets OBJECT_STORAGE_* (see
// playwright.config.ts), matching how a fresh/misconfigured production
// deploy would look before the env vars are set on Liara — this is the one
// stage of GET /admin/object-storage/test that's actually reachable without
// real object-storage credentials. The "connect"/"upload" stages (real
// network calls to the configured provider) can only be verified against a
// live bucket, which this environment doesn't have.
test("GET /admin/object-storage/test reports the config stage clearly when no object storage is configured", async ({
  request,
}) => {
  const adminToken = testPool().adminToken;
  const res = await request.get("/api/admin/object-storage/test", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stage).toBe("config");
  expect(body.config.endpointConfigured).toBe(false);
  expect(body.config.bucketConfigured).toBe(false);
  expect(body.config.accessKeyConfigured).toBe(false);
  expect(typeof body.error).toBe("string");
});

test("a non-admin cannot reach the object storage diagnostic route", async ({ request }) => {
  const customerToken = testPool().customers[0].token;
  const res = await request.get("/api/admin/object-storage/test", {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  expect(res.status()).toBe(403);
});
