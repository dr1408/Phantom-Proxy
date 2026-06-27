// ═══════════════════════════════════════════════════════
// PHANTOM PROXY — Panel Script (Security-Hardened)
// Audit fixes: CRIT-1,2,4 XSS; HIGH-4 CSS injection;
//              MED-2 curl injection; LOW-1 NaN guard; INFO escapeHtml
// ═══════════════════════════════════════════════════════

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let allRequests    = [];
let selectedRequestId = null;
let captureActive  = true;
let methodFilter   = "ALL";
let statusFilter   = "ALL";
let urlFilter      = "";

let repeaterSessions = [];
let activeSessionId  = null;
let sessionCounter   = 0;

// ─── Allowed value whitelists ─────────────────────────────────────────────────
const ALLOWED_METHODS = new Set(["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"]);
const METHOD_CSS_MAP  = Object.freeze({
  GET:     "method-GET",
  POST:    "method-POST",
  PUT:     "method-PUT",
  DELETE:  "method-DELETE",
  PATCH:   "method-PATCH",
  OPTIONS: "method-OPTIONS",
  HEAD:    "method-HEAD",
});

// ─── Background Connection ────────────────────────────────────────────────────
let bgPort = null;

// Detect standalone mode once — used throughout the file
const IS_STANDALONE = new URLSearchParams(window.location.search).get("mode") === "standalone";

function connectBackground() {
  if (IS_STANDALONE) {
    connectStandaloneBackground();
  } else {
    connectDevtoolsBackground();
  }
}

function connectDevtoolsBackground() {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  bgPort = chrome.runtime.connect({ name: `phantom-devtools-${tabId}` });
  bgPort.onMessage.addListener(handleBgMessage);
  bgPort.onDisconnect.addListener(() => {
    setStatus("Connection lost — reconnecting…");
    setTimeout(connectDevtoolsBackground, 1000);
  });
}

function connectStandaloneBackground() {
  bgPort = chrome.runtime.connect({ name: "phantom-standalone" });
  bgPort.onMessage.addListener(handleBgMessage);
  bgPort.onDisconnect.addListener(() => {
    setStatus("Connection lost — reconnecting…");
    setTimeout(connectStandaloneBackground, 1000);
  });
}

function sendBg(msg) {
  if (bgPort) bgPort.postMessage(msg);
}

function handleBgMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "INIT_REQUESTS":
      allRequests = Array.isArray(msg.requests) ? msg.requests : [];
      renderRequestList();
      break;

    case "NEW_REQUEST":
      if (!captureActive || !msg.request) return;
      const idx = allRequests.findIndex(r => r.requestId === msg.request.requestId);
      if (idx >= 0) {
        allRequests[idx] = msg.request;
        updateRequestRow(msg.request);
      } else {
        allRequests.push(msg.request);
        appendRequestRow(msg.request);
      }
      updateCount();
      break;

    case "REQUESTS_CLEARED":
      allRequests = [];
      selectedRequestId = null;
      renderRequestList();
      showDetailEmpty();
      break;

    case "REQUEST_DELETED":
      allRequests = allRequests.filter(r => r.id !== msg.id);
      if (selectedRequestId === msg.id) { selectedRequestId = null; showDetailEmpty(); }
      renderRequestList();
      break;

    case "REPEATER_RESPONSE":
      handleRepeaterResponse(msg.id, msg.result);
      break;
  }
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

// [INFO] Full 5-entity HTML escape including single quotes
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

// Safe text node — never touches innerHTML
function safeText(str) {
  return document.createTextNode(str == null ? "" : String(str));
}

// [CRIT-4] Safely iterate a headers-like object, guarding prototype keys
function* safeHeaderEntries(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    yield [key, obj[key]];
  }
}

// [MED-2] Shell-safe single-quote escape for cURL output
function shellEscapeSingleQuote(str) {
  return String(str ?? "").replace(/'/g, "'\\''");
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
    btn.classList.add("active");
    const key  = btn.dataset.tab;
    const pane = document.getElementById(`tab-${key}`);
    if (pane) pane.classList.remove("hidden");
  });
});

