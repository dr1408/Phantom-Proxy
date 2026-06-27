// PhantomProxy — Panel v1.3.0
// Single clean file — no patches, no appends, no duplicate declarations
"use strict";

// ─── Constants ────────────────────────────────────────
var ALLOWED_METHODS = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];
var METHOD_CSS = {
  GET:"method-GET", POST:"method-POST", PUT:"method-PUT",
  DELETE:"method-DELETE", PATCH:"method-PATCH",
  OPTIONS:"method-OPTIONS", HEAD:"method-HEAD"
};

// ─── State ────────────────────────────────────────────
var allRequests       = [];
var selectedRequestId = null;
var captureActive     = true;
var methodFilter      = "ALL";
var statusFilter      = "ALL";
var urlFilter         = "";
var repeaterSessions  = [];
var activeSessionId   = null;
var sessionCounter    = 0;
var bgPort            = null;

// Pretty print state
var lastRespBody      = "";
var lastRespType      = "";
var wrapOn            = true;

// Detect standalone mode from URL param
var IS_STANDALONE = (new URLSearchParams(window.location.search).get("mode") === "standalone");

// ─── Connection ───────────────────────────────────────
function connectBackground() {
  if (IS_STANDALONE) {
    doConnect("phantom-standalone");
  } else {
    if (!chrome.devtools) { console.error("No chrome.devtools"); return; }
    doConnect("phantom-devtools-" + chrome.devtools.inspectedWindow.tabId);
  }
}

function doConnect(portName) {
  try {
    bgPort = chrome.runtime.connect({ name: portName });
  } catch(e) {
    console.error("PhantomProxy connect failed:", e);
    setTimeout(connectBackground, 2000);
    return;
  }
  bgPort.onMessage.addListener(onBgMessage);
  bgPort.onDisconnect.addListener(function() {
    bgPort = null;
    setStatus("Reconnecting…");
    setTimeout(connectBackground, 1500);
  });
  setStatus("PhantomProxy connected");
}

function sendBg(msg) {
  if (bgPort) {
    try { bgPort.postMessage(msg); }
    catch(e) { console.error("sendBg failed:", e); }
  }
}

// ─── Message Handler (ONE definition only) ────────────
function onBgMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;

  switch(msg.type) {
    case "INIT_REQUESTS":
      allRequests = Array.isArray(msg.requests) ? msg.requests : [];
      renderList();
      break;

    case "NEW_REQUEST":
      if (!captureActive || !msg.request) break;
      var existing = -1;
      for (var i = 0; i < allRequests.length; i++) {
        if (allRequests[i].requestId === msg.request.requestId) { existing = i; break; }
      }
      if (existing >= 0) {
        allRequests[existing] = msg.request;
        updateRow(msg.request);
      } else {
        allRequests.push(msg.request);
        appendRow(msg.request);
      }
      updateCount();
      break;

    case "REQUESTS_CLEARED":
      allRequests = [];
      selectedRequestId = null;
      renderList();
      showDetailEmpty();
      break;

    case "REQUEST_DELETED":
      allRequests = allRequests.filter(function(r) { return r.id !== msg.id; });
      if (selectedRequestId === msg.id) { selectedRequestId = null; showDetailEmpty(); }
      renderList();
      break;

    case "REPEATER_RESPONSE":
      // Route to detail-pretty or repeater depending on id prefix
      if (typeof msg.id === "string" && msg.id.indexOf("dp_") === 0) {
        showDetailPrettyResult(msg.result);
      } else {
        onRepeaterResponse(msg.id, msg.result);
      }
      break;
  }
}

// ─── Tab Navigation ───────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("tab-" + btn.dataset.tab);
    if (pane) pane.classList.remove("hidden");
  });
});

// ─── Filters ──────────────────────────────────────────
document.getElementById("filter-url").addEventListener("input", function(e) {
  urlFilter = e.target.value.trim().toLowerCase();
  renderList();
});

document.querySelectorAll(".method-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    document.querySelectorAll(".method-chip").forEach(function(c) { c.classList.remove("active"); });
    chip.classList.add("active");
    methodFilter = chip.dataset.method;
    renderList();
  });
});

document.querySelectorAll(".status-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    document.querySelectorAll(".status-chip").forEach(function(c) { c.classList.remove("active"); });
    chip.classList.add("active");
    statusFilter = chip.dataset.status;
    renderList();
  });
});

// ─── Capture Controls ─────────────────────────────────
document.getElementById("btn-clear").addEventListener("click", function() {
  sendBg({ type: "CLEAR_REQUESTS" });
});

