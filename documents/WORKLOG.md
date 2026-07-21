# Typolish Extension — WORKLOG

## 2026-04-16

### fix: Full-page capture sticky/fixed element overlay

**Problem**: Full-page screenshot capture (scroll & stitch) rendered `position: fixed` and `position: sticky` elements (nav bars, tab bars) in every strip, causing visual overlap in the stitched image.

**Root cause**: Fixed/sticky elements remain in the same viewport position regardless of scroll, so each captured strip included them at the same pixel offset. When stitched, they appeared multiple times overlapping page content.

**Solution** (`background.js`):
- For strips i >= 1: scan all DOM elements via `getComputedStyle`, detect `position: fixed/sticky`, and inline-hide with `visibility: hidden !important`
- Critical timing: hide detection runs AFTER 350ms post-scroll wait (page JS IO/scroll handlers must complete first)
- Force reflow (`void document.documentElement.offsetHeight`) + 50ms repaint wait before capture
- Restore original visibility after all strips captured via `data-typolish-fixed` attribute

**Code review**: Passed — no issues found. Reviewed for bugs, CLAUDE.md compliance, git history patterns, and code comment adherence.

**Tested on**: Adobe Creative Cloud pricing page (sticky tab bar) — confirmed no duplication.

## 2026-07-21

### v2.3.0: 校正画像を R2 署名 PUT で直アップロード（Vercel 4.5MB 上限 413 の根治）

**Problem**: 縦長・高密度な HTML プルーフで「拡張機能で校正画像を生成」しても Web ビューアに画像が表示されない（本番実バグ・2026-07-21 実測）。

**Root cause**（typolish 側設計書 `documents/design/extension-screenshot-payload-limit-fix.md` §2）:
1. 3 viewport の base64 画像を 1 本の JSON で `/api/extension/render-callback` へ POST しており、Vercel 関数のリクエスト本文上限 4.5MB を超えると関数到達前に 413 で破棄される（本番ログで 413 × 4 を確認。実測ペイロード 6.68MB / 13.88MB）。
2. callback の HTTP 失敗を errors に積むだけで DONE status は 'success' のまま → Web 側が Cloud Run フォールバックへ入れず無言で停止。

**Solution**（`background.js` / `manifest.json` 2.2.0 → 2.3.0）:
- viewport ごとにキャプチャ後、`POST /api/extension/upload-url`（HMAC token）で署名 PUT URL を取得し R2 へバイナリ直アップロード。callback には `{ storagePath }` 参照だけを送る（数百 byte・上限撤廃）。
- upload-url が 404（旧サーバ）の場合は従来の base64 一括送信へ自動フォールバック（デプロイ順序に依存しない）。アップロード失敗 viewport は base64 で個別フォールバック（サーバは viewport 単位で両形式受理）。
- callback が HTTP 失敗した場合は DONE status='failed' を通知（Web 側の Cloud Run フォールバックが機能するようになる）。

**Server 側対応**（typolish・同日実装）: `/api/extension/upload-url` 新設 + `render-callback` の参照形式受理（期待キー完全一致 + R2 HEAD read-back）。

**Tested**: `node --check` 構文 OK。typolish 側 vitest 1027 全 pass（render-callback 両形式 + upload-url 防御列の 13 テスト新規）。実機 E2E はサーバデプロイ後に unpacked v2.3.0 で実施予定。