// ─── Filter Bar ───────────────────────────────────────────────────────────────
document.getElementById("filter-url").addEventListener("input", (e) => {
  urlFilter = e.target.value.trim().toLowerCase();
  renderRequestList();
});

document.querySelectorAll(".method-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".method-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    methodFilter = chip.dataset.method;
    renderRequestList();
  });
});

document.querySelectorAll(".status-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".status-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    statusFilter = chip.dataset.status;
    renderRequestList();
  });
});

// ─── Capture Controls ─────────────────────────────────────────────────────────
document.getElementById("btn-clear").addEventListener("click", () => {
  sendBg({ type: "CLEAR_REQUESTS" });
});

document.getElementById("btn-pause").addEventListener("click", () => {
  captureActive = !captureActive;
  const btn   = document.getElementById("btn-pause");
  const dot   = document.getElementById("pulse-dot");
  const label = document.getElementById("capture-label");
  if (captureActive) {
    btn.textContent   = "⏸ PAUSE";
    dot.classList.remove("paused");
    label.textContent = "CAPTURING";
    label.style.color = "var(--green)";
    setStatus("Capture resumed");
  } else {
    btn.textContent   = "▶ RESUME";
    dot.classList.add("paused");
    label.textContent = "PAUSED";
    label.style.color = "var(--amber)";
    setStatus("Capture paused");
  }
});

// ─── Request List Rendering ───────────────────────────────────────────────────
function getFilteredRequests() {
  return allRequests.filter(req => {
    // Tab filter — only active in standalone mode
    if (IS_STANDALONE) {
      const select = document.getElementById("tab-target-select");
      if (select && select.value !== "all") {
        const targetTabId = parseInt(select.value, 10);
        if (Number.isFinite(targetTabId) && req.tabId !== targetTabId) return false;
      }
    }
    if (methodFilter !== "ALL" && req.method !== methodFilter) return false;
    if (statusFilter !== "ALL") {
      const code = req.statusCode;
      if (statusFilter === "ERR" && req.status !== "error") return false;
      if (statusFilter === "2xx" && !(code >= 200 && code < 300)) return false;
      if (statusFilter === "3xx" && !(code >= 300 && code < 400)) return false;
      if (statusFilter === "4xx" && !(code >= 400 && code < 500)) return false;
      if (statusFilter === "5xx" && !(code >= 500 && code < 600)) return false;
    }
    if (urlFilter && !req.url.toLowerCase().includes(urlFilter)) return false;
    return true;
  });
}

function renderRequestList() {
  const list     = document.getElementById("request-list");
  const filtered = getFilteredRequests();

  if (filtered.length === 0) {
    // Safe empty state — built with DOM, not innerHTML template
    list.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.id = "empty-state";

    const hex = document.createElement("div");
    hex.className = "empty-hex";
    hex.textContent = "⬡";

    const p1 = document.createElement("p");
    p1.textContent = allRequests.length === 0 ? "Waiting for traffic…" : "No requests match filter";

    const p2 = document.createElement("p");
    p2.className = "empty-sub";
    p2.textContent = allRequests.length === 0
      ? "Browse any page to capture HTTP requests"
      : `${allRequests.length} requests filtered out`;

    wrap.append(hex, p1, p2);
    list.appendChild(wrap);
    updateCount();
    return;
  }

  list.innerHTML = "";
  filtered.forEach(req => list.appendChild(makeRequestRow(req)));
  updateCount();
}