document.getElementById("btn-pause").addEventListener("click", function() {
  captureActive = !captureActive;
  var btn = document.getElementById("btn-pause");
  var dot = document.getElementById("pulse-dot");
  var lbl = document.getElementById("capture-label");
  if (captureActive) {
    btn.textContent = "⏸ PAUSE";
    dot.classList.remove("paused");
    lbl.textContent = "CAPTURING";
    lbl.style.color = "var(--green)";
  } else {
    btn.textContent = "▶ RESUME";
    dot.classList.add("paused");
    lbl.textContent = "PAUSED";
    lbl.style.color = "var(--amber)";
  }
});

// ─── Filtering Logic ──────────────────────────────────
function getFiltered() {
  return allRequests.filter(function(req) {
    // Tab filter (standalone only)
    if (IS_STANDALONE) {
      var sel = document.getElementById("tab-target-select");
      if (sel && sel.value !== "all") {
        var tid = parseInt(sel.value, 10);
        if (isFinite(tid) && req.tabId !== tid) return false;
      }
    }
    if (methodFilter !== "ALL" && req.method !== methodFilter) return false;
    if (statusFilter !== "ALL") {
      var c = req.statusCode;
      if (statusFilter === "ERR" && req.status !== "error") return false;
      if (statusFilter === "2xx" && !(c >= 200 && c < 300)) return false;
      if (statusFilter === "3xx" && !(c >= 300 && c < 400)) return false;
      if (statusFilter === "4xx" && !(c >= 400 && c < 500)) return false;
      if (statusFilter === "5xx" && !(c >= 500 && c < 600)) return false;
    }
    if (urlFilter && req.url.toLowerCase().indexOf(urlFilter) < 0) return false;
    return true;
  });
}

// ─── Request List ─────────────────────────────────────
function renderList() {
  var list     = document.getElementById("request-list");
  var filtered = getFiltered();
  list.innerHTML = "";

  if (filtered.length === 0) {
    var wrap   = document.createElement("div");
    wrap.id    = "empty-state";
    var hex    = document.createElement("div");
    hex.className = "empty-hex";
    hex.textContent = "⬡";
    var p1     = document.createElement("p");
    p1.textContent = allRequests.length === 0 ? "Waiting for traffic…" : "No requests match filter";
    var p2     = document.createElement("p");
    p2.className = "empty-sub";
    p2.textContent = allRequests.length === 0
      ? "Requests made before opening this panel are not captured"
      : allRequests.length + " requests filtered out";
    var rb     = document.createElement("button");
    rb.className = "reload-nudge-btn";
    rb.innerHTML = "<span class='reload-icon'>⟳</span> RELOAD PAGE TO CAPTURE FROM START";
    rb.addEventListener("click", doReload);
    wrap.append(hex, p1, p2, rb);
    list.appendChild(wrap);
    updateCount();
    return;
  }

  filtered.forEach(function(req) { list.appendChild(makeRow(req)); });
  updateCount();
}

function makeRow(req) {
  var row = document.createElement("div");
  row.className = "request-row";
  row.dataset.id = req.id;
  if (req.id === selectedRequestId) row.classList.add("selected");

  var p   = parseURL(req.url);
  var sc  = statusClass(req);
  var dur = req.duration ? fmtDuration(req.duration) : "—";
  var st  = req.status === "error" ? "ERR" : (req.statusCode || "…");

  var m = el("span", "row-method " + (METHOD_CSS[req.method] || "method-OTHER"), req.method);
  var s = el("span", "row-status " + sc, String(st));
  var u = document.createElement("span");
  u.className = "row-url"; u.title = req.url;
  u.appendChild(el("span","row-url-domain", p.host));
  u.appendChild(txt(p.path));
  var t = el("span","row-type", req.type || "");
  var d = el("span","row-time", dur);

  row.append(m, s, u, t, d);
  row.addEventListener("click", function() { selectReq(req.id); });
  return row;
}

function appendRow(req) {
  var list = document.getElementById("request-list");
  var emp  = list.querySelector("#empty-state");
  if (emp) emp.remove();
  if (!matchFilter(req)) return;
  list.appendChild(makeRow(req));
}

function updateRow(req) {
  var old = document.querySelector(".request-row[data-id=\"" + CSS.escape(req.id) + "\"]");
  if (old) {
    old.replaceWith(makeRow(req));
    if (selectedRequestId === req.id) renderDetail(req);
  }
}

function matchFilter(req) {
  if (methodFilter !== "ALL" && req.method !== methodFilter) return false;
  if (urlFilter && req.url.toLowerCase().indexOf(urlFilter) < 0) return false;
  return true;
}

