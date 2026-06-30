// PhantomProxy — Panel v2.1 (Android Fixed + Intruder)
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

// Bookmark filter toggle
var bookmarkFilterOn = false;
var typeFilters      = {};
var scopeFilterOn    = false;

// Bookmark state
var bookmarkMap = {};

// Pretty print state
var lastRespBody      = "";
var lastRespType      = "";
var wrapOn            = true;

// ─── INTRUDER STATE ────────────────────────────────────
var intruderState = {
  running: false,
  results: [],
  total: 0,
  completed: 0,
  stopRequested: false,
  currentIndex: 0
};

// ─── FIX: Auto-detect standalone mode ──────────────────
var IS_STANDALONE = false;
(function detectMode() {
    var hasDevtools = typeof chrome !== 'undefined' && 
                      typeof chrome.devtools !== 'undefined' && 
                      chrome.devtools !== null;
    var hasInspectedWindow = hasDevtools && 
                             typeof chrome.devtools.inspectedWindow !== 'undefined';
    var hasTabId = hasInspectedWindow && 
                   typeof chrome.devtools.inspectedWindow.tabId !== 'undefined';
    
    var urlParam = new URLSearchParams(window.location.search).get("mode");
    if (urlParam === "standalone") {
        IS_STANDALONE = true;
    } else if (!hasDevtools || !hasInspectedWindow || !hasTabId) {
        IS_STANDALONE = true;
    } else {
        IS_STANDALONE = false;
    }
})();

// ─── COPY FIX: Universal copy function that works in devtools ──
function copyText(text) {
  if (!text) return false;
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    var result = document.execCommand('copy');
    document.body.removeChild(ta);
    return result;
  } catch(e) {
    document.body.removeChild(ta);
    return false;
  }
}

// ─── FIX: Connection with fallback for Android ────────
var _reconnectTimer = null;
var _connecting     = false;

function connectBackground() {
  if (IS_STANDALONE) {
    doConnect("phantom-standalone");
    return;
  }
  
  if (!chrome.devtools) {
    IS_STANDALONE = true;
    doConnect("phantom-standalone");
    return;
  }
  
  try {
    var tabId = chrome.devtools.inspectedWindow?.tabId;
    if (!tabId) {
      IS_STANDALONE = true;
      doConnect("phantom-standalone");
    } else {
      doConnect("phantom-devtools-" + tabId);
    }
  } catch(e) {
    IS_STANDALONE = true;
    doConnect("phantom-standalone");
  }
}

function doConnect(portName) {
  try {
    if (typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined') {
      setTimeout(connectBackground, 3000);
      return;
    }
    
    if (typeof chrome.runtime.connect !== 'function') {
      setTimeout(connectBackground, 3000);
      return;
    }
    
    bgPort = chrome.runtime.connect({ name: portName });
    bgPort.onMessage.addListener(onBgMessage);
    bgPort.onDisconnect.addListener(function() {
      bgPort = null;
      setStatus("Reconnecting…");
      setTimeout(connectBackground, 1500);
    });
    setStatus("PhantomProxy connected");
  } catch(e) {
    setTimeout(connectBackground, 2000);
  }
}

function sendBg(msg) {
  if (bgPort) {
    try { bgPort.postMessage(msg); }
    catch(e) {}
  }
}

// ─── Message Handler ──────────────────────────────────
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
      if (typeof msg.id === "string" && msg.id.indexOf("intruder_") === 0) {
        onIntruderResponse(msg.id, msg.result);
      } else if (typeof msg.id === "string" && msg.id.indexOf("dp_") === 0) {
        showDetailPrettyResult(msg.result);
      } else {
        onRepeaterResponse(msg.id, msg.result);
      }
      break;
  }
}

// ─── INTRUDER TABS navigation ─────────────────────────────
document.querySelectorAll(".tab-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("tab-" + btn.dataset.tab);
    if (pane) pane.classList.remove("hidden");
    
    if (btn.dataset.tab === 'intruder') {
      initIntruderTabs();  // ← No delay
    }
  });
});

