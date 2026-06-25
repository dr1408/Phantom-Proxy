// PhantomProxy — Background Service Worker (Security-Hardened)
// Audit fixes applied: CRIT-5, CRIT-6, HIGH-1, HIGH-2, HIGH-3, MED-3

"use strict";

const MAX_REQUESTS      = 500;
const MAX_BODY_BYTES    = 64 * 1024;        // 64 KB per captured request body
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB max response body in repeater
const ALLOWED_SCHEMES   = ["http:", "https:"];

// ─── Private SSRF block-list (RFC-1918 + link-local + loopback) ───────────────
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,          // link-local / AWS IMDS
  /^::1$/,               // IPv6 loopback
  /^fc00:/i,             // IPv6 ULA
  /^fe80:/i,             // IPv6 link-local
  /^0+$/,                // 0.0.0.0 variants
];

let requestStore = [];
let requestMap   = new Map();    // requestId_tabId -> entry
let devtoolsPorts = new Map();   // tabId -> port

// ─── Port Management ──────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  // [HIGH-1] Validate sender — only accept connections from our own extension
  if (port.sender?.id !== chrome.runtime.id) {
    console.warn("PhantomProxy: rejected connection from unknown sender", port.sender?.id);
    port.disconnect();
    return;
  }

  if (!port.name.startsWith("phantom-devtools-")) return;

  const rawId = port.name.split("phantom-devtools-")[1];
  const tabId = parseInt(rawId, 10);
  if (!Number.isFinite(tabId)) {
    port.disconnect();
    return;
  }

  devtoolsPorts.set(tabId, port);
  port.onMessage.addListener((msg) => handlePanelMessage(msg, port, tabId));
  port.onDisconnect.addListener(() => devtoolsPorts.delete(tabId));

  port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
});

function broadcastToDevtools(message) {
  devtoolsPorts.forEach((port) => {
    try { port.postMessage(message); } catch (_) { /* port disconnected */ }
  });
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handlePanelMessage(msg, port, tabId) {
  if (!msg || typeof msg.type !== "string") return;  // [HIGH-1] type must be string

  switch (msg.type) {
    case "GET_REQUESTS":
      port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
      break;

    case "CLEAR_REQUESTS":
      requestStore = [];
      broadcastToDevtools({ type: "REQUESTS_CLEARED" });
      break;

    case "SEND_REPEATER": {
      // [CRIT-5] Validate request object shape before touching it
      const req = msg.request;
      if (!req || typeof req !== "object") return;

      const validationError = validateRepeaterRequest(req);
      if (validationError) {
        port.postMessage({
          type: "REPEATER_RESPONSE",
          id: req.id ?? null,
          result: { success: false, error: `Blocked: ${validationError}` },
        });
        return;
      }

      const result = await sendRepeaterRequest(req);
      port.postMessage({ type: "REPEATER_RESPONSE", id: req.id, result });
      break;
    }

    case "DELETE_REQUEST":
      if (typeof msg.id === "string") {
        requestStore = requestStore.filter((r) => r.id !== msg.id);
        broadcastToDevtools({ type: "REQUEST_DELETED", id: msg.id });
      }
      break;
  }
}

// ─── URL Validation ───────────────────────────────────────────────────────────

function validateURL(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Invalid URL";
  }

  // [CRIT-5] Only allow http and https
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return `Scheme '${parsed.protocol}' is not allowed (only http/https)`;
  }

  // [CRIT-5] Block private/loopback addresses (SSRF)
  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return `Hostname '${hostname}' is in a blocked range (private/loopback)`;
    }
  }

  return null; // OK
}

// ─── Repeater Request Validation ──────────────────────────────────────────────

const ALLOWED_METHODS = new Set(["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"]);

