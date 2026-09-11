const { httpError } = require("./http");
const WRITE_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:1420", "http://localhost:1420"]);
function requireCardJson(req) {
  if (req.headers.origin !== undefined && !WRITE_ORIGINS.has(req.headers.origin)) throw httpError(403, "card_origin_rejected", "This browser origin cannot modify Cards");
  if ((req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") throw httpError(400, "card_json_required", "Card mutations require application/json");
}
function decodeCardId(value) {
  try { return decodeURIComponent(value); } catch { throw httpError(400, "invalid_card", "Invalid card ID encoding"); }
}
module.exports = { requireCardJson, decodeCardId };
