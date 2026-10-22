/**
 * Background Service Worker for Accessiblü WCAG 2.2 Tester
 */

// Open as a side panel when the toolbar icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Keyboard shortcut: Ctrl+Shift+A (customisable at chrome://extensions/shortcuts)
// Opens a standalone popup window that receives focus immediately.
// This is the recommended entry point for screen reader and keyboard-only users
// because Chrome does not move focus into the side panel on open.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-accessible-window') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = chrome.runtime.getURL('popup.html')
    + `?expanded=1&tabId=${tab?.id ?? ''}&fromShortcut=1`;
  chrome.windows.create({
    url,
    type:    'popup',
    width:   840,
    height:  680,
    focused: true,   // Chrome gives this window focus — JAWS picks it up automatically
  });
});

// Handle extension installation / update
chrome.runtime.onInstalled.addListener((details) => {
  // Ensure side panel behavior is set after install/update
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  if (details.reason === 'install' || details.reason === 'update') {
    // Side panel behavior is already set above; no further action needed.
  }
});

// Handle messages from content scripts or side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getTabInfo') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse(tabs[0]
        ? { url: tabs[0].url, title: tabs[0].title }
        : { error: 'No active tab' }
      );
    });
    return true;
  }

  if (request.action === 'storeResults') {
    chrome.storage.local.set({
      lastResults:  request.results,
      lastTestDate: new Date().toISOString()
    }, () => sendResponse({ success: true }));
    return true;
  }

  // Focus indicator check: a content script can't read the rules of a
  // stylesheet served from another domain, so it asks for the CSS text here.
  // Only http(s) stylesheets, no cookies sent, capped at 3 MB.
  if (request.action === 'fetchStylesheet') {
    let url;
    try { url = new URL(request.url); } catch (e) { sendResponse({ success: false }); return false; }
    if (!sender.tab || !/^https?:$/.test(url.protocol)) { sendResponse({ success: false }); return false; }
    fetch(url.href, { credentials: 'omit' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 3 * 1024 * 1024) throw new Error('too large');
        sendResponse({ success: true, text });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getStoredResults') {
    chrome.storage.local.get(['lastResults', 'lastTestDate'], (data) => sendResponse(data));
    return true;
  }
});