// [CRIT-1, CRIT-2, HIGH-4] All dynamic values via textContent + classList.add
function makeRequestRow(req) {
  const row = document.createElement("div");
  row.className = "request-row";
  row.dataset.id = req.id;
  if (req.id === selectedRequestId) row.classList.add("selected");

  const parsed     = tryParseURL(req.url);
  const statusClass = getStatusClass(req);
  const duration   = req.duration ? formatDuration(req.duration) : "—";
  const statusText = req.status === "error" ? "ERR" : (req.statusCode || "…");

  // Method cell — [HIGH-4] use classList.add with whitelisted class name
  const methodSpan = document.createElement("span");
  methodSpan.className = "row-method";
  const methodClass = METHOD_CSS_MAP[req.method] || "method-OTHER";
  methodSpan.classList.add(methodClass);
  methodSpan.textContent = req.method; // [CRIT-1] textContent, not innerHTML

  // Status cell
  const statusSpan = document.createElement("span");
  statusSpan.className = "row-status";
  statusSpan.classList.add(statusClass);
  statusSpan.textContent = String(statusText);

  // URL cell
  const urlSpan = document.createElement("span");
  urlSpan.className = "row-url";
  urlSpan.title = req.url; // safe — title attribute is not executable
  const domainSpan = document.createElement("span");
  domainSpan.className = "row-url-domain";
  domainSpan.textContent = parsed.host; // [CRIT-1] textContent
  const pathText = document.createTextNode(parsed.path);
  urlSpan.append(domainSpan, pathText);

  // Type cell — [CRIT-2] textContent
  const typeSpan = document.createElement("span");
  typeSpan.className = "row-type";
  typeSpan.textContent = req.type || "";

  // Time cell
  const timeSpan = document.createElement("span");
  timeSpan.className = "row-time";
  timeSpan.textContent = duration;

  row.append(methodSpan, statusSpan, urlSpan, typeSpan, timeSpan);
  row.addEventListener("click", () => selectRequest(req.id));
  return row;
}

function appendRequestRow(req) {
  const list  = document.getElementById("request-list");
  const empty = list.querySelector("#empty-state");
  if (empty) empty.remove();
  if (!matchesFilters(req)) return;
  list.appendChild(makeRequestRow(req));
}

function updateRequestRow(req) {
  const existing = document.querySelector(`.request-row[data-id="${CSS.escape(req.id)}"]`);
  if (existing) {
    existing.replaceWith(makeRequestRow(req));
    if (selectedRequestId === req.id) renderDetail(req);
  }
}

function matchesFilters(req) {
  if (methodFilter !== "ALL" && req.method !== methodFilter) return false;
  if (urlFilter && !req.url.toLowerCase().includes(urlFilter)) return false;
  return true;
}

function updateCount() {
  const filtered = getFilteredRequests();
  document.getElementById("request-count").textContent =
    `${filtered.length}${filtered.length !== allRequests.length ? "/" + allRequests.length : ""} requests`;
}

// ─── Request Detail ───────────────────────────────────────────────────────────
function selectRequest(id) {
  selectedRequestId = id;
  document.querySelectorAll(".request-row").forEach(r => {
    r.classList.toggle("selected", r.dataset.id === id);
  });
  const req = allRequests.find(r => r.id === id);
  if (req) renderDetail(req);
}

function showDetailEmpty() {
  document.getElementById("detail-empty").classList.remove("hidden");
  document.getElementById("detail-content").classList.add("hidden");
}

function renderDetail(req) {
  document.getElementById("detail-empty").classList.add("hidden");
  document.getElementById("detail-content").classList.remove("hidden");

  // Method badge — safe via textContent + whitelisted class
  const badge = document.getElementById("detail-method-badge");
  badge.textContent = req.method;
  badge.className   = "";
  badge.classList.add(METHOD_CSS_MAP[req.method] || "method-OTHER");
  badge.style.borderColor = getMethodColor(req.method);

  document.getElementById("detail-url-text").textContent = req.url;

  // Meta pills — all textContent
  const statusClass = getStatusClass(req);
  document.getElementById("meta-status").textContent =
    req.status === "error" ? `ERROR: ${req.error || ""}` : (req.statusCode || "Pending");
  document.getElementById("meta-status").style.color =
    statusClass === "status-2xx" ? "var(--green)"  :
    statusClass === "status-4xx" ? "var(--amber)"  :
    statusClass === "status-5xx" ? "var(--red)"    : "var(--text-secondary)";

  document.getElementById("meta-duration").textContent = req.duration ? formatDuration(req.duration) : "—";
  document.getElementById("meta-type").textContent     = req.type || "—";
  document.getElementById("meta-size").textContent     = "";

  renderKvTable("req-headers-table",  req.requestHeaders  || {});
  document.getElementById("req-body-content").textContent = req.requestBody || "(no body)";
  renderKvTable("res-headers-table",  req.responseHeaders || {});
  document.getElementById("raw-content").textContent = buildRawRequest(req);

  initDetailTabs();
}

