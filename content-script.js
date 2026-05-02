// content-script.js — Typolishページ上で動作
// 拡張機能 ↔ Web アプリの postMessage 双方向ブリッジ
//
// 2026-04-29 v2.0.0: 拡張機能 → Web アプリ（TYPOLISH_URL_PICKED, TYPOLISH_CAPTURES）
// 2026-05-01 v2.1.0: Web アプリ → 拡張機能（TYPOLISH_RENDER_PROOF_REQUEST）
//                    HTML プルーフ Phase B（zip-upload-and-extension-capture.md §3.2）

const EXPECTED_ORIGIN = (() => {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') {
    return `${location.protocol}//${location.host}`;
  }
  return 'https://typolish.com';
})();

// ───── 拡張機能 → Web アプリ（既存）─────
chrome.runtime.onMessage.addListener((message) => {
  // URL送信（v1 互換）
  if (message.type === 'TYPOLISH_URL_PICKED') {
    window.postMessage(
      { type: 'TYPOLISH_URL_PICKED', urls: message.urls, _origin: EXPECTED_ORIGIN },
      EXPECTED_ORIGIN
    );
  }

  // キャプチャ画像送信（v2: Web スクショ）
  if (message.type === 'TYPOLISH_CAPTURES') {
    window.postMessage(
      { type: 'TYPOLISH_CAPTURES', captures: message.captures, _origin: EXPECTED_ORIGIN },
      EXPECTED_ORIGIN
    );
  }

  // HTML プルーフ生成 ACK / DONE（v2.1.0）
  if (message.type === 'TYPOLISH_RENDER_PROOF_ACK' || message.type === 'TYPOLISH_RENDER_PROOF_DONE') {
    window.postMessage(
      {
        type: message.type,
        proofId: message.proofId,
        versionId: message.versionId,
        status: message.status,
        errors: message.errors,
        _origin: EXPECTED_ORIGIN,
      },
      EXPECTED_ORIGIN
    );
  }
});

// ───── Web アプリ → 拡張機能（v2.1.0）─────
// Web アプリが window.postMessage で送るリクエストを background に転送
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== EXPECTED_ORIGIN) return;
  if (typeof event.data !== 'object' || event.data === null) return;

  if (event.data.type === 'TYPOLISH_RENDER_PROOF_REQUEST') {
    // 即時 ACK を返す（Web アプリのインストール検知タイマー回避）
    window.postMessage(
      {
        type: 'TYPOLISH_RENDER_PROOF_ACK',
        proofId: event.data.proofId,
        versionId: event.data.versionId,
        _origin: EXPECTED_ORIGIN,
      },
      EXPECTED_ORIGIN
    );
    // background に処理依頼
    chrome.runtime.sendMessage({
      type: 'RENDER_PROOF',
      proofId: event.data.proofId,
      versionId: event.data.versionId,
      proofUrl: event.data.proofUrl,
      callbackUrl: event.data.callbackUrl,
      authToken: event.data.authToken,
      viewports: event.data.viewports,
      typolishTabId: undefined, // background が現在タブから取得
    }).catch((e) => {
      console.error('[content-script] RENDER_PROOF dispatch failed:', e);
      window.postMessage(
        {
          type: 'TYPOLISH_RENDER_PROOF_DONE',
          proofId: event.data.proofId,
          versionId: event.data.versionId,
          status: 'failed',
          errors: [{ viewport: 'all', reason: 'dispatch failed' }],
          _origin: EXPECTED_ORIGIN,
        },
        EXPECTED_ORIGIN
      );
    });
  }
});
