// popup.js — タブ選択 → background.js にキャプチャ指示 → 即閉じ
// ポップアップはタブ切り替えで閉じるため、重い処理は background.js に委譲

// 2026-04-29 dev は port 3001 で動作するため 3000/3001 両方許可
const TYPOLISH_PATTERNS = [
  /typolish\.com/,
  /localhost:3000/,
  /localhost:3001/,
  /127\.0\.0\.1:3000/,
  /127\.0\.0\.1:3001/,
];

// 2026-04-30 Chrome ウェブストアは scripting / captureVisibleTab が
// "The extensions gallery cannot be scripted." で拒否されるため除外
const BLOCKED_PATTERNS = [
  /^chrome:/, /^chrome-extension:/, /^about:/,
  /^edge:/, /^moz-extension:/, /^devtools:/,
  /^https?:\/\/chrome\.google\.com\/webstore/,
  /^https?:\/\/chromewebstore\.google\.com/,
];

function isTypolishTab(url) {
  return TYPOLISH_PATTERNS.some((p) => p.test(url));
}

function isBlockedUrl(url) {
  if (!url) return true;
  return BLOCKED_PATTERNS.some((p) => p.test(url)) || isTypolishTab(url);
}

function getFaviconUrl(tab) {
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    return tab.favIconUrl;
  }
  try {
    return `${new URL(tab.url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

let allTabs = [];
let selectedUrls = new Set();

function renderTabs(tabs) {
  const list = document.getElementById('tab-list');
  const empty = document.getElementById('empty');
  list.innerHTML = '';

  if (tabs.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tabs.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'tab-item' + (selectedUrls.has(tab.url) ? ' checked' : '');
    li.dataset.url = tab.url;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-checkbox';
    checkbox.checked = selectedUrls.has(tab.url);
    checkbox.addEventListener('change', () => onToggle(tab.url, checkbox.checked, li));

    const faviconUrl = getFaviconUrl(tab);
    let faviconEl;
    if (faviconUrl) {
      faviconEl = document.createElement('img');
      faviconEl.src = faviconUrl;
      faviconEl.className = 'tab-favicon';
      faviconEl.onerror = () => faviconEl.replaceWith(makeFallbackFavicon());
    } else {
      faviconEl = makeFallbackFavicon();
    }

    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;

    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = tab.url;

    info.appendChild(title);
    info.appendChild(url);
    li.appendChild(checkbox);
    li.appendChild(faviconEl);
    li.appendChild(info);

    li.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      onToggle(tab.url, checkbox.checked, li);
    });

    list.appendChild(li);
  });
}

function makeFallbackFavicon() {
  const div = document.createElement('div');
  div.className = 'tab-favicon-fallback';
  div.textContent = '\uD83C\uDF10';
  return div;
}

function onToggle(url, checked, li) {
  if (checked) {
    selectedUrls.add(url);
    li.classList.add('checked');
  } else {
    selectedUrls.delete(url);
    li.classList.remove('checked');
  }
  updateSendBtn();
}

function updateSendBtn() {
  const btn = document.getElementById('send-btn');
  const count = document.getElementById('count');
  const n = selectedUrls.size;
  count.textContent = n;
  btn.disabled = n === 0;
}

function filterTabs(query) {
  if (!query) return allTabs;
  const q = query.toLowerCase();
  return allTabs.filter(
    (t) => t.title?.toLowerCase().includes(q) || t.url?.toLowerCase().includes(q)
  );
}

// ── 初期化 ──

document.addEventListener('DOMContentLoaded', async () => {
  const tabs = await chrome.tabs.query({});
  allTabs = tabs.filter((t) => t.url && !isBlockedUrl(t.url));
  renderTabs(allTabs);

  document.getElementById('search').addEventListener('input', (e) => {
    renderTabs(filterTabs(e.target.value));
  });

  document.getElementById('send-btn').addEventListener('click', async () => {
    const tabs = allTabs.filter((t) => selectedUrls.has(t.url));
    if (tabs.length === 0) return;

    // background.js にキャプチャ指示（ポップアップは閉じてOK）
    // 2026-04-30 windowId を必ず送る — PWA フォーカス時に captureVisibleTab(undefined)
    // が PWA 画面を撮ってしまう問題対策
    await chrome.runtime.sendMessage({
      type: 'CAPTURE_TABS',
      tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, url: t.url, title: t.title })),
    });

    // 即閉じ — キャプチャ進捗はバッジで表示される
    window.close();
  });
});