// [CRIT-4] Use safeHeaderEntries — prototype-safe iteration, DOM-safe rendering
function renderKvTable(containerId, headers) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  const entries = [...safeHeaderEntries(headers)];

  if (entries.length === 0) {
    const msg = document.createElement("div");
    msg.style.cssText = "color:var(--text-dim);padding:10px;font-family:var(--font-ui)";
    msg.textContent   = "No headers";
    container.appendChild(msg);
    return;
  }

  entries.forEach(([k, v]) => {
    const row  = document.createElement("div");
    row.className = "kv-row";

    const keyEl = document.createElement("span");
    keyEl.className   = "kv-key";
    keyEl.textContent = k;   // textContent — safe

    const valEl = document.createElement("span");
    valEl.className   = "kv-val";
    valEl.textContent = v;   // textContent — safe

    row.append(keyEl, valEl);
    container.appendChild(row);
  });
}

function initDetailTabs() {
  document.querySelectorAll(".dtab").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".dtab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".dtab-pane").forEach(p => p.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(`dtab-${btn.dataset.dtab}`).classList.remove("hidden");
    };
  });
}

// ─── Send to Repeater ─────────────────────────────────────────────────────────
document.getElementById("btn-send-repeater").addEventListener("click", () => {
  const req = allRequests.find(r => r.id === selectedRequestId);
  if (!req) return;
  createRepeaterSession(req);
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
  document.querySelector('[data-tab="repeater"]').classList.add("active");
  document.getElementById("tab-repeater").classList.remove("hidden");
  setStatus(`Request sent to Repeater → ${req.method} ${tryParseURL(req.url).host}`);
});

document.getElementById("btn-copy-curl").addEventListener("click", () => {
  const req = allRequests.find(r => r.id === selectedRequestId);
  if (!req) return;
  navigator.clipboard.writeText(buildCurl(req)).then(() => setStatus("cURL copied to clipboard ✓"));
});

// ─── Repeater Sessions ────────────────────────────────────────────────────────
function createRepeaterSession(req) {
  const id = ++sessionCounter;
  const session = {
    id,
    label:      `#${id} ${req ? req.method : "NEW"}`,
    method:     req ? sanitizeMethodInput(req.method) : "GET",
    url:        req ? req.url : "",
    headers:    req ? Object.assign(Object.create(null), req.requestHeaders) : Object.create(null),
    body:       req ? (req.requestBody || "") : "",
    rawContent: req ? buildRawRequest(req) : "",
    response:   null,
  };
  repeaterSessions.push(session);
  renderSessionTabs();
  activateSession(id);
}

function renderSessionTabs() {
  const bar = document.getElementById("repeater-session-tabs");
  bar.innerHTML = "";
  repeaterSessions.forEach(session => {
    const tab = document.createElement("div");
    tab.className = `session-tab${session.id === activeSessionId ? " active" : ""}`;
    tab.dataset.id = String(session.id);

    // [CRIT-1] textContent for label, not innerHTML
    const labelText = document.createTextNode(session.label);
    const closeBtn  = document.createElement("span");
    closeBtn.className  = "close-tab";
    closeBtn.dataset.id = String(session.id);
    closeBtn.textContent = "✕";

    tab.append(labelText, closeBtn);
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("close-tab")) {
        // [LOW-1] Guard against NaN
        const rawId = parseInt(e.target.dataset.id, 10);
        if (Number.isFinite(rawId)) closeSession(rawId);
      } else {
        activateSession(session.id);
      }
    });
    bar.appendChild(tab);
  });
}

function activateSession(id) {
  activeSessionId = id;
  renderSessionTabs();
  const session = repeaterSessions.find(s => s.id === id);
  if (!session) return;
  loadSessionIntoEditor(session);
}