function updateCount() {
  var f = getFiltered();
  document.getElementById("request-count").textContent =
    f.length + (f.length !== allRequests.length ? "/" + allRequests.length : "") + " requests";
}

// ─── Detail Pane ──────────────────────────────────────
function selectReq(id) {
  selectedRequestId = id;
  document.querySelectorAll(".request-row").forEach(function(r) {
    r.classList.toggle("selected", r.dataset.id === id);
  });
  var req = allRequests.find(function(r) { return r.id === id; });
  if (req) renderDetail(req);
}

function showDetailEmpty() {
  document.getElementById("detail-empty").classList.remove("hidden");
  document.getElementById("detail-content").classList.add("hidden");
}

function renderDetail(req) {
  document.getElementById("detail-empty").classList.add("hidden");
  document.getElementById("detail-content").classList.remove("hidden");

  var badge = document.getElementById("detail-method-badge");
  badge.textContent = req.method;
  badge.className = METHOD_CSS[req.method] || "method-OTHER";
  badge.style.borderColor = methodColor(req.method);
  document.getElementById("detail-url-text").textContent = req.url;

  var sc = statusClass(req);
  var sm = document.getElementById("meta-status");
  sm.textContent = req.status === "error" ? "ERROR: " + (req.error||"") : (req.statusCode||"Pending");
  sm.style.color = sc==="status-2xx"?"var(--green)":sc==="status-4xx"?"var(--amber)":sc==="status-5xx"?"var(--red)":"var(--text-secondary)";
  document.getElementById("meta-duration").textContent = req.duration ? fmtDuration(req.duration) : "—";
  document.getElementById("meta-type").textContent = req.type || "—";
  document.getElementById("meta-size").textContent = "";

  renderKV("req-headers-table", req.requestHeaders || {});
  document.getElementById("req-body-content").textContent = req.requestBody || "(no body)";
  renderKV("res-headers-table", req.responseHeaders || {});
  document.getElementById("raw-content").textContent = buildRaw(req);

  // Reset detail sub-tabs to first tab
  document.querySelectorAll(".dtab").forEach(function(b) { b.classList.remove("active"); });
  document.querySelectorAll(".dtab-pane").forEach(function(p) { p.classList.add("hidden"); });
  document.querySelector(".dtab").classList.add("active");
  document.querySelector(".dtab-pane").classList.remove("hidden");

  // Re-init detail tab clicks
  document.querySelectorAll(".dtab").forEach(function(btn) {
    btn.onclick = function() {
      document.querySelectorAll(".dtab").forEach(function(b) { b.classList.remove("active"); });
      document.querySelectorAll(".dtab-pane").forEach(function(p) { p.classList.add("hidden"); });
      btn.classList.add("active");
      var pane = document.getElementById("dtab-" + btn.dataset.dtab);
      if (pane) pane.classList.remove("hidden");
      if (btn.dataset.dtab === "res-pretty") fetchDetailPretty(req);
    };
  });
}

function renderKV(id, obj) {
  var c = document.getElementById(id);
  c.innerHTML = "";
  var keys = Object.keys(obj).filter(function(k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  });
  if (!keys.length) {
    var d = document.createElement("div");
    d.style.cssText = "color:var(--text-dim);padding:10px;font-family:var(--font-ui)";
    d.textContent = "No headers";
    c.appendChild(d);
    return;
  }
  keys.forEach(function(k) {
    var row = document.createElement("div");
    row.className = "kv-row";
    row.appendChild(el("span","kv-key", k));
    row.appendChild(el("span","kv-val", obj[k]));
    c.appendChild(row);
  });
}

// ─── Detail Pretty Tab ────────────────────────────────
function fetchDetailPretty(req) {
  var out = document.getElementById("detail-res-pretty");
  var tb  = document.getElementById("detail-pretty-toolbar");
  if (!out) return;
  out.classList.remove("pretty-json");
  out.textContent = "Fetching…";
  if (tb) tb.querySelector("span").textContent = "FETCHING…";
  sendBg({
    type: "SEND_REPEATER",
    request: {
      id: "dp_" + req.id,
      method: req.method,
      url: req.url,
      requestHeaders: req.requestHeaders || {},
      requestBody: req.requestBody || null
    }
  });
}