// ─── INTRUDER SUB-TABS INIT ─────────────────────────────
function initIntruderTabs() {
  var tabs = document.querySelectorAll('.payload-tab');
  
  if (tabs.length === 0) {
    setStatus('⚠️ No payload tabs found');
    return;
  }
  
  setStatus('🔄 Found ' + tabs.length + ' payload tabs');
  
  tabs.forEach(function(tab) {
    // Remove old listeners by cloning
    var newTab = tab.cloneNode(true);
    tab.parentNode.replaceChild(newTab, tab);
    
    newTab.addEventListener('click', function(e) {
      e.preventDefault();
      
      var target = this.dataset.tab;
      setStatus('🔄 Switching to: ' + target);
      
      // Update tab styles
      document.querySelectorAll('.payload-tab').forEach(function(t) {
        t.classList.remove('active');
      });
      this.classList.add('active');
      
      // Hide all panels
      document.querySelectorAll('.payload-panel').forEach(function(p) {
        p.classList.add('hidden');
      });
      
      // Show target panel
      var panel = document.getElementById('payload-' + target);
      if (panel) {
        panel.classList.remove('hidden');
        setStatus('✅ Showing: ' + target);
        
        // ✅ AUTO-OPEN FILE PICKER when 'file' tab is clicked
        if (target === 'file') {
          var fileInput = document.getElementById('intruder-file-input');
          if (fileInput) {
            setTimeout(function() {
              fileInput.click();
            }, 300);  // Small delay to let panel render
          }
        }
      } else {
        setStatus('❌ Panel not found: ' + target);
      }
    });
  });
  
  setStatus('✅ Intruder tabs ready');
}

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

// Type filter chips
document.querySelectorAll(".type-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    var t = chip.dataset.type;
    if (t === "ALL") {
      typeFilters = {};
      document.querySelectorAll(".type-chip").forEach(function(c) { c.classList.remove("active"); });
      chip.classList.add("active");
    } else {
      if (typeFilters[t]) {
        delete typeFilters[t];
        chip.classList.remove("active");
      } else {
        typeFilters[t] = true;
        chip.classList.add("active");
      }
      var allChip = document.querySelector(".type-chip[data-type='ALL']");
      if (allChip) allChip.classList.remove("active");
      if (Object.keys(typeFilters).length === 0) {
        if (allChip) allChip.classList.add("active");
      }
    }
    renderList();
    var active = Object.keys(typeFilters);
    setStatus(active.length === 0 ? "Showing all types" : "Type filter: " + active.join(", "));
  });
});