function closeSession(id) {
  repeaterSessions = repeaterSessions.filter(s => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = repeaterSessions.length > 0
      ? repeaterSessions[repeaterSessions.length - 1].id
      : null;
  }
  renderSessionTabs();
  if (activeSessionId) activateSession(activeSessionId);
  else clearRepeaterEditor();
}

function loadSessionIntoEditor(session) {
  document.getElementById("rep-method").value = session.method;
  document.getElementById("rep-url").value    = session.url;
  document.getElementById("rep-body").value   = session.body;
  document.getElementById("rep-raw").value    = session.rawContent;

  const headersContainer = document.getElementById("headers-editor-rows");
  headersContainer.innerHTML = "";
  for (const [k, v] of safeHeaderEntries(session.headers)) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    addHeaderRow(k, v);
  }

  if (session.response) displayRepeaterResponse(session.response);
  else clearRepeaterResponse();
}

function clearRepeaterEditor() {
  document.getElementById("rep-method").value = "GET";
  document.getElementById("rep-url").value    = "";
  document.getElementById("rep-body").value   = "";
  document.getElementById("rep-raw").value    = "";
  document.getElementById("headers-editor-rows").innerHTML = "";
  clearRepeaterResponse();
}

function saveSessionFromEditor() {
  const session = repeaterSessions.find(s => s.id === activeSessionId);
  if (!session) return;
  session.method     = sanitizeMethodInput(document.getElementById("rep-method").value);
  session.url        = document.getElementById("rep-url").value;
  session.body       = document.getElementById("rep-body").value;
  session.rawContent = document.getElementById("rep-raw").value;
  session.headers    = collectEditorHeaders();
}

document.getElementById("btn-new-repeater").addEventListener("click", () => {
  createRepeaterSession(null);
});

// ─── Header Editor ────────────────────────────────────────────────────────────

// [CRIT-1] Use DOM API — value attribute is safe, but guard with escapeHtml
// for setAttribute contexts just in case
function addHeaderRow(key = "", value = "") {
  const container = document.getElementById("headers-editor-rows");
  const row = document.createElement("div");
  row.className = "header-row";

  const keyInput = document.createElement("input");
  keyInput.type        = "text";
  keyInput.className   = "header-key";
  keyInput.placeholder = "Header-Name";
  keyInput.spellcheck  = false;
  keyInput.value       = key;   // .value assignment is safe — no HTML parsing

  const valInput = document.createElement("input");
  valInput.type        = "text";
  valInput.className   = "header-val";
  valInput.placeholder = "value";
  valInput.spellcheck  = false;
  valInput.value       = value; // safe

  const delBtn = document.createElement("button");
  delBtn.className = "btn-del-header";
  delBtn.title     = "Remove";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", () => row.remove());

  row.append(keyInput, valInput, delBtn);
  container.appendChild(row);
}

document.getElementById("btn-add-header").addEventListener("click", () => addHeaderRow());

function collectEditorHeaders() {
  const headers = Object.create(null);
  document.querySelectorAll(".header-row").forEach(row => {
    const key = row.querySelector(".header-key").value.trim();
    const val = row.querySelector(".header-val").value.trim();
    if (key) headers[key] = val;
  });
  return headers;
}

// ─── Send Request ─────────────────────────────────────────────────────────────
document.getElementById("btn-send-req").addEventListener("click", sendRepeaterRequest);

async function sendRepeaterRequest() {
  const btn = document.getElementById("btn-send-req");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  saveSessionFromEditor();

  const session = repeaterSessions.find(s => s.id === activeSessionId);
  if (!session) { btn.disabled = false; btn.textContent = "▶ SEND"; return; }

  const activeTab = document.querySelector(".rep-etab.active");
  const editorTab = activeTab ? activeTab.dataset.etab : "rep-headers-editor";

  const reqHeaders = Object.assign(Object.create(null), session.headers);
  if (editorTab === "rep-body-editor" && session.body) {
    reqHeaders["Content-Type"] = document.getElementById("body-content-type").value;
  }

  const reqObj = {
    id:             activeSessionId,
    method:         session.method,
    url:            session.url,
    requestHeaders: reqHeaders,
    requestBody:    session.body || null,
  };

  setStatus(`Sending ${reqObj.method} ${reqObj.url}…`);
  sendBg({ type: "SEND_REPEATER", request: reqObj });

  btn.disabled = false;
  btn.textContent = "▶ SEND";
}

