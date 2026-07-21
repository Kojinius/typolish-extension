// background.js — Service Worker: フルページキャプチャ → Typolishに自律送信
// ポップアップはタブ切り替え時に閉じるため、全処理をここで完結させる
//
// v2.1.0（2026-05-01）: HTML プルーフ生成（RENDER_PROOF）対応
// 設計書: documents/design/zip-upload-and-extension-capture.md §3.2 / §4.3
//
// 2026-05-13 19:30:00 claude-opus-4-7[1m] セッションターン数：-
// v2.2.0: Calendar/Form/Maps iframe を Placeholder 静的置換（決定論性確保）
// 設計書: typolish/documents/design/html-proof-dynamic-iframe-static.md §5
//
// 2026-07-21 21:34:16 claude-fable-5 セッションターン数：7
// v2.3.0: 校正画像を R2 署名 PUT で直アップロード（Vercel 4.5MB 上限 413 の根治）+
// callback 失敗を DONE status に反映。旧サーバへは base64 自動フォールバック。
// 設計書: typolish/documents/design/extension-screenshot-payload-limit-fix.md §5

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TABS') {
    captureAndSend(msg.tabs);
    sendResponse({ started: true });
  }
  // v2.1.0: HTML プルーフ生成（content-script からの依頼）
  if (msg.type === 'RENDER_PROOF') {
    handleRenderProof(msg, sender).catch((e) => {
      console.error('[render-proof] FATAL', e);
    });
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
  // 2026-04-29 dev は port 3001 で動作するため 3000/3001 両方許可
  const allTabs = await chrome.tabs.query({});
  const typolishTab = allTabs.find(
    (t) => t.url && (
      /typolish\.com/.test(t.url) ||
      /localhost:3000/.test(t.url) ||
      /localhost:3001/.test(t.url) ||
      /127\.0\.0\.1:3000/.test(t.url) ||
      /127\.0\.0\.1:3001/.test(t.url)
    )
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
    // 2026-04-30 PWA / 別ウィンドウから戻すためにウィンドウもフォーカス
    if (typolishTab.windowId !== undefined) {
      try {
        await chrome.windows.update(typolishTab.windowId, { focused: true });
      } catch (e) {
        console.warn('[capture] windows.update typolish failed:', e.message);
      }
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
  // 2026-04-30 PWA フォーカス時のキャプチャ取り違え対策
  // captureVisibleTab(undefined) は「現在フォーカスされてるウィンドウ」を撮る。
  // PWA 起動中だと PWA 画面がそこ → 必ず target tab の windowId にフォーカス +
  // captureVisibleTab に明示的に windowId を渡す。
  if (tab.windowId !== undefined) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      console.warn('[capture] windows.update failed:', e.message);
    }
  }
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(500);

  // 2026-05-13 19:30:00 claude-opus-4-7[1m] セッションターン数：-
  // v2.2.0: 動的 iframe（Calendar / Form / Maps）を Placeholder 静的置換
  // scrollHeight 計測の手前で inject → forced reflow まで完了させる。順序を逆にすると
  // iframe の遅延ロードで scrollHeight がブレて strip ステッチがズレる
  // 設計書: typolish/documents/design/html-proof-dynamic-iframe-static.md §5.1
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const placeholders = [
          { selector: 'iframe[src*="calendar.google.com/calendar/embed"]', label: 'Google Calendar', tag: 'calendar' },
          { selector: 'iframe[src*="docs.google.com/forms"]', label: 'Google Form', tag: 'form' },
          { selector: 'iframe[src*="google.com/maps"], iframe[src*="maps.google"]', label: 'Google Maps', tag: 'maps' },
        ];
        placeholders.forEach(({ selector, label, tag }) => {
          document.querySelectorAll(selector).forEach((iframe) => {
            const rect = iframe.getBoundingClientRect();
            const w = Math.round(rect.width) || 400;
            const h = Math.round(rect.height) || 300;
            const ph = document.createElement('div');
            ph.setAttribute('data-typolish-placeholder', tag);
            ph.style.cssText =
              'width:' + w + 'px !important; height:' + h + 'px !important;' +
              'background:#f8f4ec; border:1px solid #d4c4a8; border-radius:4px;' +
              'display:flex !important; flex-direction:column;' +
              'align-items:center; justify-content:center;' +
              'font-family:sans-serif; color:#7a6850; box-sizing:border-box;';
            ph.innerHTML =
              '<p style="margin:0;font-size:13px;font-weight:600">' + label + '</p>' +
              '<p style="margin:2px 0 0;font-size:11px;opacity:0.6">校正では静的表示</p>';
            iframe.parentNode.replaceChild(ph, iframe);
          });
        });
        void document.documentElement.offsetHeight; // 強制リフロー
      },
    });
  } catch (e) {
    console.warn('[capture] dynamic iframe placeholder inject failed:', e.message);
  }

  // 2026-05-13 23:30:00 claude-opus-4-7[1m] セッションターン数：-
  // v2.2.0 追加: DOM 安定化待ち
  // 設計書 §1.1 問題 1+2 対処：HTML 内の JS 非同期 fetch（Apps Script 等）が
  // scrollHeight 初回測定後に DOM 書き換えると strip ステッチで重複/欠落が発生する。
  // document.fonts.ready + MutationObserver で「最終 mutation から 1.5 秒以上変化なし」
  // を idle 判定し、Apps Script fetch + table 描画完了まで待つ。最大 10 秒で諦める
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => new Promise((resolve) => {
        const IDLE_MS = 1500;
        const HARD_TIMEOUT_MS = 10000;
        const start = Date.now();
        const fontsReady = (document.fonts && document.fonts.ready) || Promise.resolve();
        Promise.resolve(fontsReady).then(() => {
          let lastMutation = Date.now();
          const observer = new MutationObserver(() => { lastMutation = Date.now(); });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'src', 'srcset'],
          });
          const check = () => {
            const now = Date.now();
            if (now - start > HARD_TIMEOUT_MS) {
              observer.disconnect();
              resolve({ reason: 'hard-timeout', elapsed: now - start });
              return;
            }
            if (now - lastMutation > IDLE_MS) {
              observer.disconnect();
              resolve({ reason: 'idle', elapsed: now - start });
              return;
            }
            setTimeout(check, 200);
          };
          setTimeout(check, 300);
        });
      }),
    });
  } catch (e) {
    console.warn('[capture] DOM stabilization wait failed:', e.message);
  }

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

  // アニメーション凍結 + scrollbar 非表示化
  // 2026-05-01: scrollbar 17px が popup の inner content 幅を縮める → ライブ iframe と
  // 折り返し位置が 1-2 文字ズレる問題を回避するため scrollbar を完全に非表示化
  // （スクロールは window.scrollTo で動かすため scrollbar UI は不要）
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const style = document.createElement('style');
      style.id = '__typolish_freeze';
      style.textContent = [
        '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }',
        'html { scrollbar-width: none !important; }',
        'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }',
      ].join('\n');
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

    // 2026-04-30 PWA 取り違え対策 — undefined だとフォーカス窓を撮るので明示指定
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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