function showDetailPrettyResult(result) {
  var out = document.getElementById("detail-res-pretty");
  var tb  = document.getElementById("detail-pretty-toolbar");
  if (!out) return;

  if (!result.success) {
    out.classList.remove("pretty-json");
    out.textContent = "Error: " + result.error;
    if (tb) tb.querySelector("span").textContent = "FETCH FAILED";
    return;
  }

  var body = result.body || "(empty)";
  if (tb) {
    tb.querySelector("span").textContent =
      result.statusCode + " " + (result.statusText||"") +
      " · " + fmtDuration(result.duration) + " · " + fmtSize(result.size||0);
  }

  renderPrettyInto(out, body);

  var cpBtn = document.getElementById("btn-detail-copy-pretty");
  if (cpBtn) cpBtn.onclick = function() {
    navigator.clipboard.writeText(body).then(function() { setStatus("Copied ✓"); });
  };
}

// ─── Send to Repeater ─────────────────────────────────
document.getElementById("btn-send-repeater").addEventListener("click", function() {
  var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
  if (!req) return;
  createSession(req);
  switchTab("repeater");
});

document.getElementById("btn-copy-curl").addEventListener("click", function() {
  var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
  if (!req) return;
  navigator.clipboard.writeText(buildCurl(req))
    .then(function() { setStatus("cURL copied ✓"); });
});

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
  document.querySelectorAll(".tab-pane").forEach(function(p) { p.classList.add("hidden"); });
  var btn = document.querySelector("[data-tab='" + name + "']");
  if (btn) btn.classList.add("active");
  var pane = document.getElementById("tab-" + name);
  if (pane) pane.classList.remove("hidden");
}

// ─── Repeater Sessions ────────────────────────────────
function createSession(req) {
  var id = ++sessionCounter;
  var h  = {};
  if (req && req.requestHeaders) Object.assign(h, req.requestHeaders);
  repeaterSessions.push({
    id: id,
    label: "#" + id + " " + (req ? req.method : "NEW"),
    method: req ? validMethod(req.method) : "GET",
    url: req ? req.url : "",
    headers: h,
    body: req ? (req.requestBody || "") : "",
    rawContent: req ? buildRaw(req) : "",
    response: null
  });
  renderSessionTabs();
  activateSession(id);
}

function renderSessionTabs() {
  var bar = document.getElementById("repeater-session-tabs");
  bar.innerHTML = "";
  repeaterSessions.forEach(function(s) {
    var tab = document.createElement("div");
    tab.className = "session-tab" + (s.id === activeSessionId ? " active" : "");
    tab.appendChild(txt(s.label));
    var x = document.createElement("span");
    x.className = "close-tab";
    x.dataset.id = String(s.id);
    x.textContent = "✕";
    tab.appendChild(x);
    tab.addEventListener("click", function(e) {
      if (e.target.classList.contains("close-tab")) {
        var n = parseInt(e.target.dataset.id, 10);
        if (isFinite(n)) closeSession(n);
      } else { activateSession(s.id); }
    });
    bar.appendChild(tab);
  });
}

function activateSession(id) {
  activeSessionId = id;
  renderSessionTabs();
  var s = repeaterSessions.find(function(x) { return x.id === id; });
  if (s) loadSession(s);
}

function closeSession(id) {
  repeaterSessions = repeaterSessions.filter(function(s) { return s.id !== id; });
  if (activeSessionId === id) {
    activeSessionId = repeaterSessions.length ? repeaterSessions[repeaterSessions.length-1].id : null;
  }
  renderSessionTabs();
  if (activeSessionId) activateSession(activeSessionId);
  else clearEditor();
}

function loadSession(s) {
  document.getElementById("rep-method").value = s.method;
  document.getElementById("rep-url").value    = s.url;
  document.getElementById("rep-body").value   = s.body;
  document.getElementById("rep-raw").value    = s.rawContent;
  var hc = document.getElementById("headers-editor-rows");
  hc.innerHTML = "";
  Object.keys(s.headers).forEach(function(k) {
    if (!Object.prototype.hasOwnProperty.call(s.headers,k)) return;
    if (k.toLowerCase()==="host" || k.toLowerCase()==="content-length") return;
    addHdrRow(k, s.headers[k]);
  });
  if (s.response) showRepResponse(s.response);
  else clearRepResponse();
}

function saveSession() {
  var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
  if (!s) return;
  s.method     = validMethod(document.getElementById("rep-method").value);
  s.url        = document.getElementById("rep-url").value;
  s.body       = document.getElementById("rep-body").value;
  s.rawContent = document.getElementById("rep-raw").value;
  s.headers    = collectHdrs();
}