function handleRepeaterResponse(sessionId, result) {
  const session = repeaterSessions.find(s => s.id === sessionId);
  if (session) session.response = result;
  if (activeSessionId === sessionId) displayRepeaterResponse(result);

  if (result.success) {
    setStatus(`Response: ${result.statusCode} ${result.statusText} — ${formatDuration(result.duration)} — ${formatSize(result.size)}`);
  } else {
    setStatus(`Request failed: ${result.error}`);
  }
}

function displayRepeaterResponse(result) {
  document.getElementById("response-meta-bar").classList.remove("hidden");

  const statusEl = document.getElementById("rep-meta-status");
  const code     = result.statusCode || 0;
  // [CRIT-3] All via textContent — server-controlled values never reach innerHTML
  statusEl.textContent = result.success
    ? `${code} ${result.statusText || ""}`
    : `ERROR: ${result.error}`;
  statusEl.style.color =
    code >= 200 && code < 300 ? "var(--green)"  :
    code >= 400 && code < 500 ? "var(--amber)"  :
    code >= 500               ? "var(--red)"     : "var(--text-secondary)";

  document.getElementById("rep-meta-duration").textContent = formatDuration(result.duration);
  document.getElementById("rep-meta-size").textContent     = formatSize(result.size || 0);

  const empty  = document.getElementById("rep-response-empty");
  const bodyEl = document.getElementById("rep-response-body");
  empty.classList.add("hidden");
  bodyEl.classList.remove("hidden");
  bodyEl.textContent = result.body || result.error || "(empty response)";  // textContent

  if (result.responseHeaders) renderKvTable("rep-res-headers-table", result.responseHeaders);
}

function clearRepeaterResponse() {
  document.getElementById("response-meta-bar").classList.add("hidden");
  document.getElementById("rep-response-empty").classList.remove("hidden");
  document.getElementById("rep-response-body").classList.add("hidden");
  document.getElementById("rep-res-headers-table").innerHTML = "";
}

// ─── Repeater sub-tabs ────────────────────────────────────────────────────────
document.querySelectorAll(".rep-etab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rep-etab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".rep-etab-pane").forEach(p => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`rep-etab-${btn.dataset.etab}`).classList.remove("hidden");
  });
});

document.querySelectorAll(".rep-rtab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rep-rtab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".rep-rtab-pane").forEach(p => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`rep-rtab-${btn.dataset.rtab}`).classList.remove("hidden");
  });
});

document.getElementById("btn-format-body").addEventListener("click", () => {
  const ta = document.getElementById("rep-body");
  try {
    ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
  } catch {
    setStatus("⚠ Invalid JSON — cannot format");
  }
});

// ─── DECODER ─────────────────────────────────────────────────────────────────
document.getElementById("btn-decode").addEventListener("click", runDecoder);
document.getElementById("btn-decode-chain").addEventListener("click", () => {
  document.getElementById("decoder-input").value  = document.getElementById("decoder-output").value;
  document.getElementById("decoder-output").value = "";
});
document.getElementById("btn-copy-output").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("decoder-output").value)
    .then(() => setStatus("Output copied ✓"));
});
document.getElementById("decode-action").addEventListener("change", (e) => {
  document.getElementById("jwt-inspector")
    .classList.toggle("hidden", e.target.value !== "jwt-decode");
});