// Scope filter chip
var _scopeFilterBtn = document.getElementById("btn-filter-scope");
if (_scopeFilterBtn) {
  _scopeFilterBtn.addEventListener("click", function() {
    scopeFilterOn = !scopeFilterOn;
    _scopeFilterBtn.classList.toggle("active", scopeFilterOn);
    renderList();
    if (scopeFilterOn && window.PhantomFeatures && !PhantomFeatures.scopeState.domains.length) {
      setStatus("⚠ No domains in scope — add domains in the Scope tab first");
    } else {
      setStatus(scopeFilterOn ? "Showing in-scope requests only" : "Showing all requests");
    }
  });
}

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
    if (IS_STANDALONE) {
      var sel = document.getElementById("tab-target-select");
      if (sel && sel.value !== "all") {
        var tid = parseInt(sel.value, 10);
        if (isFinite(tid) && req.tabId !== tid) return false;
      }
    }

    if (window.PhantomFeatures && !PhantomFeatures.scopeMatch(req.url)) {
      if (PhantomFeatures.scopeState.enabled && PhantomFeatures.scopeState.mode === "hide") return false;
    }

    if (scopeFilterOn && window.PhantomFeatures) {
      if (!PhantomFeatures.scopeState.domains.length) {
      } else if (!PhantomFeatures.scopeMatch(req.url)) {
        return false;
      }
    }

    if (methodFilter !== "ALL" && req.method !== methodFilter) return false;

    if (Object.keys(typeFilters).length > 0) {
      var rt2 = (req.type || "other").toLowerCase();
      var matched = false;
      var knownTypes2 = ["xmlhttprequest","script","stylesheet","main_frame","sub_frame","image","font","media","websocket"];
      if (typeFilters["xhr"]        && rt2 === "xmlhttprequest")                          matched = true;
      if (typeFilters["fetch"]      && rt2 === "xmlhttprequest")                          matched = true;
      if (typeFilters["script"]     && rt2 === "script")                                  matched = true;
      if (typeFilters["stylesheet"] && rt2 === "stylesheet")                              matched = true;
      if (typeFilters["document"]   && (rt2 === "main_frame" || rt2 === "sub_frame"))     matched = true;
      if (typeFilters["image"]      && rt2 === "image")                                   matched = true;
      if (typeFilters["font"]       && rt2 === "font")                                    matched = true;
      if (typeFilters["media"]      && rt2 === "media")                                   matched = true;
      if (typeFilters["websocket"]  && rt2 === "websocket")                               matched = true;
      if (typeFilters["other"]      && knownTypes2.indexOf(rt2) < 0)                      matched = true;
      if (!matched) return false;
    }

    if (bookmarkFilterOn && !bookmarkMap[req.id]) return false;

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

  var flagsSpan = document.createElement("span");
  flagsSpan.className = "row-flags";
  if (window.PhantomFeatures) {
    var hits = PhantomFeatures.getHighlights(req);
    hits.slice(0, 2).forEach(function(rule) {
      flagsSpan.appendChild(PhantomFeatures.makeHighlightBadge(rule));
    });
    if (hits.length > 2) {
      var more = document.createElement("span");
      more.className = "highlight-badge";
      more.textContent = "+" + (hits.length - 2);
      more.style.cssText = "color:var(--text-dim);border:1px solid var(--border);border-radius:2px;font-family:var(--font-ui);font-size:9px;padding:1px 4px;";
      flagsSpan.appendChild(more);
    }
    if (hits.length) {
      var topRule = hits[0];
      if (topRule.id === "admin" || topRule.id === "sensitive" || topRule.id === "server-error" || topRule.id === "sqli-hint") {
        row.classList.add("hl-security");
      } else if (topRule.id === "jwt" || topRule.id === "auth" || topRule.id === "apikey") {
        row.classList.add("hl-auth");
      } else {
        row.classList.add("hl-info");
      }
    }
    if (!PhantomFeatures.scopeMatch(req.url) && PhantomFeatures.scopeState.enabled) {
      row.classList.add("out-of-scope");
    }
  }

  var t = el("span","row-type", req.type || "");
  var d = el("span","row-time", dur);

  var bm = bookmarkMap[req.id];
  if (bm) {
    row.style.borderLeft = "3px solid " + bm.color;
    row.style.background = bm.color + "10";
    if (bm.label) row.title = "Bookmark: " + bm.label;
  } else {
    row.style.borderLeft = "3px solid transparent";
  }

  row.append(m, s, u, flagsSpan, t, d);
  row.addEventListener("click", function() { selectReq(req.id); });

  row.addEventListener("contextmenu", function(e) {
    e.preventDefault();
    showBookmarkMenu(req.id, e.clientX, e.clientY);
  });

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

  document.querySelectorAll(".dtab").forEach(function(b) { b.classList.remove("active"); });
  document.querySelectorAll(".dtab-pane").forEach(function(p) { p.classList.add("hidden"); });
  document.querySelector(".dtab").classList.add("active");
  document.querySelector(".dtab-pane").classList.remove("hidden");

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
    copyText(body);
    setStatus("Copied ✓");
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
  copyText(buildCurl(req));
  setStatus("cURL copied ✓");
});