function clearEditor() {
  document.getElementById("rep-method").value = "GET";
  document.getElementById("rep-url").value    = "";
  document.getElementById("rep-body").value   = "";
  document.getElementById("rep-raw").value    = "";
  document.getElementById("headers-editor-rows").innerHTML = "";
  clearRepResponse();
}

document.getElementById("btn-new-repeater").addEventListener("click", function() { createSession(null); });

// ─── Header Editor ────────────────────────────────────
function addHdrRow(k, v) {
  var row = document.createElement("div");
  row.className = "header-row";
  var ki = document.createElement("input");
  ki.type="text"; ki.className="header-key"; ki.placeholder="Header-Name"; ki.spellcheck=false; ki.value=k||"";
  var vi = document.createElement("input");
  vi.type="text"; vi.className="header-val"; vi.placeholder="value"; vi.spellcheck=false; vi.value=v||"";
  var db = document.createElement("button");
  db.className="btn-del-header"; db.title="Remove"; db.textContent="✕";
  db.addEventListener("click", function() { row.remove(); });
  row.append(ki, vi, db);
  document.getElementById("headers-editor-rows").appendChild(row);
}

document.getElementById("btn-add-header").addEventListener("click", function() { addHdrRow("",""); });

function collectHdrs() {
  var h = {};
  document.querySelectorAll(".header-row").forEach(function(row) {
    var k = row.querySelector(".header-key").value.trim();
    var v = row.querySelector(".header-val").value.trim();
    if (k) h[k] = v;
  });
  return h;
}

// ─── Send Request ─────────────────────────────────────
document.getElementById("btn-send-req").addEventListener("click", doSend);

function doSend() {
  var btn = document.getElementById("btn-send-req");
  btn.disabled = true;
  btn.innerHTML = "<span class='spinner'></span>";
  saveSession();
  var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
  if (!s) { btn.disabled=false; btn.textContent="▶ SEND"; return; }

  var h = Object.assign({}, s.headers);
  var activeEtab = document.querySelector(".rep-etab.active");
  if (activeEtab && activeEtab.dataset.etab === "rep-body-editor" && s.body) {
    h["Content-Type"] = document.getElementById("body-content-type").value;
  }

  sendBg({ type:"SEND_REPEATER", request:{ id:activeSessionId, method:s.method, url:s.url, requestHeaders:h, requestBody:s.body||null }});
  btn.disabled=false; btn.textContent="▶ SEND";
  setStatus("Sending " + s.method + " " + s.url + "…");
}

function onRepeaterResponse(sid, result) {
  var s = repeaterSessions.find(function(x) { return x.id === sid; });
  if (s) s.response = result;
  if (activeSessionId === sid) showRepResponse(result);
  setStatus(result.success
    ? "Response: " + result.statusCode + " · " + fmtDuration(result.duration) + " · " + fmtSize(result.size||0)
    : "Failed: " + result.error);
}

// ─── Response Display ─────────────────────────────────
function showRepResponse(result) {
  document.getElementById("response-meta-bar").classList.remove("hidden");
  var se = document.getElementById("rep-meta-status");
  var c  = result.statusCode || 0;
  se.textContent = result.success ? c+" "+(result.statusText||"") : "ERROR: "+result.error;
  se.style.color = c>=200&&c<300?"var(--green)":c>=400&&c<500?"var(--amber)":c>=500?"var(--red)":"var(--text-secondary)";
  document.getElementById("rep-meta-duration").textContent = fmtDuration(result.duration);
  document.getElementById("rep-meta-size").textContent     = fmtSize(result.size||0);

  lastRespBody = result.body || result.error || "(empty)";
  lastRespType = (result.responseHeaders && result.responseHeaders["content-type"]) || "";

  var acts = document.getElementById("rep-res-tab-actions");
  if (acts) acts.classList.add("visible");

  var pb = document.getElementById("btn-view-pretty");
  if (pb) {
    var can = isJson(lastRespType)||isXml(lastRespType)||looksJson(lastRespBody)||looksXml(lastRespBody);
    pb.disabled = !can;
    pb.style.opacity = can ? "1" : "0.35";
  }

  setViewMode("raw");
  document.getElementById("rep-response-empty").classList.add("hidden");
  var be = document.getElementById("rep-response-body");
  be.classList.remove("hidden");
  be.textContent = lastRespBody;

  if (result.responseHeaders) renderKV("rep-res-headers-table", result.responseHeaders);
}

function clearRepResponse() {
  document.getElementById("response-meta-bar").classList.add("hidden");
  document.getElementById("rep-response-empty").classList.remove("hidden");
  document.getElementById("rep-response-body").classList.add("hidden");
  document.getElementById("rep-res-headers-table").innerHTML = "";
  var acts = document.getElementById("rep-res-tab-actions");
  if (acts) acts.classList.remove("visible");
  lastRespBody = "";
}