function validateRepeaterRequest(req) {
  // Method whitelist
  if (typeof req.method !== "string" || !ALLOWED_METHODS.has(req.method.toUpperCase())) {
    return `Method '${req.method}' is not allowed`;
  }

  // URL check
  const urlError = validateURL(req.url);
  if (urlError) return urlError;

  // Headers must be a plain object
  if (req.requestHeaders !== undefined && typeof req.requestHeaders !== "object") {
    return "requestHeaders must be an object";
  }

  return null;
}

// ─── webRequest Interception ──────────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (shouldSkip(details)) return;

    // [MED-3] Composite key to avoid requestId collision across tabs
    const mapKey = `${details.requestId}_${details.tabId}`;

    const entry = {
      id:             `${details.requestId}_${Date.now()}`,
      requestId:      details.requestId,
      mapKey,
      url:            details.url,
      method:         sanitizeMethod(details.method),
      timestamp:      Date.now(),
      tabId:          details.tabId,
      type:           sanitizeType(details.type),
      status:         "pending",
      requestBody:    extractBody(details.requestBody),
      requestHeaders: Object.create(null),
      responseHeaders: Object.create(null),
      statusCode:     null,
      responseBody:   null,
      duration:       null,
      _startTime:     Date.now(),
    };

    requestMap.set(mapKey, entry);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const mapKey = `${details.requestId}_${details.tabId}`;
    const entry  = requestMap.get(mapKey);
    if (!entry) return;

    const headers = Object.create(null);
    details.requestHeaders.forEach((h) => {
      // [CRIT-6] Strip CRLF from header names and values
      const name  = sanitizeHeaderToken(h.name);
      const value = sanitizeHeaderValue(h.value);
      if (name) headers[name] = value;
    });
    entry.requestHeaders = headers;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const mapKey = `${details.requestId}_${details.tabId}`;
    const entry  = requestMap.get(mapKey);
    if (!entry) return;

    const headers = Object.create(null);
    details.responseHeaders.forEach((h) => {
      const name  = sanitizeHeaderToken(h.name);
      const value = sanitizeHeaderValue(h.value);
      if (name) headers[name] = value;
    });
    entry.responseHeaders = headers;
    entry.statusCode      = details.statusCode;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const mapKey = `${details.requestId}_${details.tabId}`;
    const entry  = requestMap.get(mapKey);
    if (!entry) return;

    entry.status    = "complete";
    entry.statusCode = details.statusCode;
    entry.duration  = Date.now() - entry._startTime;
    delete entry._startTime;
    delete entry.mapKey;

    finalizeRequest(entry);
    requestMap.delete(mapKey);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const mapKey = `${details.requestId}_${details.tabId}`;
    const entry  = requestMap.get(mapKey);
    if (!entry) return;

    entry.status   = "error";
    entry.error    = sanitizeHeaderValue(details.error ?? "Unknown error");
    entry.duration = Date.now() - (entry._startTime || Date.now());
    delete entry._startTime;
    delete entry.mapKey;

    finalizeRequest(entry);
    requestMap.delete(mapKey);
  },
  { urls: ["<all_urls>"] }
);

function finalizeRequest(entry) {
  if (requestStore.length >= MAX_REQUESTS) requestStore.shift();
  requestStore.push(entry);
  broadcastToDevtools({ type: "NEW_REQUEST", request: entry });
}

// ─── Repeater ─────────────────────────────────────────────────────────────────

