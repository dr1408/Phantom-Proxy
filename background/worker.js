// PhantomProxy — Background Service Worker v1.3.0
// Classic SW (no ES module) for full MV3 + Edge webRequest compatibility
"use strict";

var MAX_REQUESTS       = 500;
var MAX_BODY_BYTES     = 64 * 1024;
var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var ALLOWED_SCHEMES    = ["http:", "https:"];
var ALLOWED_METHODS    = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];

var BLOCKED_HOSTS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./,
  /^::1$/, /^fc00:/i, /^fe80:/i
];

var requestStore  = [];
var requestMap    = {};
var devtoolsPorts = {};
var portCounter   = 0;

// ─── Keep service worker alive while ports connected ──
var keepAliveInterval = null;

function startKeepalive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(function() {
    // ping self to prevent SW termination
    chrome.runtime.getPlatformInfo(function() {});
  }, 25000);
}

function stopKeepalive() {
  if (Object.keys(devtoolsPorts).length === 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ─── Port Connections ─────────────────────────────────
chrome.runtime.onConnect.addListener(function(port) {
  var isDevtools   = port.name.indexOf("phantom-devtools-") === 0;
  var isStandalone = port.name === "phantom-standalone";

  if (!isDevtools && !isStandalone) {
    port.disconnect();
    return;
  }

  var key;

  if (isDevtools) {
    var rawId = port.name.replace("phantom-devtools-", "");
    var tabId = parseInt(rawId, 10);
    if (!isFinite(tabId)) { port.disconnect(); return; }
    key = "devtools_" + tabId;
  } else {
    key = "standalone_" + (++portCounter);
  }

  devtoolsPorts[key] = port;
  startKeepalive();

  port.onMessage.addListener(function(msg) {
    handlePanelMessage(msg, port);
  });

  port.onDisconnect.addListener(function() {
    delete devtoolsPorts[key];
    stopKeepalive();
  });

  // Send existing requests immediately
  port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
});

function broadcastToDevtools(message) {
  Object.keys(devtoolsPorts).forEach(function(key) {
    try { devtoolsPorts[key].postMessage(message); } catch(e) {}
  });
}

// ─── Message Handler ──────────────────────────────────
function handlePanelMessage(msg, port) {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "GET_REQUESTS") {
    port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
    return;
  }

  if (msg.type === "CLEAR_REQUESTS") {
    requestStore = [];
    broadcastToDevtools({ type: "REQUESTS_CLEARED" });
    return;
  }

  if (msg.type === "SEND_REPEATER") {
    var req = msg.request;
    if (!req || typeof req !== "object") return;
    var err = validateRepeaterRequest(req);
    if (err) {
      port.postMessage({
        type: "REPEATER_RESPONSE",
        id: req.id || null,
        result: { success: false, error: "Blocked: " + err }
      });
      return;
    }
    sendRepeaterRequest(req).then(function(result) {
      port.postMessage({ type: "REPEATER_RESPONSE", id: req.id, result: result });
    });
    return;
  }

  if (msg.type === "DELETE_REQUEST") {
    if (typeof msg.id === "string") {
      requestStore = requestStore.filter(function(r) { return r.id !== msg.id; });
      broadcastToDevtools({ type: "REQUEST_DELETED", id: msg.id });
    }
    return;
  }
}

// ─── webRequest Capture ───────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (shouldSkip(details.url)) return;
    var key = details.requestId + "_" + details.tabId;
    requestMap[key] = {
      id:              details.requestId + "_" + Date.now(),
      requestId:       details.requestId,
      url:             details.url,
      method:          sanitizeMethod(details.method),
      timestamp:       Date.now(),
      tabId:           details.tabId,
      type:            sanitizeType(details.type),
      status:          "pending",
      requestBody:     extractBody(details.requestBody),
      requestHeaders:  {},
      responseHeaders: {},
      statusCode:      null,
      duration:        null,
      _start:          Date.now()
    };
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  function(details) {
    var entry = requestMap[details.requestId + "_" + details.tabId];
    if (!entry) return;
    var h = {};
    details.requestHeaders.forEach(function(hdr) {
      var n = sanitizeToken(hdr.name);
      if (n) h[n] = sanitizeValue(hdr.value);
    });
    entry.requestHeaders = h;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    var entry = requestMap[details.requestId + "_" + details.tabId];
    if (!entry) return;
    var h = {};
    details.responseHeaders.forEach(function(hdr) {
      var n = sanitizeToken(hdr.name);
      if (n) h[n] = sanitizeValue(hdr.value);
    });
    entry.responseHeaders = h;
    entry.statusCode = details.statusCode;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  function(details) {
    var key   = details.requestId + "_" + details.tabId;
    var entry = requestMap[key];
    if (!entry) return;
    entry.status     = "complete";
    entry.statusCode = details.statusCode;
    entry.duration   = Date.now() - entry._start;
    delete entry._start;
    finalizeRequest(entry);
    delete requestMap[key];
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    var key   = details.requestId + "_" + details.tabId;
    var entry = requestMap[key];
    if (!entry) return;
    entry.status   = "error";
    entry.error    = sanitizeValue(details.error || "Unknown error");
    entry.duration = Date.now() - (entry._start || Date.now());
    delete entry._start;
    finalizeRequest(entry);
    delete requestMap[key];
  },
  { urls: ["<all_urls>"] }
);

function finalizeRequest(entry) {
  if (requestStore.length >= MAX_REQUESTS) requestStore.shift();
  requestStore.push(entry);
  broadcastToDevtools({ type: "NEW_REQUEST", request: entry });
}

// ─── URL Validation ───────────────────────────────────
function validateURL(url) {
  var parsed;
  try { parsed = new URL(url); } catch(e) { return "Invalid URL"; }
  if (ALLOWED_SCHEMES.indexOf(parsed.protocol) === -1) {
    return "Scheme '" + parsed.protocol + "' not allowed";
  }
  var host = parsed.hostname.toLowerCase();
  for (var i = 0; i < BLOCKED_HOSTS.length; i++) {
    if (BLOCKED_HOSTS[i].test(host)) return "Hostname '" + host + "' is blocked";
  }
  return null;
}

function validateRepeaterRequest(req) {
  if (!req.method || ALLOWED_METHODS.indexOf(req.method.toUpperCase()) === -1) {
    return "Method '" + req.method + "' not allowed";
  }
  return validateURL(req.url);
}

// ─── Repeater Fetch ───────────────────────────────────
async function sendRepeaterRequest(req) {
  var start = Date.now();
  try {
    var method      = req.method.toUpperCase();
    var safeHeaders = {};
    var raw         = req.requestHeaders || {};
    Object.keys(raw).forEach(function(k) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) return;
      var name  = sanitizeToken(k);
      var value = sanitizeValue(raw[k]);
      if (!name) return;
      var lower = name.toLowerCase();
      if (["host","content-length","transfer-encoding","connection"].indexOf(lower) >= 0) return;
      safeHeaders[name] = value;
    });

    var options = { method: method, headers: safeHeaders, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD" && req.requestBody) {
      options.body = req.requestBody.slice(0, MAX_BODY_BYTES);
    }

    var response = await fetch(req.url, options);
    var duration = Date.now() - start;
    var resHeaders = {};
    response.headers.forEach(function(val, key) {
      resHeaders[sanitizeToken(key)] = sanitizeValue(val);
    });

    var body     = "";
    var ct       = response.headers.get("content-type") || "";
    var isText   = ct.indexOf("text") >= 0 || ct.indexOf("json") >= 0 ||
                   ct.indexOf("xml") >= 0  || ct.indexOf("javascript") >= 0;

    if (isText) {
      var reader    = response.body.getReader();
      var chunks    = [];
      var total     = 0;
      var truncated = false;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > MAX_RESPONSE_BYTES) { truncated = true; reader.cancel(); break; }
        chunks.push(chunk.value);
      }
      var dec = new TextDecoder();
      body = chunks.map(function(c) { return dec.decode(c, { stream: true }); }).join("");
      if (truncated) body += "\n\n[... truncated at " + (MAX_RESPONSE_BYTES/1024) + "KB ...]";
    } else {
      body = "[Binary response — not displayed]";
    }

    return {
      success: true, statusCode: response.status, statusText: response.statusText,
      responseHeaders: resHeaders, body: body, duration: duration, size: body.length
    };
  } catch(err) {
    return { success: false, error: err.message, duration: Date.now() - start };
  }
}

