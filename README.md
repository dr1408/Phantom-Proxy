# ⬡ PhantomProxy

> A cyberpunk-themed HTTP traffic inspector and repeater — DevTools extension for Edge/Chrome.
> Built for security researchers and bug bounty hunters.

---

## Features

### 📡 History Tab
- Passively captures **all HTTP/HTTPS traffic** from the browser tab (no proxy required)
- Live request stream with method, status, URL, type, and timing
- **Filter by domain/path**, HTTP method, and status code (2xx / 3xx / 4xx / 5xx / ERR)
- Click any request to inspect full **request headers**, **request body**, **response headers**, and a **raw HTTP view**

### ⟳ Repeater Tab
- Send any captured request to the **Repeater** with one click
- Edit method, URL, headers (key/value editor), body, or full raw HTTP
- Multiple **named sessions** — open tabs per request, like Burp Suite
- Live response viewer: body, headers, status, timing
- Body editor supports: JSON (with auto-format), form-encoded, multipart, XML, plain text

### ⌥ Decoder Tab
- Base64 encode/decode
- URL encode/decode
- HTML encode/decode
- Hex encode/decode
- JSON formatter
- **JWT decoder** — inspects header + payload, flags `none` and `HS256` algorithm warnings
- SHA-256 hash
- Chain mode: pipe output back into input for multi-step transforms

### ⎘ Extras
- Copy any request as **cURL** command
- Pause/Resume capture
- Clear all captured traffic
- Status bar with live feedback

---

## Installation

### Edge (and Chrome)

1. Open `edge://extensions/` (or `chrome://extensions/`)
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `phantom-proxy` folder
5. Open any page → press **F12** → find the **⬡ PhantomProxy** panel

---

## Architecture

```
phantom-proxy/
├── manifest.json          # Manifest V3
├── background/
│   └── worker.js          # Service worker: webRequest capture + repeater fetch
├── devtools/
│   └── devtools.html      # Creates the DevTools panel
├── panel/
│   ├── panel.html         # Full UI shell
│   ├── panel.css          # Cyber dark theme
│   └── panel.js           # All UI logic
├── popup/
│   └── popup.html         # Toolbar popup
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### How capture works

PhantomProxy uses the **`webRequest` API** (Manifest V3 compatible) to observe:
- `onBeforeRequest` — URL, method, request body
- `onSendHeaders` — request headers
- `onHeadersReceived` — response status + headers
- `onCompleted` / `onErrorOccurred` — finalize timing

The background service worker stores up to **500 requests** in memory and pushes them to the DevTools panel via a persistent port (`chrome.runtime.connect`).

Repeater requests are fired from the **background worker** using `fetch()` — this avoids CORS issues that would occur from panel context.

---

## Notes

- Requires Edge 88+ or Chrome 88+ (Manifest V3 + `webRequest`)
- Response **bodies** are not captured via `webRequest` (browser restriction) — use the Repeater to re-send and read the response
- The extension does **not** intercept or block traffic — purely passive observation + active replay
- Works on `http://` and `https://` pages

---

## Roadmap ideas
- [ ] Export session as HAR file
- [ ] Import/export repeater sessions
- [ ] Response diff viewer (compare two repeater responses)
- [ ] WebSocket frame inspector
- [ ] Fuzzer tab (payload lists)

---

## PHANTOMPROXY — PRIVACY POLICY
Last updated: June 2026
- No data collection. PhantomProxy does not collect, store, transmit, or share any personal data or user information with any third party, including the developer.
- Local operation only. All HTTP traffic captured by the extension is processed entirely within your local browser. - Request data is held in memory for the duration of your DevTools session and is never sent to any remote server.
- No analytics. The extension contains no analytics, telemetry, crash reporting, or tracking of any kind.
- No external services. The extension makes no outbound connections of its own. The only network requests it makes are those explicitly initiated by the user via the Repeater tab.
- Data you send via Repeater. When you use the Repeater tab to send a request, that request goes directly from your browser to the target URL you specify. No data passes through any server operated by the developer.