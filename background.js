// background.js — Service Worker: フルページキャプチャ → Typolishに自律送信
// ポップアップはタブ切り替え時に閉じるため、全処理をここで完結させる

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TABS') {
    captureAndSend(msg.tabs);
    sendResponse({ started: true });
  }
  return true;
});

async function captureAndSend(tabs) {
  const results = [];

  for (let i = 0; i < tabs.length; i++) {
    // バッジで進捗表示
    chrome.action.setBadgeText({ text: `${i + 1}/${tabs.length}` });
    chrome.action.setBadgeBackgroundColor({ color: '#e86c00' });

    try {
      const result = await captureFullPage(tabs[i]);
      results.push(result);
    } catch (e) {
      console.error(`[capture] Failed: ${tabs[i].url}`, e.message);
    }
  }

  // Typolishタブを探して送信
  const allTabs = await chrome.tabs.query({});
  const typolishTab = allTabs.find(
    (t) => t.url && (/typolish\.com/.test(t.url) || /localhost:3000/.test(t.url))
  );

  const validCaptures = results.filter((r) => r.image);
  const totalSize = validCaptures.reduce((s, c) => s + (c.image?.length || 0), 0);
  console.log(`[capture] results: ${results.length}, valid: ${validCaptures.length}, totalSize: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
  console.log(`[capture] typolishTab: ${typolishTab?.id ?? 'NOT FOUND'} (${typolishTab?.url ?? ''})`);

  if (typolishTab?.id && validCaptures.length > 0) {
    try {
      // content-script経由ではなく、直接ページのmain worldにpostMessageを注入
      for (const capture of validCaptures) {
        await chrome.scripting.executeScript({
          target: { tabId: typolishTab.id },
          world: 'MAIN',
          func: (cap) => {
            window.postMessage({
              type: 'TYPOLISH_CAPTURES',
              captures: [cap],
            }, window.location.origin);
          },
          args: [capture],
        });
      }
      console.log(`[capture] postMessage injected: ${validCaptures.length} captures`);
    } catch (e) {
      console.error('[capture] inject FAILED:', e.message);
    }
    await chrome.tabs.update(typolishTab.id, { active: true });
  } else {
    console.warn(`[capture] skipped: typolishTab=${!!typolishTab}, validCaptures=${validCaptures.length}`);
  }

  // バッジ: 完了表示 → クリア
  chrome.action.setBadgeText({ text: '\u2713' });
  chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

async function captureFullPage(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(500);

  // ページ寸法を取得
  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      scrollHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      ),
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
    }),
  });

  const { scrollHeight, clientHeight, clientWidth, devicePixelRatio: dpr } = dims;

  // アニメーション凍結
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const style = document.createElement('style');
      style.id = '__typolish_freeze';
      style.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }';
      document.head.appendChild(style);
    },
  });

  // スクロール位置を計算
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const positions = [];
  for (let y = 0; y < maxScroll; y += clientHeight) {
    positions.push(y);
  }
  positions.push(maxScroll);
  const uniquePositions = [...new Set(positions)];

  // 各ストリップをキャプチャ
  const strips = [];
  for (let i = 0; i < uniquePositions.length; i++) {
    const y = uniquePositions[i];

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (scrollY) => window.scrollTo(0, scrollY),
      args: [y],
    });

    // ページJSの処理完了を待つ（IO/scroll handler等）
    await sleep(350);

    // 2番目以降: スクロール＋JS処理完了後にfixed/sticky要素を検出して非表示
    if (i >= 1) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.querySelectorAll('*').forEach((el) => {
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') {
              if (!el.hasAttribute('data-typolish-fixed')) {
                el.setAttribute('data-typolish-fixed', el.style.visibility || '');
              }
              el.style.setProperty('visibility', 'hidden', 'important');
            }
          });
          // 強制リフロー — スタイル変更をレンダーツリーに確定
          void document.documentElement.offsetHeight;
        },
      });
      // リペイント完了を待ってからキャプチャ
      await sleep(50);
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    await sleep(650); // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND 制限回避
    strips.push({ dataUrl, y });
  }

  // 凍結解除 + fixed/sticky復元 + トップに戻す
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.getElementById('__typolish_freeze')?.remove();
      document.querySelectorAll('[data-typolish-fixed]').forEach((el) => {
        const orig = el.getAttribute('data-typolish-fixed');
        if (orig) {
          el.style.visibility = orig;
        } else {
          el.style.removeProperty('visibility');
        }
        el.removeAttribute('data-typolish-fixed');
      });
      window.scrollTo(0, 0);
    },
  });

  // ステッチ
  const image = await stitchStrips(strips, scrollHeight, clientHeight, clientWidth, dpr);
  return { url: tab.url, title: tab.title, image };
}

async function stitchStrips(strips, scrollHeight, clientHeight, clientWidth, dpr) {
  if (strips.length === 1) return strips[0].dataUrl;

  const canvasWidth = Math.round(clientWidth * dpr);
  const canvasHeight = Math.round(scrollHeight * dpr);

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  for (const strip of strips) {
    const response = await fetch(strip.dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const drawY = Math.round(strip.y * dpr);
    ctx.drawImage(bitmap, 0, drawY);
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
