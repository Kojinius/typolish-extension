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
