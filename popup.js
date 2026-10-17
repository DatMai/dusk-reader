const DEFAULTS = {
  enabled: true,
  mode: 'dynamic',
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  bg: '#181a1b',
  text: '#e8e6e3',
  detectDark: true,
  disabledSites: [],
};

const MODE_HINTS = {
  dynamic: 'Recolors every CSS rule on the page. Best looking, keeps images intact.',
  filter: 'Inverts the whole page with a CSS filter. Fast fallback when Dynamic breaks.',
};

const $ = (id) => document.getElementById(id);
const sliders = ['brightness', 'contrast', 'sepia', 'grayscale'];

let settings = { ...DEFAULTS };
let host = null;
let tabId = null;

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabId = tab.id;
    try {
      const u = new URL(tab.url);
      if (/^https?:$|^file:$/.test(u.protocol)) host = u.hostname;
    } catch {
      host = null;
    }
  }
  render();
  refreshStatus();
}

function render() {
  $('enabled').checked = settings.enabled;
  $('host').textContent = host || 'Browser page';
  const siteOff = host && settings.disabledSites.includes(host);
  $('siteToggle').textContent = siteOff ? 'Enable on this site' : 'Disable on this site';
  $('siteToggle').disabled = !host;

  document.querySelectorAll('.seg button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  });
  $('modeHint').textContent = MODE_HINTS[settings.mode];

  for (const k of sliders) {
    $(k).value = settings[k];
    document.querySelector(`output[for="${k}"]`).textContent = `${settings[k]}%`;
  }
  $('bg').value = settings.bg;
  $('text').value = settings.text;
  $('colors').classList.toggle('disabled', settings.mode === 'filter');
  $('detectDark').checked = settings.detectDark;
}

async function refreshStatus() {
  const el = $('status');
  if (!host) {
    el.textContent = 'Chrome does not allow extensions here';
    return;
  }
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'status' }).catch(() => null);
  let st = await ask();
  if (!st) {
    // tab opened before the extension was installed: inject the script and ask again
    await chrome.runtime.sendMessage({ type: 'inject', tabId });
    await new Promise((r) => setTimeout(r, 300));
    st = await ask();
  }
  const text = !st ? 'Not running yet, try reloading the page'
    : st.active ? (st.reason === 'filter' ? 'On · Filter' : 'On · Dynamic')
    : st.reason === 'already-dark' ? 'Already dark, skipped'
    : st.reason === 'site-off' ? 'Disabled on this site'
    : st.reason === 'off' ? 'Off' : '…';
  el.textContent = text;
}

async function save(patch) {
  Object.assign(settings, patch);
  render();
  await chrome.storage.sync.set(patch);
  setTimeout(refreshStatus, 150);
}

let sliderTimer = 0;
for (const k of sliders) {
  $(k).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    settings[k] = v;
    document.querySelector(`output[for="${k}"]`).textContent = `${v}%`;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => chrome.storage.sync.set({ [k]: v }), 120);
  });
}

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));

$('siteToggle').addEventListener('click', () => {
  const list = new Set(settings.disabledSites);
  list.has(host) ? list.delete(host) : list.add(host);
  save({ disabledSites: [...list] });
});

document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => save({ mode: b.dataset.mode }));
});

let colorTimer = 0;
for (const k of ['bg', 'text']) {
  $(k).addEventListener('input', (e) => {
    settings[k] = e.target.value;
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => chrome.storage.sync.set({ [k]: settings[k] }), 150);
  });
}

$('detectDark').addEventListener('change', (e) => save({ detectDark: e.target.checked }));

$('reset').addEventListener('click', () => {
  const { disabledSites, enabled, ...rest } = DEFAULTS;
  save(rest);
});

init();