// ─── FIX 3: Send to Intruder from History ─────────────
document.getElementById("btn-send-intruder").addEventListener("click", function() {
  var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
  if (!req) {
    setStatus("⚠ No request selected");
    return;
  }
  
  // Build raw request
  var raw = req.method + ' ' + req.url + ' HTTP/1.1\n';
  Object.keys(req.requestHeaders || {}).forEach(function(k) {
    if (k.toLowerCase() !== 'content-length') {
      raw += k + ': ' + req.requestHeaders[k] + '\n';
    }
  });
  raw += '\n' + (req.requestBody || '');
  
  document.getElementById('intruder-request').value = raw;
  switchTab('intruder');
  
  // === ADD THE WORKSPACE COMPONENT INITIALIZATION HERE ===
  initIntruderTabs(); 
  
  setStatus('✅ Request sent to Intruder');
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

// ─── Response viewer buttons ──────────────────────────
var _rb = document.getElementById("btn-view-raw");
var _pb = document.getElementById("btn-view-pretty");
var _cb = document.getElementById("btn-copy-response");
var _wb = document.getElementById("btn-wrap-toggle");

if (_rb) _rb.addEventListener("click", function() { setViewMode("raw"); });
if (_pb) _pb.addEventListener("click", function() { if (!_pb.disabled) setViewMode("pretty"); });
if (_cb) _cb.addEventListener("click", function() {
  if (lastRespBody) {
    copyText(lastRespBody);
    setStatus("Copied ✓");
  }
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
  copyText(document.getElementById("decoder-output").value);
  setStatus("Copied ✓");
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

// ─── Bookmarks ────────────────────────────────────────

var BOOKMARK_COLORS = [
  { color: "#ff3860", label: "Red"    },
  { color: "#ffb700", label: "Orange" },
  { color: "#00ff9d", label: "Green"  },
  { color: "#00e5ff", label: "Cyan"   },
  { color: "#4d9fff", label: "Blue"   },
  { color: "#b44fff", label: "Purple" },
  { color: "#ff9f43", label: "Yellow" },
  { color: "#ff6b9d", label: "Pink"   }
];

var _bmMenu = null;
var _bmMenuReqId = null;

function showBookmarkMenu(reqId, x, y) {
  closeBookmarkMenu();
  _bmMenuReqId = reqId;

  var menu = document.createElement("div");
  menu.id = "bookmark-menu";
  menu.style.cssText = [
    "position:fixed",
    "z-index:9999",
    "left:" + Math.min(x, window.innerWidth - 220) + "px",
    "top:"  + Math.min(y, window.innerHeight - 280) + "px",
    "background:var(--bg-elevated)",
    "border:1px solid var(--border)",
    "border-radius:4px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
    "padding:8px",
    "min-width:200px",
    "font-family:var(--font-ui)"
  ].join(";");

  var hdr = document.createElement("div");
  hdr.style.cssText = "font-size:10px;font-weight:700;letter-spacing:2px;color:var(--text-dim);padding:4px 6px 8px;border-bottom:1px solid var(--border);margin-bottom:8px;";
  hdr.textContent = "HIGHLIGHT ROW";
  menu.appendChild(hdr);

  var grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:4px;margin-bottom:8px;";

  var current = bookmarkMap[reqId];

  BOOKMARK_COLORS.forEach(function(bc) {
    var swatch = document.createElement("button");
    swatch.title = bc.label;
    var isActive = current && current.color === bc.color;
    swatch.style.cssText = [
      "width:36px", "height:36px",
      "background:" + bc.color,
      "border:" + (isActive ? "3px solid white" : "2px solid transparent"),
      "border-radius:4px",
      "cursor:pointer",
      "transition:transform 0.1s,box-shadow 0.1s",
      "box-shadow:" + (isActive ? "0 0 10px " + bc.color : "none")
    ].join(";");
    swatch.addEventListener("mouseenter", function() {
      swatch.style.transform = "scale(1.12)";
      swatch.style.boxShadow = "0 0 10px " + bc.color;
    });
    swatch.addEventListener("mouseleave", function() {
      swatch.style.transform = isActive ? "scale(1.0)" : "scale(1.0)";
      swatch.style.boxShadow = isActive ? "0 0 10px " + bc.color : "none";
    });
    swatch.addEventListener("click", function() {
      setBookmark(reqId, bc.color, current ? current.label : "");
      closeBookmarkMenu();
    });
    grid.appendChild(swatch);
  });
  menu.appendChild(grid);

  var labelRow = document.createElement("div");
  labelRow.style.cssText = "display:flex;gap:6px;padding:0 4px;margin-bottom:8px;";
  var labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = "Add a note…";
  labelInput.value = current ? (current.label || "") : "";
  labelInput.spellcheck = false;
  labelInput.style.cssText = [
    "flex:1", "padding:5px 8px",
    "background:var(--bg-surface)",
    "border:1px solid var(--border)",
    "border-radius:3px",
    "color:var(--text-primary)",
    "font-family:var(--font-mono)",
    "font-size:11px", "outline:none"
  ].join(";");
  labelInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      var col = current ? current.color : BOOKMARK_COLORS[0].color;
      setBookmark(reqId, col, labelInput.value.trim());
      closeBookmarkMenu();
    }
    e.stopPropagation();
  });
  labelRow.appendChild(labelInput);
  menu.appendChild(labelRow);

  var div = document.createElement("div");
  div.style.cssText = "height:1px;background:var(--border);margin:4px 0;";
  menu.appendChild(div);

  var clearBtn = document.createElement("button");
  clearBtn.textContent = "✕  Remove highlight";
  clearBtn.style.cssText = [
    "width:100%", "padding:7px 10px",
    "background:transparent",
    "border:none", "border-radius:3px",
    "color:var(--text-dim)",
    "font-family:var(--font-ui)",
    "font-size:11px", "font-weight:600",
    "letter-spacing:0.5px",
    "text-align:left", "cursor:pointer",
    "transition:background 0.1s,color 0.1s"
  ].join(";");
  clearBtn.addEventListener("mouseenter", function() {
    clearBtn.style.background = "rgba(255,56,96,0.1)";
    clearBtn.style.color = "var(--red)";
  });
  clearBtn.addEventListener("mouseleave", function() {
    clearBtn.style.background = "transparent";
    clearBtn.style.color = "var(--text-dim)";
  });
  clearBtn.addEventListener("click", function() {
    removeBookmark(reqId);
    closeBookmarkMenu();
  });
  menu.appendChild(clearBtn);

  document.body.appendChild(menu);
  _bmMenu = menu;

  setTimeout(function() { labelInput.focus(); }, 50);

  setTimeout(function() {
    document.addEventListener("click", closeBookmarkMenu, { once: true });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") closeBookmarkMenu();
    }, { once: true });
  }, 0);
}

