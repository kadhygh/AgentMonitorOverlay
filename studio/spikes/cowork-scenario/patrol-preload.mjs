// A shorter 巡检 for the scenario's sandbox Hosts, without a switch in the product: the Host's PendingFeature keeps its
// interval in `patrolMs` (PATROL_MS, 2 minutes), which the unit tests set by hand (cowork-matters.test.ts); a Host run as
// its own process cannot be reached that way, so run2.mjs starts it with `node --import <this file>` and this sets the
// field before the patrol starts. Same module instance as the Host's own (same file URL). AMO_SCENARIO_PATROL_MS unset:
// nothing changes.
const ms = Number(process.env.AMO_SCENARIO_PATROL_MS);
if (ms > 0) {
  const { PendingFeature } = await import(new URL("../../packages/host/dist/features/pending/service.js", import.meta.url).href);
  const start = PendingFeature.prototype.start;
  PendingFeature.prototype.start = function patrolSooner(...a) {
    this.patrolMs = ms;
    console.error(`[cowork-scenario] patrol every ${ms} ms`);
    return start.apply(this, a);
  };
}