// ─── Pretty Print ─────────────────────────────────────
function isJson(ct)    { return ct.indexOf("json") >= 0; }
function isXml(ct)     { return ct.indexOf("xml") >= 0 || ct.indexOf("html") >= 0; }
function looksJson(s)  { if (!s) return false; var t=s.trimLeft(); return t[0]==="{"||t[0]==="["; }
function looksXml(s)   { if (!s) return false; return s.trimLeft()[0]==="<"; }

function setViewMode(mode) {
  var be  = document.getElementById("rep-response-body");
  var rb  = document.getElementById("btn-view-raw");
  var pb  = document.getElementById("btn-view-pretty");
  if (!be) return;
  if (rb) rb.classList.toggle("active", mode==="raw");
  if (pb) pb.classList.toggle("active", mode==="pretty");
  if (mode === "pretty") {
    renderPrettyInto(be, lastRespBody);
  } else {
    be.classList.remove("pretty-json");
    be.innerHTML = "";
    be.textContent = lastRespBody;
  }
}

function renderPrettyInto(el, body) {
  if (looksJson(body)) {
    try {
      var p = JSON.stringify(JSON.parse(body), null, 2);
      el.classList.add("pretty-json");
      el.innerHTML = "";
      el.appendChild(highlightJson(p));
      return;
    } catch(e) {}
  }
  if (looksXml(body)) {
    try { el.classList.remove("pretty-json"); el.textContent = fmtXml(body); return; } catch(e) {}
  }
  el.classList.remove("pretty-json");
  el.textContent = body;
}

function highlightJson(s) {
  var f   = document.createDocumentFragment();
  var re  = /("(?:[^"\\]|\\.)*"(?:\s*:)?)|(\b(?:true|false)\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
  var last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) f.appendChild(txt(s.slice(last, m.index)));
    var sp = document.createElement("span");
    if      (m[1]) sp.className = m[0].trimRight().endsWith(":") ? "json-key" : "json-string";
    else if (m[2]) sp.className = "json-bool";
    else if (m[3]) sp.className = "json-null";
    else if (m[4]) sp.className = "json-number";
    else           sp.className = "json-punct";
    sp.textContent = m[0];
    f.appendChild(sp);
    last = re.lastIndex;
  }
  if (last < s.length) f.appendChild(txt(s.slice(last)));
  return f;
}

function fmtXml(xml) {
  var out = "", indent = 0, pad = "  ";
  xml.replace(/>\s*</g, ">\n<").split("\n").forEach(function(node) {
    node = node.trim();
    if (!node) return;
    if (/^<\/\w/.test(node)) indent--;
    out += pad.repeat(Math.max(0,indent)) + node + "\n";
    if (/^<\w[^>]*[^/]>.*$/.test(node) && !/^<.+\/>/.test(node)) indent++;
  });
  return out.trim();
}

// Response viewer buttons
var _rb = document.getElementById("btn-view-raw");
var _pb = document.getElementById("btn-view-pretty");
var _cb = document.getElementById("btn-copy-response");
var _wb = document.getElementById("btn-wrap-toggle");

if (_rb) _rb.addEventListener("click", function() { setViewMode("raw"); });
if (_pb) _pb.addEventListener("click", function() { if (!_pb.disabled) setViewMode("pretty"); });
if (_cb) _cb.addEventListener("click", function() {
  if (lastRespBody) navigator.clipboard.writeText(lastRespBody).then(function() { setStatus("Copied ✓"); });
});
if (_wb) _wb.addEventListener("click", function() {
  var be = document.getElementById("rep-response-body");
  wrapOn = !wrapOn;
  if (wrapOn) {
    be.classList.remove("wrap-off"); be.classList.add("wrap-on");
    _wb.style.color = "var(--cyan)"; _wb.style.borderColor = "var(--cyan-dim)";
  } else {
    be.classList.remove("wrap-on"); be.classList.add("wrap-off");
    _wb.style.color = ""; _wb.style.borderColor = "";
  }
});

// ─── Repeater sub-tabs ────────────────────────────────
document.querySelectorAll(".rep-etab").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".rep-etab").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".rep-etab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("rep-etab-" + btn.dataset.etab);
    if (pane) pane.classList.remove("hidden");
  });
});
document.querySelectorAll(".rep-rtab").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".rep-rtab").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".rep-rtab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("rep-rtab-" + btn.dataset.rtab);
    if (pane) pane.classList.remove("hidden");
  });
});