function closeBookmarkMenu() {
  if (_bmMenu) { _bmMenu.remove(); _bmMenu = null; }
}

function setBookmark(reqId, color, label) {
  bookmarkMap[reqId] = { color: color, label: label || "" };
  saveBookmarks();
  refreshRow(reqId);
  setStatus("Highlighted request — " + (label || color));
}

function removeBookmark(reqId) {
  delete bookmarkMap[reqId];
  saveBookmarks();
  refreshRow(reqId);
  setStatus("Highlight removed");
}

function refreshRow(reqId) {
  var req = allRequests.find(function(r) { return r.id === reqId; });
  if (!req) return;
  var old = document.querySelector('.request-row[data-id="' + CSS.escape(reqId) + '"]');
  if (old) old.replaceWith(makeRow(req));
}

function saveBookmarks() {
  chrome.storage.local.set({ phantomBookmarks: bookmarkMap });
}

function loadBookmarks() {
  chrome.storage.local.get("phantomBookmarks", function(data) {
    if (data.phantomBookmarks) {
      bookmarkMap = data.phantomBookmarks;
    }
  });
}

// ─── INTRUDER ENGINE ────────────────────────────────────

function findPayloadPositions(request) {
  var positions = [];
  var regex = /§([^§]*)§/g;
  var match;
  while ((match = regex.exec(request)) !== null) {
    positions.push({
      start: match.index,
      end: match.index + match[0].length,
      placeholder: match[1] || "payload"
    });
  }
  return positions;
}

function replacePayloads(request, positions, payloads) {
  var result = request;
  for (var i = positions.length - 1; i >= 0; i--) {
    var pos = positions[i];
    var replacement = payloads[i] !== undefined ? payloads[i] : pos.placeholder;
    result = result.slice(0, pos.start) + replacement + result.slice(pos.end);
  }
  return result;
}