function runDecoder() {
  const input  = document.getElementById("decoder-input").value;
  const action = document.getElementById("decode-action").value;
  let output   = "";

  try {
    switch (action) {
      case "b64-decode":
        output = atob(input.trim());
        break;
      case "b64-encode":
        output = btoa(unescape(encodeURIComponent(input)));
        break;
      case "url-decode":
        output = decodeURIComponent(input);
        break;
      case "url-encode":
        output = encodeURIComponent(input);
        break;
      case "html-decode": {
        // [MED-1] Safe: textarea.innerHTML parses entities but doesn't execute JS
        const ta  = document.createElement("textarea");
        ta.innerHTML = input;   // intentional entity decode
        output = ta.value;
        break;
      }
      case "html-encode":
        output = escapeHtml(input);
        break;
      case "hex-encode":
        output = Array.from(input)
          .map(c => c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("");
        break;
      case "hex-decode": {
        const pairs = input.replace(/\s/g, "").match(/.{2}/g);
        if (!pairs) throw new Error("Invalid hex input");
        output = pairs.map(b => String.fromCharCode(parseInt(b, 16))).join("");
        break;
      }
      case "json-format":
        output = JSON.stringify(JSON.parse(input), null, 2);
        break;
      case "jwt-decode":
        output = decodeJWT(input);
        break;
      case "md5":
        output = "(MD5 not available via Web Crypto — use SHA-256 instead)";
        break;
      case "sha256":
        sha256Hash(input).then(h => {
          document.getElementById("decoder-output").value = h;
          setStatus("SHA-256 computed ✓");
        });
        return;
      default:
        output = "Unknown operation";
    }
    document.getElementById("decoder-output").value = output;
    setStatus("Transform applied ✓");
  } catch (e) {
    document.getElementById("decoder-output").value = `ERROR: ${e.message}`;
    setStatus(`Decoder error: ${e.message}`);
  }
}

function decodeJWT(token) {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT — expected 3 parts");

  const decodeB64 = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return JSON.parse(atob(s));
  };

  const header  = decodeB64(parts[0]);
  const payload = decodeB64(parts[1]);

  // [CRIT-1] All via textContent — JWT payload could contain arbitrary strings
  document.getElementById("jwt-header").textContent  = JSON.stringify(header,  null, 2);
  document.getElementById("jwt-payload").textContent = JSON.stringify(payload, null, 2);
  document.getElementById("jwt-sig").textContent     = parts[2];
  document.getElementById("jwt-inspector").classList.remove("hidden");

  const alg     = String(header.alg || "unknown");
  const warnEl  = document.getElementById("jwt-alg-warning");
  document.getElementById("jwt-alg-name").textContent = alg; // textContent

  warnEl.classList.toggle("hidden", alg !== "none" && alg !== "HS256");

  return `Header:\n${JSON.stringify(header, null, 2)}\n\nPayload:\n${JSON.stringify(payload, null, 2)}\n\nSignature:\n${parts[2]}`;
}

async function sha256Hash(input) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeMethodInput(method) {
  const upper = String(method || "").toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : "GET";
}

function tryParseURL(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return { host: "", path: url };
  }
}

function getStatusClass(req) {
  if (req.status === "error")         return "status-err";
  if (!req.statusCode)                return "status-pending";
  if (req.statusCode >= 500)          return "status-5xx";
  if (req.statusCode >= 400)          return "status-4xx";
  if (req.statusCode >= 300)          return "status-3xx";
  if (req.statusCode >= 200)          return "status-2xx";
  return "status-pending";
}

function getMethodColor(method) {
  const colors = {
    GET:     "var(--green)",
    POST:    "var(--cyan)",
    PUT:     "var(--amber)",
    DELETE:  "var(--red)",
    PATCH:   "var(--purple)",
    OPTIONS: "var(--text-secondary)",
    HEAD:    "var(--blue)",
  };
  return colors[method] || "var(--text-secondary)";
}

function formatDuration(ms) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

// [MED-2] Shell-safe cURL builder — escapes single quotes in all fields
function buildCurl(req) {
  let cmd = `curl -X ${shellEscapeSingleQuote(req.method)} '${shellEscapeSingleQuote(req.url)}'`;
  for (const [k, v] of safeHeaderEntries(req.requestHeaders || {})) {
    cmd += ` \\\n  -H '${shellEscapeSingleQuote(k)}: ${shellEscapeSingleQuote(v)}'`;
  }
  if (req.requestBody) {
    cmd += ` \\\n  -d '${shellEscapeSingleQuote(req.requestBody)}'`;
  }
  return cmd;
}

