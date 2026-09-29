# SOC-RAP MVP: Security Review Notes

**Scope:** the single-page MVP (`SOC-RAP-MVP.html`, built from `app_*.js`, `app_head.html` and `build.py`).
**Date:** 27 September 2026
**Architecture:** the app runs entirely in the browser.
- No server, no API calls, no login.
- Uploaded files are parsed locally.
- Data is saved per client in the browser's IndexedDB.
- The only network request is one pinned library (PptxGenJS 4.0.1). It loads only when a PowerPoint is generated.

## 1. Findings fixed in this review

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | **Zip bomb via false sizes.** The XLSX reader decompressed each part fully before checking its size. A workbook whose headers claim small parts but hold large ones could exhaust memory. | Decompression now streams and stops as soon as output passes the declared size (hard cap 200 MB per part). Test: a 296 KB file hiding 300 MB is rejected in 0.3 s. |
| 2 | Medium | **DTD check bypass.** DOCTYPE/ENTITY detection looked only at the first 4 KB of each XML part, so padding could hide a DTD. | The whole part is checked. Any DTD or entity declaration is refused. |
| 3 | Medium | **Memory exhaustion via cell addresses.** Row and column numbers from the file were used directly as array indexes (`r="400000000"`). | Rows are capped at 500,000 and columns at 16,384 (Excel's maximum). Cell references are validated. |
| 4 | Medium | **Prototype-key injection.** The zip entry table, row objects and counters were plain objects keyed by file content: entry names, headers, dispositions, categories, file names. Keys like `__proto__` or `constructor` could corrupt lookups and counts. | Maps and null-prototype objects are used for all file-derived keys. Test: dispositions `__proto__`, `constructor` and `toString` count correctly, and `Object.prototype` is untouched. |
| 5 | Medium | **ReDoS in user-authored category rules.** The pattern checker missed exponential forms such as `(a\|aa)+$` and `(\w+\s?)+$`. | The checker now rejects any repeated group that contains a repeat or `\|`, plus lookarounds, backreferences and repeat counts above 999. Titles are normalized to `[a-z0-9 ]` and capped at 1,024 characters. Test: 9 attack patterns rejected, 5 legitimate patterns accepted. |
| 6 | Medium | **Supply chain.** The PptxGenJS script loaded from a CDN without Subresource Integrity, with a second, unverified fallback CDN. | A single pinned URL with `integrity="sha384-qb0Xhi7L…"` and `crossorigin="anonymous"`. The fallback was removed. If the file changes by one byte, the browser refuses to run it. |
| 7 | Low | **Stored data trusted on load.** Workspaces restored from IndexedDB were used without validation, so a tampered store could inject a ReDoS rule or invalid settings. | `sanitizeWorkspace()` validates every field on load: types, SLA bounds (1 s to 30 days), targets (0–100), enums, and rule patterns re-checked. Test: a tampered rule, limit, target and retention were all discarded. |
| 8 | Low | **Output integrity.** Control characters and unpaired surrogates from input could corrupt the XLSX or PPTX XML. | Text fields are cleaned and length-limited at ingest. The XLSX writer strips invalid XML characters. |
| 9 | Low | **Formula-injection gaps.** Full-width `＝ ＋ － ＠` and a leading line feed were not neutralized. | Added to the neutralizer. Test: `=HYPERLINK(…)`, `+cmd…` and `@SUM…` export as literal text starting with `'`. |
| 10 | Low | **No CSP on the offline copy.** | The offline HTML now has a strict Content-Security-Policy and `no-referrer`. The app ran under it with zero violations. |
| 11 | Info | **Inline event-handler strings.** The DOM helper would have accepted `on*` attributes as strings. | `on*` attributes accept functions only. |

## 2. Controls already in place (verified)

| Area | Control |
|---|---|
| XSS | All DOM is built with `textContent`/`createElement`. There is no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function`, confirmed by ESLint with those rules enforced. Test: the title `<img src=x onerror=…>` renders as text, creates no element and runs no script. |
| Uploads | Only `.xlsx` and `.csv` are accepted. Checks: magic bytes, 50 MB limit, 1,000 zip entries, 100:1 expansion ratio, 500 MB total expansion. Macro (`vbaProject.bin`), ActiveX and path-traversal entries are refused. CSV is limited to 200 columns and 32 KB per field. |
| XML parsing | Browser `DOMParser` (no external entity resolution) plus the DTD refusal above. |
| Excel export | Built by the app itself, with no third-party code. Every string is XML-escaped and formula-neutralized. The file has no macros and no external links. |
| Downloads | Saved through the host's confirm-to-save prompt. Download file names are limited to letters, digits, `.`, `_` and `-`. |
| Data handling | No network calls with data. `connect-src 'none'` in the offline CSP. Client workspaces are stored under separate keys, and delete removes a client's store. |
| Timestamps / numbers | Epoch values are sanity-bounded to 2000–2100. SLA inputs are bounds-checked. Priority falls back to score ranges, and only blank or unreadable values block. |

## 3. Residual risks (accepted for an MVP, tracked for production)

- **Data at rest:** IndexedDB is not encrypted beyond the operating system's disk protection. Anyone with access to the browser profile can read the saved client data. *Production:* server-side storage with per-client row-level security (spec §11–12), or opt-in passphrase encryption (AES-GCM).
- **Client separation is logical, not cryptographic:** all clients share one browser origin. *Production:* server-side authorization per client.
- **Regex engine:** the browser's backtracking `RegExp` is used, guarded by the validator above. *Production:* RE2 on the server (spec §12.3).
- **Google Fonts stylesheet:** CSS only, no script, so SRI isn't possible. Low risk. *Production:* self-host the fonts.
- **Artifact hosting:** when opened as a Claude artifact, the host's CSP and sandbox apply instead of the offline CSP.

## 4. How it was tested

- ESLint with `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url`, `no-proto`, `no-extend-native` and bans on `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`: **0 findings**.
- A browser test suite (Playwright, Chromium) against the offline build under its CSP:
  - a lying-size zip bomb
  - a classic zip bomb
  - a macro workbook
  - a DTD hidden after padding
  - a 400-million row index
  - an XSS title
  - formula titles
  - prototype-key dispositions and headers
  - 9 ReDoS patterns
  - a tampered stored workspace
  - SRI on the loaded library

  **All passed.**
- **Regression:** the June 2026 results are unchanged (3,195 cases; 2,631 excluding Informational; High TTA 99.78%).