function parseRawRequest(raw) {
  var lines = raw.split('\n');
  var requestLine = lines[0] || '';
  var parts = requestLine.split(' ');
  var method = parts[0] || 'GET';
  var url = parts[1] || '/';
  var headers = {};
  var body = '';
  var inHeaders = true;
  
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (inHeaders && line.trim() === '') {
      inHeaders = false;
      continue;
    }
    if (inHeaders) {
      var colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        var key = line.slice(0, colonIdx).trim();
        var value = line.slice(colonIdx + 1).trim();
        headers[key] = value;
      }
    } else {
      body += line + '\n';
    }
  }
  
  return { method: method, url: url, headers: headers, body: body.trim() };
}

function generateCombinations(attackType, positions, payloads) {
  if (attackType === "sniper") {
    return payloads.map(function(p) { return [p]; });
  }
  
  if (attackType === "battering-ram") {
    return payloads.map(function(p) {
      var combo = [];
      for (var i = 0; i < positions.length; i++) combo.push(p);
      return combo;
    });
  }
  
  if (attackType === "pitchfork") {
    var combos = [];
    payloads.forEach(function(line) {
      // Split by colon (e.g., "admin:password123" -> ["admin", "password123"])
      var parts = line.split(':');
      var combo = [];
      
      for (var i = 0; i < positions.length; i++) {
        // Fallback to full line string if there are fewer colon sections than markers
        combo.push(parts[i] !== undefined ? parts[i] : line);
      }
      combos.push(combo);
    });
    return combos;
  }
  
  if (attackType === "cluster-bomb") {
    // 1. Build separate token arrays for each position marked
    var columns = [];
    for (var i = 0; i < positions.length; i++) {
      columns.push([]);
    }
    
    // 2. Extract left and right values from your user:pass rows into distinct pools
    payloads.forEach(function(line) {
      var parts = line.split(':');
      for (var i = 0; i < positions.length; i++) {
        if (parts[i] !== undefined) {
          columns[i].push(parts[i]);
        }
      }
    });

    // 3. Compute the cross-product combinations across those token pools
    var combos = [[]];
    for (var i = 0; i < columns.length; i++) {
      var currentColumn = columns[i];
      if (currentColumn.length === 0) continue; 
      
      var newCombos = [];
      for (var c = 0; c < combos.length; c++) {
        for (var p = 0; p < currentColumn.length; p++) {
          var copy = combos[c].slice();
          copy.push(currentColumn[p]);
          newCombos.push(copy);
        }
      }
      combos = newCombos;
    }
    return combos;
  }
  
  return [];
}


function onIntruderResponse(id, result) {
  for (var i = 0; i < intruderState.results.length; i++) {
    if (intruderState.results[i].id === id) {
      intruderState.results[i].status = 'complete';
      intruderState.results[i].result = result;
      break;
    }
  }
  updateIntruderUI();
}

