// content-script.js — Typolishページ上で動作
// 拡張機能からのメッセージを受け取り、window.postMessage でWebアプリに転送する

const EXPECTED_ORIGIN = (() => {
  const h = location.hostname;
  if (h === 'localhost') return 'http://localhost:3000';
  return 'https://typolish.com';
})();

chrome.runtime.onMessage.addListener((message) => {
  // URL送信（従来互換）
  if (message.type === 'TYPOLISH_URL_PICKED') {
    window.postMessage(
      {
        type: 'TYPOLISH_URL_PICKED',
        urls: message.urls,
        _origin: EXPECTED_ORIGIN,
      },
      EXPECTED_ORIGIN
    );
  }

  // キャプチャ画像送信（v2: クライアントサイドキャプチャ）
  if (message.type === 'TYPOLISH_CAPTURES') {
    window.postMessage(
      {
        type: 'TYPOLISH_CAPTURES',
        captures: message.captures,
        _origin: EXPECTED_ORIGIN,
      },
      EXPECTED_ORIGIN
    );
  }
});
