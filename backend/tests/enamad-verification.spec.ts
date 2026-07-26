import { test, expect } from "@playwright/test";

// this file used to be a plain static file (public/48471710.txt) — it 404'd
// ("Cannot GET") in production even after a deploy that should have
// included it, most likely a stale container image or an intermediate cache
// still serving the pre-existing 404 for that exact path. Now an explicit
// route (same reasoning as /robots.txt and /sitemap.xml), compiled straight
// into the app rather than depending on a static-file copy step.
test("Enamad domain-ownership verification file is served, empty, at the root", async ({ request }) => {
  const res = await request.get("/48471710.txt");
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("");
  expect(res.headers()["content-type"]).toContain("text/plain");
});

test("Enamad meta tag is present in the raw server-rendered homepage HTML", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<meta name="enamad" content="48471710" />');
});