// ─────────────────────────────────────────────────────────────
// v2.1.0: HTML プルーフ生成（RENDER_PROOF）
// 設計書 §3.2: viewport 別ポップアップウィンドウで proofUrl を開いて captureFullPage 実行
// 各 viewport 完了後 callbackUrl に POST、最後に TYPOLISH_RENDER_PROOF_DONE で
// content-script 経由で Web アプリに通知する。
// ─────────────────────────────────────────────────────────────

// 2026-07-21 21:34:16 claude-fable-5 セッションターン数：7
// v2.3.0: 校正画像を R2 へ署名 PUT で直アップロードし、callback には storagePath 参照だけを送る。
// 旧実装（3 viewport の base64 を 1 本の JSON で callback へ POST）は Vercel 関数の
// リクエスト本文上限 4.5MB を超えると 413 で全滅していた（2026-07-21 本番実測・縦長 HTML で再現）。
// サーバが古く /api/extension/upload-url が 404 の場合は従来の base64 形式へ自動フォールバック。
// 設計書: typolish/documents/design/extension-screenshot-payload-limit-fix.md §5
async function uploadScreenshotToR2(origin, authToken, ids, viewportName, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const res = await fetch(`${origin}/api/extension/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: authToken,
      projectId: ids.projectId,
      proofId: ids.proofId,
      versionId: ids.versionId,
      viewport: viewportName,
      contentType: blob.type,
    }),
  });
  if (res.status === 404) return { legacyServer: true }; // 旧サーバ（route 未デプロイ）
  if (!res.ok) throw new Error(`upload-url HTTP ${res.status}`);
  const { uploadUrl, storagePath } = await res.json();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (!put.ok) throw new Error(`R2 PUT HTTP ${put.status}`);
  return { storagePath };
}

async function handleRenderProof(msg, sender) {
  const { proofId, versionId, proofUrl, callbackUrl, authToken, viewports } = msg;
  const typolishTabId = sender?.tab?.id; // 通知の戻り先

  const screenshots = {};
  // v2.3.0: viewport → storagePath（R2 直アップロード成功分）。legacyServer 検知で base64 送信へ切替
  const uploadedPaths = {};
  let legacyServer = false;
  const errors = [];
  let renderWindowId = null;
  let renderTabId = null;

  try {
    // 1. ポップアップウィンドウ作成（最初の viewport サイズで仮）
    //    後で outer/inner 差分を計測して厳密リサイズする
    const firstVp = viewports[0];
    const win = await chrome.windows.create({
      url: appendAuthToUrl(proofUrl, authToken),
      type: 'popup',
      focused: true,
      width: firstVp.width + 32, // 仮の余白（後で正確にリサイズ）
      height: firstVp.height + 100,
      left: 0,
      top: 0,
    });
    renderWindowId = win.id;
    renderTabId = win.tabs?.[0]?.id;
    if (!renderTabId) throw new Error('render tab open failed');

    // 2. 初回ロード待ち
    await waitForTabComplete(renderTabId, 30_000);
    await sleep(500);

    // 3. scrollbar 永続非表示 inject（innerWidth 計測前に実行）
    //    これをやる前に innerWidth を測ると scrollbar 17px が紛れて windows.update の補正がズレる
    try {
      await chrome.scripting.executeScript({
        target: { tabId: renderTabId },
        func: () => {
          const style = document.createElement('style');
          style.id = '__typolish_persistent_hide_scrollbar';
          style.textContent = [
            'html, body { scrollbar-width: none !important; -ms-overflow-style: none !important; }',
            'html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {',
            '  display: none !important; width: 0 !important; height: 0 !important;',
            '}',
          ].join('\n');
          document.head.appendChild(style);
        },
      });
      await sleep(150); // reflow 反映
    } catch (e) {
      console.warn('[render-proof] persistent scrollbar-hide inject failed:', e.message);
    }

    // 4. ウィンドウ outer/inner 差分を計測（chrome UI 境界のみ、scrollbar は既に消えている）
    //    これを viewport.width に加算して windows.update すると inner width = viewport.width
    let widthDelta = 16;  // フォールバック
    let heightDelta = 80; // フォールバック
    try {
      const [{ result: dims }] = await chrome.scripting.executeScript({
        target: { tabId: renderTabId },
        func: () => ({
          outerWidth: window.outerWidth,
          innerWidth: window.innerWidth,
          outerHeight: window.outerHeight,
          innerHeight: window.innerHeight,
          clientWidth: document.documentElement.clientWidth,
        }),
      });
      if (dims) {
        widthDelta = Math.max(0, dims.outerWidth - dims.innerWidth);
        heightDelta = Math.max(0, dims.outerHeight - dims.innerHeight);
        console.log('[render-proof] dims', dims, 'widthDelta=', widthDelta, 'heightDelta=', heightDelta);
      }
    } catch (e) {
      console.warn('[render-proof] dims measurement failed, using fallback:', e.message);
    }

    // 4. 各 viewport で正確リサイズ → fonts.ready 待ち → captureFullPage
    for (const vp of viewports) {
      try {
        await chrome.windows.update(renderWindowId, {
          width: vp.width + widthDelta,
          height: vp.height + heightDelta,
        });
        await sleep(700); // resize 反映 + reflow
        // フォントロード完了を待つ（行間ズレ防止）
        try {
          await chrome.scripting.executeScript({
            target: { tabId: renderTabId },
            func: async () => {
              if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
              }
            },
          });
        } catch {}
        await sleep(200);

        const result = await captureFullPage({ id: renderTabId, windowId: renderWindowId, url: proofUrl, title: '' });
        if (result.image) {
          screenshots[vp.name] = result.image;
          // 2026-07-21 21:34:16 claude-fable-5 セッションターン数：7
          // v2.3.0: viewport ごとに R2 直アップロードを試行。旧サーバ（upload-url 404）検知後はスキップし
          // 従来の base64 一括送信へフォールバック。アップロード失敗は該当 viewport のみ errors 計上
          // （callback で storagePath 参照が無い viewport はサーバ側 partial 規約に乗る）。
          if (!legacyServer) {
            try {
              const projectId = parseProjectIdFromProofUrl(proofUrl);
              const up = await uploadScreenshotToR2(
                new URL(callbackUrl).origin,
                authToken,
                { projectId, proofId, versionId },
                vp.name,
                result.image,
              );
              if (up.legacyServer) {
                legacyServer = true;
                console.warn('[render-proof] upload-url 404 → legacy base64 callback にフォールバック');
              } else {
                uploadedPaths[vp.name] = up.storagePath;
              }
            } catch (e) {
              errors.push({ viewport: vp.name, reason: `upload failed: ${e.message || 'unknown'}` });
              console.error(`[render-proof] upload viewport=${vp.name} failed:`, e);
            }
          }
        } else {
          errors.push({ viewport: vp.name, reason: 'no image' });
        }
      } catch (e) {
        errors.push({ viewport: vp.name, reason: e.message || 'capture failed' });
        console.error(`[render-proof] viewport=${vp.name} failed:`, e);
      }
    }

    // 4. callback URL に POST（status は成否で判定）
    // 2026-07-21 21:34:16 claude-fable-5 セッションターン数：7
    // v2.3.0: 全キャプチャ済み viewport のアップロードが揃っていれば storagePath 参照形式（数百 byte）。
    // 旧サーバ or アップロード不成立分がある場合は従来の base64 形式（4.5MB 上限内なら従来どおり成功）。
    const successCount = Object.keys(screenshots).length;
    let status = successCount === 0 ? 'failed' : (errors.length > 0 ? 'partial' : 'success');
    // viewport 単位で参照形式と base64 を混在可（サーバは viewport ごとに両形式を受理）。
    // アップロード成功分は数百 byte の参照、失敗分のみ base64 → 本文サイズを常に最小化。
    const callbackScreenshots = legacyServer
      ? screenshots
      : Object.fromEntries(
          Object.entries(screenshots).map(([vp, dataUrl]) =>
            uploadedPaths[vp] ? [vp, { storagePath: uploadedPaths[vp] }] : [vp, dataUrl],
          ),
        );
    const callbackPayload = { token: authToken, projectId: parseProjectIdFromProofUrl(proofUrl), proofId, versionId, status, screenshots: callbackScreenshots, errors };

    // 2026-07-21 21:34:16 claude-fable-5 セッションターン数：7
    // v2.3.0: callback の成否を DONE status に反映する。旧実装は callback が 413/500 でも
    // 'success' を通知しており、Web 側が Cloud Run フォールバックに入れず「無言で画像が出ない」
    // 状態になっていた（2026-07-21 本番実測の二次欠陥）。
    let callbackOk = false;
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callbackPayload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[render-proof] callback HTTP ${res.status}: ${body}`);
        errors.push({ viewport: 'callback', reason: `HTTP ${res.status}` });
      } else {
        callbackOk = true;
      }
    } catch (e) {
      console.error('[render-proof] callback FAILED:', e);
      errors.push({ viewport: 'callback', reason: e.message || 'callback failed' });
    }
    if (!callbackOk) {
      status = 'failed'; // サーバに 1 枚も届いていない＝Web 側はフォールバックへ
    }

    // 5. typolish タブに DONE 通知
    if (typolishTabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(typolishTabId, {
          type: 'TYPOLISH_RENDER_PROOF_DONE',
          proofId,
          versionId,
          status,
          errors,
        });
      } catch (e) {
        console.warn('[render-proof] DONE notify failed:', e.message);
      }
    }
  } catch (e) {
    console.error('[render-proof] handler FATAL:', e);
    if (typolishTabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(typolishTabId, {
          type: 'TYPOLISH_RENDER_PROOF_DONE',
          proofId,
          versionId,
          status: 'failed',
          errors: [{ viewport: 'all', reason: e.message || 'fatal' }],
        });
      } catch {}
    }
  } finally {
    // 6. ポップアップウィンドウクローズ + Typolish タブにフォーカス
    if (renderWindowId !== null) {
      try { await chrome.windows.remove(renderWindowId); } catch {}
    }
    if (typolishTabId !== undefined) {
      try {
        const tab = await chrome.tabs.get(typolishTabId);
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(typolishTabId, { active: true });
      } catch {}
    }
  }
}

function appendAuthToUrl(url, token) {
  // v2.1.0: 拡張機能ポップアップは新規タブナビゲーションのため、Typolish の Cookie が未発行の状態
  // で proofUrl にアクセスする可能性がある。catchall Route が ?token= で受け入れる HMAC 認証経路
  // を持つので、そこに token を流す。
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function parseProjectIdFromProofUrl(proofUrl) {
  // /api/proof-content/{projectId}/{proofId}/{versionId}/{path}
  const match = /\/api\/proof-content\/([^/]+)\//.exec(proofUrl);
  return match ? decodeURIComponent(match[1]) : '';
}

async function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // すでに complete の可能性
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}
