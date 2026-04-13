// content-script.js — Typolishページ上で動作
// popup.js からのメッセージを受け取り、window.postMessage でWebアプリに転送する

const EXPECTED_ORIGIN = (() => {
  const h = location.hostname;
  if (h === 'localhost') return 'http://localhost:3000';
  return 'https://typolish.com';
})();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TYPOLISH_URL_PICKED') {
    window.postMessage(
      {
        type: 'TYPOLISH_URL_PICKED',
        urls: message.urls,
        // なりすまし防止トークン（ページ側で検証）
        _origin: EXPECTED_ORIGIN,
      },
      EXPECTED_ORIGIN
    );
  }
});