function updateIntruderUI() {
  var count = document.getElementById('intruder-count');
  var progress = document.getElementById('intruder-progress');
  var status = document.getElementById('intruder-status');
  var tableBody = document.getElementById('intruder-results-body');
  var startBtn = document.getElementById('btn-intruder-start');
  var stopBtn = document.getElementById('btn-intruder-stop');
  
  if (count) count.textContent = intruderState.completed + '/' + intruderState.total;
  if (progress) {
    var pct = intruderState.total > 0 ? (intruderState.completed / intruderState.total * 100) : 0;
    progress.style.width = Math.min(pct, 100) + '%';
  }
  if (status) {
    status.textContent = intruderState.running ? '⏳ Running...' : 
                         intruderState.stopRequested ? '⏹ Stopped' : '✅ Done';
  }
  
  if (startBtn) startBtn.style.display = intruderState.running ? 'none' : 'inline-block';
  if (stopBtn) stopBtn.style.display = intruderState.running ? 'inline-block' : 'none';
  
  if (tableBody) {
    tableBody.innerHTML = '';
    var grepPatterns = [];
    var grepEl = document.getElementById('intruder-grep');
    if (grepEl) {
      grepPatterns = grepEl.value.split('\n').filter(function(p) { return p.trim(); });
    }
    
    intruderState.results.forEach(function(r) {
      var row = document.createElement('tr');
      var statusText = r.status === 'pending' ? '⏳' : (r.result ? (r.result.success ? '✅ ' + r.result.statusCode : '❌ ' + r.result.error) : '');
      var grepMatches = '';
      if (r.result && r.result.body) {
        var matches = [];
        grepPatterns.forEach(function(pattern) {
          if (r.result.body.indexOf(pattern) >= 0) {
            matches.push(pattern);
          }
        });
        grepMatches = matches.join(', ');
      }
      
      row.innerHTML = '<td>' + (r.index + 1) + '</td>' +
                      '<td>' + r.payload + '</td>' +
                      '<td>' + statusText + '</td>' +
                      '<td>' + grepMatches + '</td>' +
                      '<td>' + (r.result ? (r.result.size || 0) : '-') + '</td>' +
                      '<td>' + (r.result ? (r.result.duration || 0) + 'ms' : '-') + '</td>' +
                      '<td><button class="view-intruder-result" data-idx="' + r.index + '">View</button></td>';
      tableBody.appendChild(row);
    });
    
    tableBody.querySelectorAll('.view-intruder-result').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(this.dataset.idx);
        var result = intruderState.results[idx];
        if (result && result.result) {
          var bodyEl = document.getElementById('intruder-response-body');
          if (bodyEl) {
            bodyEl.textContent = result.result.body || JSON.stringify(result.result, null, 2);
          }
        }
      });
    });
  }
}

function startIntruder() {
  var request = document.getElementById('intruder-request').value;
  var payloads = [];
  var activePayloadTab = document.querySelector('.payload-tab.active');
  if (activePayloadTab) {
    var tab = activePayloadTab.dataset.tab;
    if (tab === 'simple') {
      payloads = document.getElementById('intruder-payloads').value.split('\n').filter(function(p) { return p.trim(); });
    } else if (tab === 'file') {
      payloads = document.getElementById('intruder-file-preview').value.split('\n').filter(function(p) { return p.trim(); });
    } else if (tab === 'numbers') {
      payloads = document.getElementById('intruder-num-preview').value.split('\n').filter(function(p) { return p.trim(); });
    }
  }
  
  var attackType = document.getElementById('intruder-attack-type').value;
  var delay = parseInt(document.getElementById('intruder-delay').value) || 100;
  var maxRequests = parseInt(document.getElementById('intruder-max').value) || 1000;
  
  var positions = findPayloadPositions(request);
  if (!positions.length) {
    setStatus('⚠ No §payload§ markers found in request');
    return;
  }
  if (!payloads.length) {
    setStatus('⚠ No payloads provided');
    return;
  }
  
  var combinations = generateCombinations(attackType, positions, payloads);
  if (combinations.length > maxRequests) {
    setStatus('⚠ ' + combinations.length + ' requests exceeds max (' + maxRequests + ')');
    return;
  }
  
  intruderState = {
    running: true,
    results: [],
    total: combinations.length,
    completed: 0,
    stopRequested: false,
    currentIndex: 0
  };
  
  updateIntruderUI();
  setStatus('🚀 Starting Intruder attack: ' + combinations.length + ' requests');
  sendIntruderRequests(combinations, delay);
}

function sendIntruderRequests(combinations, delay) {
  var index = 0;
  
  function sendNext() {
    if (intruderState.stopRequested || index >= combinations.length) {
      intruderState.running = false;
      setStatus('✅ Intruder attack completed — ' + intruderState.completed + ' requests sent');
      updateIntruderUI();
      return;
    }
    
    var combo = combinations[index];
    var request = document.getElementById('intruder-request').value;
    var positions = findPayloadPositions(request);
    var modifiedRequest = replacePayloads(request, positions, combo);
    
    var parsed = parseRawRequest(modifiedRequest);
    var payloadLabel = combo.join(',');
    
    var requestId = 'intruder_' + Date.now() + '_' + index;
    
    sendBg({
      type: 'SEND_REPEATER',
      request: {
        id: requestId,
        method: parsed.method || 'GET',
        url: parsed.url,
        requestHeaders: parsed.headers || {},
        requestBody: parsed.body || null
      }
    });
    
    intruderState.results.push({
      index: index,
      id: requestId,
      payload: payloadLabel,
      status: 'pending',
      result: null
    });
    
    index++;
    intruderState.completed++;
    updateIntruderUI();
    
    setTimeout(sendNext, delay);
  }
  
  sendNext();
}

