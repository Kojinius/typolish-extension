// popup.js — タブ取得・フィルタ・UI・送信ロジック

const TYPOLISH_PATTERNS = [
  /typolish\.com/,
  /localhost:3000/,
];

const BLOCKED_PATTERNS = [
  /^chrome:/,
  /^chrome-extension:/,
  /^about:/,
  /^edge:/,
  /^moz-extension:/,
  /^devtools:/,
];

/** タブがTypolishかどうか判定 */
function isTypolishTab(url) {
  return TYPOLISH_PATTERNS.some((p) => p.test(url));
}

/** 送信対象から除外するURLか判定 */
function isBlockedUrl(url) {
  if (!url) return true;
  return BLOCKED_PATTERNS.some((p) => p.test(url)) || isTypolishTab(url);
}

/** ファビコンURLを安全に取得 */
function getFaviconUrl(tab) {
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    return tab.favIconUrl;
  }
  try {
    const origin = new URL(tab.url).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return null;
  }
}

let allTabs = [];
let selectedUrls = new Set();

/** タブ一覧をレンダリング */
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

    // チェックボックス
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-checkbox';
    checkbox.checked = selectedUrls.has(tab.url);
    checkbox.addEventListener('change', () => onToggle(tab.url, checkbox.checked, li));

    // ファビコン
    const faviconUrl = getFaviconUrl(tab);
    let faviconEl;
    if (faviconUrl) {
      faviconEl = document.createElement('img');
      faviconEl.src = faviconUrl;
      faviconEl.className = 'tab-favicon';
      faviconEl.onerror = () => {
        faviconEl.replaceWith(makeFallbackFavicon());
      };
    } else {
      faviconEl = makeFallbackFavicon();
    }

    // タブ情報
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

    // 行クリックでチェックボックスをトグル
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
  div.textContent = '🌐';
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

/** 検索フィルタ */
function filterTabs(query) {
  if (!query) return allTabs;
  const q = query.toLowerCase();
  return allTabs.filter(
    (t) => t.title?.toLowerCase().includes(q) || t.url?.toLowerCase().includes(q)
  );
}

/** Typolishタブを探してURLを送信 */
async function sendUrls(urls) {
  const tabs = await chrome.tabs.query({});
  const typolishTab = tabs.find((t) => t.url && isTypolishTab(t.url));

  if (!typolishTab?.id) {
    alert('Typolishのページが見つかりません。typolish.com を開いてください。');
    return false;
  }

  try {
    await chrome.tabs.sendMessage(typolishTab.id, {
      type: 'TYPOLISH_URL_PICKED',
      urls,
    });
  } catch {
    // content-script が未注入の場合（ページリロード直後等）は無視
    console.warn('[Typolish] sendMessage failed — content script may not be ready');
  }

  // Typolishタブをアクティブに
  await chrome.tabs.update(typolishTab.id, { active: true });
  return true;
}

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  const tabs = await chrome.tabs.query({});
  allTabs = tabs.filter((t) => t.url && !isBlockedUrl(t.url));
  renderTabs(allTabs);

  // 検索
  document.getElementById('search').addEventListener('input', (e) => {
    renderTabs(filterTabs(e.target.value));
  });

  // 送信
  document.getElementById('send-btn').addEventListener('click', async () => {
    const btn = document.getElementById('send-btn');
    const urls = [...selectedUrls];
    btn.disabled = true;
    btn.textContent = '送信中...';

    const ok = await sendUrls(urls);
    if (ok) {
      btn.textContent = '送信しました ✓';
      btn.classList.add('success');
      setTimeout(() => window.close(), 800);
    } else {
      btn.disabled = false;
      updateSendBtn();
    }
  });
});