// ─── Sanitization ─────────────────────────────────────
var ALLOWED_TYPES = ["main_frame","sub_frame","stylesheet","script","image","font",
  "object","xmlhttprequest","ping","csp_report","media","websocket","other"];

function sanitizeMethod(m) {
  var u = String(m || "").toUpperCase();
  return ALLOWED_METHODS.indexOf(u) >= 0 ? u : "GET";
}
function sanitizeType(t) {
  return ALLOWED_TYPES.indexOf(t) >= 0 ? t : "other";
}
function sanitizeToken(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\r\n\0]/g, "").trim();
}
function sanitizeValue(value) {
  if (typeof value !== "string") return String(value == null ? "" : value);
  return value.replace(/[\r\n\0]/g, " ").trim();
}
function shouldSkip(url) {
  return url.startsWith("chrome-extension://") || url.startsWith("chrome://") ||
         url.startsWith("devtools://") || url.startsWith("about:") ||
         url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("file:");
}
function extractBody(requestBody) {
  if (!requestBody) return null;
  if (requestBody.raw) {
    try {
      var bytes = new Uint8Array(requestBody.raw[0].bytes);
      var slice = bytes.slice(0, MAX_BODY_BYTES);
      var text  = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return bytes.length > MAX_BODY_BYTES ? text + "\n[truncated]" : text;
    } catch(e) { return "[binary body]"; }
  }
  if (requestBody.formData) {
    return Object.keys(requestBody.formData)
      .filter(function(k) { return Object.prototype.hasOwnProperty.call(requestBody.formData, k); })
      .map(function(k) { return encodeURIComponent(k) + "=" + encodeURIComponent(requestBody.formData[k]); })
      .join("&").slice(0, MAX_BODY_BYTES);
  }
  return null;
}