function buildRawRequest(req) {
  const parsed = tryParseURL(req.url);
  let raw = `${req.method} ${parsed.path || "/"} HTTP/1.1\n`;
  raw += `Host: ${parsed.host}\n`;
  for (const [k, v] of safeHeaderEntries(req.requestHeaders || {})) {
    if (k.toLowerCase() !== "host") raw += `${k}: ${v}\n`;
  }
  if (req.requestBody) raw += `\n${req.requestBody}`;
  return raw;
}

function setStatus(msg) {
  document.getElementById("status-msg").textContent = msg;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Standalone mode is detected via IS_STANDALONE (set at module top).
// connectBackground() routes to the correct port based on mode.

// In standalone mode — init UI before connecting
if (IS_STANDALONE) {
  initStandaloneUI();
}

connectBackground();
setStatus("PhantomProxy ready");
createRepeaterSession(null);

// ═══════════════════════════════════════════════════════
// STANDALONE UI INIT
// ═══════════════════════════════════════════════════════

function initStandaloneUI() {
  document.body.classList.add("standalone");

  // Show tab selector bar
  const tabBar = document.getElementById("standalone-tab-bar");
  if (tabBar) tabBar.classList.remove("hidden");

  // Populate tabs dropdown
  populateTabSelector();

  // Refresh tab list button
  const refreshBtn = document.getElementById("btn-refresh-tabs");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", populateTabSelector);
  }

  // Tab selection change — re-render filtered list
  const select = document.getElementById("tab-target-select");
  if (select) {
    select.addEventListener("change", () => {
      renderRequestList();
      const label = select.value === "all"
        ? "Monitoring all tabs"
        : `Monitoring: ${select.options[select.selectedIndex].text}`;
      setStatus(label);
    });
  }
}

function populateTabSelector() {
  const select = document.getElementById("tab-target-select");
  if (!select) return;

  chrome.tabs.query({}, (tabs) => {
    const currentVal = select.value; // preserve selection across refresh
    select.innerHTML = "";

    // All tabs option
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "⬡ All Tabs";
    select.appendChild(allOpt);

    tabs
      .filter(t => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")))
      .forEach(tab => {
        const opt  = document.createElement("option");
        opt.value  = String(tab.id);
        const host = (() => { try { return new URL(tab.url).host; } catch { return tab.url; } })();
        const title = tab.title ? tab.title.slice(0, 45) : host;
        opt.textContent = `[${tab.id}] ${host} — ${title}`;
        select.appendChild(opt);
      });

    // Restore previous selection if still available
    if (currentVal && [...select.options].some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  });
}

// ═══════════════════════════════════════════════════════
// RELOAD NUDGE — works in both DevTools and Standalone
// ═══════════════════════════════════════════════════════

const reloadBtn = document.getElementById("btn-reload-page");
if (reloadBtn) {
  reloadBtn.addEventListener("click", () => {
    if (IS_STANDALONE) {
      // Standalone: reload whichever tab is selected in the dropdown
      const select = document.getElementById("tab-target-select");
      const val    = select ? select.value : "all";

      if (val === "all" || !Number.isFinite(parseInt(val, 10))) {
        // No specific tab selected — prompt user to pick one
        setStatus("⚠ Select a specific tab from the dropdown first, then reload");
        if (select) {
          select.style.borderColor = "var(--amber)";
          setTimeout(() => { select.style.borderColor = ""; }, 2000);
        }
        return;
      }

      const tabId = parseInt(val, 10);
      chrome.tabs.reload(tabId, {}, () => {
        setStatus("Tab reloading — capturing from start…");
        // Clear existing requests for this tab so history starts fresh
        allRequests = allRequests.filter(r => r.tabId !== tabId);
        renderRequestList();
      });

    } else {
      // DevTools mode: reload the inspected tab directly
      chrome.devtools.inspectedWindow.reload({});
      allRequests = [];
      renderRequestList();
      showDetailEmpty();
      setStatus("Page reloading — capturing from start…");
    }
  });
}
