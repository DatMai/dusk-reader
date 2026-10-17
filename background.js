// Dusk Reader: service worker.
// Handles default settings, keyboard shortcuts, and fetching cross-origin CSS for the content script
// (a content script cannot read cssRules of a cross-origin stylesheet).

const DEFAULTS = {
  enabled: true,
  mode: 'dynamic', // 'dynamic' | 'filter'
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  bg: '#181a1b',
  text: '#e8e6e3',
  detectDark: true,
  disabledSites: [],
};

const MAX_CSS_BYTES = 8 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in current)) missing[k] = v;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  updateBadge();
  // Chrome does not inject content scripts into tabs opened before install, so do it here
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  await Promise.all(tabs.map(injectInto));
});

function injectInto(tab) {
  return chrome.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
    .catch(() => {}); // Chrome Web Store pages, closed tabs...
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'inject' || sender.tab) return false;
  chrome.tabs.get(msg.tabId).then(injectInto).then(() => sendResponse({ ok: true }));
  return true;
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) updateBadge();
});

async function updateBadge() {
  const { enabled } = await chrome.storage.sync.get({ enabled: DEFAULTS.enabled });
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b6f76' });
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$|^file:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  if (command === 'toggle') {
    await chrome.storage.sync.set({ enabled: !s.enabled });
  } else if (command === 'toggle-site') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = tab && hostOf(tab.url);
    if (!host) return;
    const list = new Set(s.disabledSites);
    list.has(host) ? list.delete(host) : list.add(host);
    await chrome.storage.sync.set({ disabledSites: [...list] });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return false;
  const job = msg.type === 'fetch-css' ? fetchCSS(msg.url)
    : msg.type === 'fetch-image' ? fetchImage(msg.url)
    : null;
  if (!job) return false;
  job.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // respond asynchronously
});

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Cross-origin images taint a canvas, so fetch them here and return a data URL.
async function fetchImage(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported protocol');
  const res = await fetch(u.href, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES || !blob.type.startsWith('image/')) throw new Error('not a small image');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { dataURL: `data:${blob.type};base64,${btoa(bin)}` };
}

async function fetchCSS(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported protocol');
  const res = await fetch(u.href, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_CSS_BYTES) throw new Error('stylesheet too large');
  const text = await res.text();
  if (text.length > MAX_CSS_BYTES) throw new Error('stylesheet too large');
  return { text };
}