function stopIntruder() {
  intruderState.stopRequested = true;
  setStatus('⏹ Stopping Intruder...');
}

// ─── Init ─────────────────────────────────────────────
if (IS_STANDALONE) initStandalone();
connectBackground();
setStatus('PhantomProxy ready');
createSession(null);

loadBookmarks();

var _bmFilterBtn = document.getElementById('btn-filter-bookmarked');
if (_bmFilterBtn) {
  _bmFilterBtn.addEventListener('click', function() {
    bookmarkFilterOn = !bookmarkFilterOn;
    _bmFilterBtn.classList.toggle('active', bookmarkFilterOn);
    renderList();
    setStatus(bookmarkFilterOn ? 'Showing highlighted requests only' : 'Showing all requests');
  });
}

if (window.PhantomFeatures) {
  PhantomFeatures.init(
    function() { return allRequests; },
    function(imported) {
      imported.forEach(function(r) { allRequests.push(r); });
    },
    renderList,
    setStatus
  );
}

var _scopeToggleBtn = document.getElementById('scope-toggle');
if (_scopeToggleBtn) {
  _scopeToggleBtn.addEventListener('click', function() {
    setTimeout(function() {
      _scopeToggleBtn.textContent = window.PhantomFeatures && PhantomFeatures.scopeState.enabled
        ? 'SCOPE ON' : 'SCOPE OFF';
    }, 10);
  });
  _scopeToggleBtn.textContent = 'SCOPE OFF';
}

document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    var active = document.activeElement;
    if (active && (active.id === 'rep-url' || active.id === 'rep-body' || active.id === 'rep-raw')) {
      e.preventDefault();
      doSend();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
    e.preventDefault();
    sendBg({ type: 'CLEAR_REQUESTS' });
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    var fi = document.getElementById('filter-url');
    if (fi) { e.preventDefault(); fi.focus(); fi.select(); }
  }
});

// ─── INTRUDER FILE LOAD ─────────────────────────────────
document.getElementById('intruder-file-input')?.addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  
  setStatus('📂 Selected file: ' + file.name);
  
  var fileNameEl = document.getElementById('intruder-file-name');
  if (fileNameEl) fileNameEl.textContent = file.name;
  
  var reader = new FileReader();
  reader.onload = function(ev) {
    var content = ev.target.result;
    var preview = document.getElementById('intruder-file-preview');
    if (preview) {
      preview.value = content;
      setStatus('✅ Loaded ' + file.name + ' (' + content.split('\n').length + ' payloads)');
    }
  };
  reader.onerror = function() {
    setStatus('❌ Failed to read file');
  };
  reader.readAsText(file);
});

// ─── INTRUDER FILE LOAD BUTTON (label triggers file input) ──
// The label in HTML with for="intruder-file-input" handles this

// Generate numbers
document.getElementById('btn-gen-numbers')?.addEventListener('click', function() {
  var start = parseInt(document.getElementById('num-start').value) || 1;
  var end = parseInt(document.getElementById('num-end').value) || 100;
  var step = parseInt(document.getElementById('num-step').value) || 1;
  var nums = [];
  for (var i = start; i <= end; i += step) {
    nums.push(String(i));
  }
  document.getElementById('intruder-num-preview').value = nums.join('\n');
  setStatus('✅ Generated ' + nums.length + ' numbers');
});

// Start/Stop Intruder
document.getElementById('btn-intruder-start')?.addEventListener('click', startIntruder);
document.getElementById('btn-intruder-stop')?.addEventListener('click', stopIntruder);

// Copy intruder response - FIXED
document.getElementById('btn-intruder-copy')?.addEventListener('click', function() {
  var body = document.getElementById('intruder-response-body');
  if (body && body.textContent) {
    copyText(body.textContent);
    setStatus('Copied ✓');
  }
});