document.getElementById("btn-format-body").addEventListener("click", function() {
  var ta = document.getElementById("rep-body");
  try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); }
  catch(e) { setStatus("⚠ Invalid JSON"); }
});

// ─── Decoder ──────────────────────────────────────────
document.getElementById("btn-decode").addEventListener("click", runDecoder);
document.getElementById("btn-decode-chain").addEventListener("click", function() {
  document.getElementById("decoder-input").value  = document.getElementById("decoder-output").value;
  document.getElementById("decoder-output").value = "";
});
document.getElementById("btn-copy-output").addEventListener("click", function() {
  navigator.clipboard.writeText(document.getElementById("decoder-output").value)
    .then(function() { setStatus("Copied ✓"); });
});
document.getElementById("decode-action").addEventListener("change", function(e) {
  document.getElementById("jwt-inspector").classList.toggle("hidden", e.target.value !== "jwt-decode");
});

function runDecoder() {
  var inp = document.getElementById("decoder-input").value;
  var act = document.getElementById("decode-action").value;
  var out = "";
  try {
    if      (act==="b64-decode")  out = atob(inp.trim());
    else if (act==="b64-encode")  out = btoa(unescape(encodeURIComponent(inp)));
    else if (act==="url-decode")  out = decodeURIComponent(inp);
    else if (act==="url-encode")  out = encodeURIComponent(inp);
    else if (act==="html-decode") { var ta=document.createElement("textarea"); ta.innerHTML=inp; out=ta.value; }
    else if (act==="html-encode") out = inp.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    else if (act==="hex-encode")  out = Array.from(inp).map(function(c){return c.charCodeAt(0).toString(16).padStart(2,"0");}).join("");
    else if (act==="hex-decode") {
      var pairs = inp.replace(/\s/g,"").match(/.{2}/g);
      if (!pairs) throw new Error("Invalid hex");
      out = pairs.map(function(b){return String.fromCharCode(parseInt(b,16));}).join("");
    }
    else if (act==="json-format") out = JSON.stringify(JSON.parse(inp), null, 2);
    else if (act==="jwt-decode")  out = decodeJWT(inp);
    else if (act==="sha256") {
      sha256(inp).then(function(h) {
        document.getElementById("decoder-output").value = h;
        setStatus("SHA-256 done ✓");
      });
      return;
    }
    document.getElementById("decoder-output").value = out;
    setStatus("Transform applied ✓");
  } catch(e) {
    document.getElementById("decoder-output").value = "ERROR: " + e.message;
    setStatus("Error: " + e.message);
  }
}

function decodeJWT(token) {
  var parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("Expected 3 parts");
  function b64(s) { s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; return JSON.parse(atob(s)); }
  var hdr  = b64(parts[0]);
  var pay  = b64(parts[1]);
  document.getElementById("jwt-header").textContent  = JSON.stringify(hdr, null, 2);
  document.getElementById("jwt-payload").textContent = JSON.stringify(pay, null, 2);
  document.getElementById("jwt-sig").textContent     = parts[2];
  document.getElementById("jwt-inspector").classList.remove("hidden");
  var alg = String(hdr.alg||"unknown");
  document.getElementById("jwt-alg-name").textContent = alg;
  document.getElementById("jwt-alg-warning").classList.toggle("hidden", alg!=="none"&&alg!=="HS256");
  return "Header:\n"+JSON.stringify(hdr,null,2)+"\n\nPayload:\n"+JSON.stringify(pay,null,2)+"\n\nSig:\n"+parts[2];
}

async function sha256(s) {
  var b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(function(x){return x.toString(16).padStart(2,"0");}).join("");
}

// ─── Reload Handler ───────────────────────────────────
function doReload() {
  if (IS_STANDALONE) {
    var sel = document.getElementById("tab-target-select");
    var val = sel ? sel.value : "all";
    if (!sel || val === "all") {
      setStatus("⚠ Select a specific tab from the dropdown first");
      if (sel) { sel.style.borderColor="var(--amber)"; setTimeout(function(){sel.style.borderColor="";},2000); }
      return;
    }
    var tid = parseInt(val, 10);
    if (!isFinite(tid)) return;
    chrome.tabs.reload(tid, {}, function() {
      allRequests = allRequests.filter(function(r){return r.tabId!==tid;});
      renderList();
      setStatus("Tab reloading — capturing from start…");
    });
  } else {
    // DevTools mode
    chrome.devtools.inspectedWindow.reload({});
    allRequests = [];
    renderList();
    showDetailEmpty();
    setStatus("Page reloading — capturing from start…");
  }
}

