const { httpError, readJsonBody, sendJson } = require("../lib/http");
const { identifier } = require("../lib/task-canvas-store");

const WRITE_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:1420", "http://localhost:1420"]);

async function handleTaskCanvasRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/task-canvas") {
    sendJson(res, 200, { board: context.taskCanvasStore.getBoard() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/task-canvas") {
    if (req.headers.origin !== undefined && !WRITE_ORIGINS.has(req.headers.origin)) throw httpError(403, "task_canvas_origin_rejected", "This browser origin cannot modify Task Canvas");
    if ((req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") throw httpError(400, "task_canvas_json_required", "Task Canvas writes require application/json");
    const payload = await readJsonBody(req, { maxBodyBytes: 8 * 1024 * 1024 });
    const board = await context.taskCanvasStore.commit(payload);
    sendJson(res, 200, { board });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/task-canvas/sessions") {
    if (url.searchParams.getAll("ids").length !== 1) throw httpError(400, "invalid_task_canvas_ids", "Provide exactly one ids query parameter");
    // Split CSV before percent decoding so encoded commas remain part of an exact ID.
    let ids;
    try {
      const parameter = url.search.slice(1).split("&").find((part) => decodeURIComponent(part.split("=")[0].replace(/\+/gu, " ")) === "ids");
      const value = parameter.includes("=") ? parameter.slice(parameter.indexOf("=") + 1) : "";
      ids = value === "" ? [] : value.split(",").map((id) => decodeURIComponent(id.replace(/\+/gu, " ")));
    } catch { throw httpError(400, "invalid_task_canvas_ids", "Session IDs contain malformed encoding"); }
    if (ids.length > 500) throw httpError(400, "invalid_task_canvas_ids", "At most 500 session IDs are allowed");
    for (const id of ids) identifier(id, "session ID", 1024);
    const sessions = [...new Set(ids)].map((id) => context.sessions.get(id)).filter(Boolean).map((session) => context.decorateSession(session));
    sendJson(res, 200, { sessions });
    return true;
  }
  return false;
}

module.exports = { handleTaskCanvasRoutes };
