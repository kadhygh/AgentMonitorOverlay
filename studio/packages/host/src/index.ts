import { PROTOCOL_VERSION } from "@amo-studio/protocol";

export * from "./store/store.js";
export { MIGRATIONS } from "./store/migrations.js";

// Host process (runtimes, HTTP/WS API) lands here from S1-06 on.
export const HOST_PROTOCOL_VERSION = PROTOCOL_VERSION;