// ─── Standalone UI ────────────────────────────────────
function initStandalone() {
  document.body.classList.add("standalone");
  var bar = document.getElementById("standalone-tab-bar");
  if (bar) bar.classList.remove("hidden");
  populateTabs();
  var rb = document.getElementById("btn-refresh-tabs");
  if (rb) rb.addEventListener("click", populateTabs);
  var sel = document.getElementById("tab-target-select");
  if (sel) sel.addEventListener("change", function() {
    renderList();
    setStatus(sel.value==="all" ? "Monitoring all tabs" : "Monitoring: "+sel.options[sel.selectedIndex].text);
  });
}

function populateTabs() {
  var sel = document.getElementById("tab-target-select");
  if (!sel) return;
  chrome.tabs.query({}, function(tabs) {
    var prev = sel.value;
    sel.innerHTML = "";
    var ao = document.createElement("option"); ao.value="all"; ao.textContent="All Tabs"; sel.appendChild(ao);
    tabs.filter(function(t){return t.url&&(t.url.indexOf("http://")==0||t.url.indexOf("https://")==0);})
      .forEach(function(t) {
        var o = document.createElement("option"); o.value = String(t.id);
        var h=""; try{h=new URL(t.url).host;}catch(e){h=t.url;}
        o.textContent = "["+t.id+"] "+h+" — "+(t.title||h).slice(0,45);
        sel.appendChild(o);
      });
    if (prev && Array.from(sel.options).some(function(o){return o.value===prev;})) sel.value=prev;
  });
}

// ─── Helpers ──────────────────────────────────────────
function el(tag, cls, text) {
  var e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function txt(s) { return document.createTextNode(s == null ? "" : String(s)); }

function parseURL(url) {
  try { var u=new URL(url); return {host:u.host, path:u.pathname+u.search}; }
  catch(e) { return {host:"", path:url}; }
}

function statusClass(req) {
  if (req.status==="error") return "status-err";
  if (!req.statusCode)      return "status-pending";
  if (req.statusCode>=500)  return "status-5xx";
  if (req.statusCode>=400)  return "status-4xx";
  if (req.statusCode>=300)  return "status-3xx";
  if (req.statusCode>=200)  return "status-2xx";
  return "status-pending";
}

function methodColor(m) {
  return {GET:"var(--green)",POST:"var(--cyan)",PUT:"var(--amber)",DELETE:"var(--red)",
    PATCH:"var(--purple)",OPTIONS:"var(--text-secondary)",HEAD:"var(--blue)"}[m]||"var(--text-secondary)";
}

function validMethod(m) {
  var u = String(m||"").toUpperCase();
  return ALLOWED_METHODS.indexOf(u)>=0 ? u : "GET";
}

function fmtDuration(ms) {
  if (!ms) return "—";
  return ms < 1000 ? ms+"ms" : (ms/1000).toFixed(2)+"s";
}

function fmtSize(b) {
  if (!b) return "0 B";
  if (b<1024) return b+" B";
  if (b<1048576) return (b/1024).toFixed(1)+" KB";
  return (b/1048576).toFixed(2)+" MB";
}

function buildCurl(req) {
  var cmd = "curl -X " + req.method + " '" + req.url.replace(/'/g,"'\\''") + "'";
  Object.keys(req.requestHeaders||{}).forEach(function(k) {
    if (!Object.prototype.hasOwnProperty.call(req.requestHeaders,k)) return;
    cmd += " \\\n  -H '" + (k+": "+req.requestHeaders[k]).replace(/'/g,"'\\''") + "'";
  });
  if (req.requestBody) cmd += " \\\n  -d '" + req.requestBody.replace(/'/g,"'\\''") + "'";
  return cmd;
}

function buildRaw(req) {
  var p = parseURL(req.url);
  var r = req.method + " " + (p.path||"/") + " HTTP/1.1\n" + "Host: " + p.host + "\n";
  Object.keys(req.requestHeaders||{}).forEach(function(k) {
    if (k.toLowerCase()!=="host") r += k+": "+req.requestHeaders[k]+"\n";
  });
  if (req.requestBody) r += "\n"+req.requestBody;
  return r;
}

function setStatus(msg) {
  var s = document.getElementById("status-msg");
  if (s) s.textContent = msg;
}

// ─── Init ─────────────────────────────────────────────
if (IS_STANDALONE) initStandalone();
connectBackground();
setStatus("PhantomProxy ready");
createSession(null);
