const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function readJsonBody(req, options = {}) {
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        req.destroy();
        reject(httpError(413, "body_too_large", "Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw && options.allowEmpty) {
        resolve({});
        return;
      }
      if (!raw) {
        reject(httpError(400, "empty_body", "Request body must be JSON"));
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(httpError(400, "invalid_json", `Invalid JSON: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, statusCode) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "cache-control": "no-store",
    "content-length": "0",
  });
  res.end();
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  CORS_HEADERS,
  httpError,
  readJsonBody,
  sendEmpty,
  sendJson,
};
