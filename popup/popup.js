"use strict";

document.getElementById("btn-execute").addEventListener("click", () => {
  // Open PhantomProxy as a standalone full-size window
  const url = chrome.runtime.getURL("panel/panel.html") + "?mode=standalone";

  chrome.windows.create({
    url,
    type: "popup",
    width: 1440,
    height: 900,
    focused: true,
  }, (win) => {
    // Store window id so we don't open duplicates
    chrome.storage.local.set({ standaloneWindowId: win.id });
  });

  // Close the popup
  window.close();
});

// On popup open — check if standalone window already exists
// and focus it instead of creating a new one
chrome.storage.local.get("standaloneWindowId", ({ standaloneWindowId }) => {
  if (!standaloneWindowId) return;

  chrome.windows.get(standaloneWindowId, (win) => {
    if (chrome.runtime.lastError || !win) {
      // Window no longer exists — clear stored id
      chrome.storage.local.remove("standaloneWindowId");
      return;
    }

    // Window exists — update button to say "FOCUS"
    const btn = document.getElementById("btn-execute");
    btn.innerHTML = '<span class="execute-icon">◈</span> FOCUS WINDOW';

    btn.addEventListener("click", () => {
      chrome.windows.update(standaloneWindowId, { focused: true });
      window.close();
    }, { once: true }); // replace the open-new-window listener
  });
});
