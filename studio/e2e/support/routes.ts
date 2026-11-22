import type { Page, Route } from "@playwright/test";

// A request answered by the test once (2026-11-23). `page.route(…, { times: 1 })` takes its route off by itself once
// used, and a request of the page coming just then — any request: while a route is on, Playwright holds every one — failed
// in Playwright (net::ERR_FAILED) while the page's fetch never got an answer. remote-files-mcp.spec.ts 补取 stopped on
// it: the aborted picture asks A again 5 ms later, and that ask hung, so the picture stayed 「正在取」 — 6 of 8 runs on a
// busy machine, the same on master; with the route kept on and counting, 8 of 8 passed. scripts/e2e-routes.test.mjs
// keeps `times` out of the e2e tests.

/** The first request `match` picks is `handle`d; every later one goes on as if this route were not there. */
export async function routeOnce(page: Page, match: (url: URL) => boolean, handle: (route: Route) => unknown): Promise<void> {
  let used = false;
  await page.route(match, async (route) => {
    if (used) return route.fallback();
    used = true;
    await handle(route);
  });
}