async function sendRepeaterRequest(req) {
  const startTime = Date.now();
  try {
    const method = req.method.toUpperCase();

    // Build sanitized headers — [CRIT-6] strip CRLF from all header k/v
    const safeHeaders = Object.create(null);
    const rawHeaders  = req.requestHeaders || {};

    for (const [k, v] of Object.entries(rawHeaders)) {
      if (!Object.prototype.hasOwnProperty.call(rawHeaders, k)) continue;
      const name  = sanitizeHeaderToken(k);
      const value = sanitizeHeaderValue(v);
      if (!name) continue;

      // Strip headers the browser controls
      const lower = name.toLowerCase();
      if (["host", "content-length", "transfer-encoding", "connection"].includes(lower)) continue;

      safeHeaders[name] = value;
    }

    const options = {
      method,
      headers: safeHeaders,
      redirect: "manual",
      // [HIGH-3] Limit request body size accepted
      ...(method !== "GET" && method !== "HEAD" && req.requestBody
        ? { body: req.requestBody.slice(0, MAX_BODY_BYTES) }
        : {}),
    };

    const response = await fetch(req.url, options);
    const duration = Date.now() - startTime;

    // Collect response headers safely
    const responseHeaders = Object.create(null);
    response.headers.forEach((val, key) => {
      responseHeaders[sanitizeHeaderToken(key)] = sanitizeHeaderValue(val);
    });

    // [HIGH-3] Cap response body size
    let body = "";
    const contentType = response.headers.get("content-type") || "";
    const isText =
      contentType.includes("text") ||
      contentType.includes("json") ||
      contentType.includes("xml")  ||
      contentType.includes("javascript");

    if (isText) {
      const reader  = response.body.getReader();
      const chunks  = [];
      let totalSize = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_BYTES) {
          truncated = true;
          reader.cancel();
          break;
        }
        chunks.push(value);
      }

      const decoder = new TextDecoder();
      body = chunks.map(c => decoder.decode(c, { stream: true })).join("");
      if (truncated) body += `\n\n[... truncated at ${MAX_RESPONSE_BYTES / 1024}KB ...]`;
    } else {
      body = "[Binary response — not displayed]";
    }

    return {
      success:         true,
      statusCode:      response.status,
      statusText:      response.statusText,
      responseHeaders: Object.fromEntries(Object.entries(responseHeaders)),
      body,
      duration,
      size: body.length,
    };
  } catch (err) {
    return {
      success:  false,
      error:    err.message,
      duration: Date.now() - startTime,
    };
  }
}

// ─── Sanitization Helpers ─────────────────────────────────────────────────────

// Whitelist HTTP methods
function sanitizeMethod(method) {
  const upper = String(method || "").toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : "GET";
}

// Whitelist resource types
const ALLOWED_TYPES = new Set([
  "main_frame","sub_frame","stylesheet","script","image","font",
  "object","xmlhttprequest","ping","csp_report","media","websocket","other"
]);
function sanitizeType(type) {
  return ALLOWED_TYPES.has(type) ? type : "other";
}

// [CRIT-6] Strip CR, LF, NUL from header names (RFC 7230 token)
function sanitizeHeaderToken(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\r\n\0]/g, "").trim();
}

// [CRIT-6] Strip CR, LF, NUL from header values
function sanitizeHeaderValue(value) {
  if (typeof value !== "string") return String(value ?? "");
  return value.replace(/[\r\n\0]/g, " ").trim();
}

// ─── Capture Skip List ────────────────────────────────────────────────────────

function shouldSkip(details) {
  const url = details.url;
  return (
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome://")           ||
    url.startsWith("devtools://")         ||
    url.startsWith("about:")              ||
    url.startsWith("data:")               ||
    url.startsWith("blob:")               ||
    url.startsWith("file:")
  );
}

// ─── Body Extraction ─────────────────────────────────────────────────────────

function extractBody(requestBody) {
  if (!requestBody) return null;

  // [HIGH-2] Truncate large bodies
  if (requestBody.raw) {
    try {
      const bytes   = new Uint8Array(requestBody.raw[0].bytes);
      const slice   = bytes.slice(0, MAX_BODY_BYTES);
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const text    = decoder.decode(slice);
      return bytes.length > MAX_BODY_BYTES
        ? text + `\n[... truncated at ${MAX_BODY_BYTES / 1024}KB]`
        : text;
    } catch {
      return "[binary body]";
    }
  }

  if (requestBody.formData) {
    return Object.entries(requestBody.formData)
      .filter(([k]) => Object.prototype.hasOwnProperty.call(requestBody.formData, k))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")
      .slice(0, MAX_BODY_BYTES);
  }

  return null;
}
