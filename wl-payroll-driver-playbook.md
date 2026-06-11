# WL Payroll Driver — Chrome MCP Orchestration Playbook

How Claude or a human operator drives the monthly Pure Bliss Yoga payroll audit using
`wl-payroll-driver.user.js`.

## Recommended mode: Violentmonkey operator panel

`wl-payroll-driver.user.js` is a userscript. Install it in Violentmonkey/Tampermonkey from:

```text
https://raw.githubusercontent.com/brianlamb/wl-studio-ops/main/wl-payroll-driver.user.js
```

The userscript header includes `@downloadURL` and `@updateURL` pointing at that raw GitHub file,
so future committed/pushed version bumps are eligible for normal userscript-manager updates.
If you previously installed a local copy with the old namespace, delete that copy and install
from the raw URL so the manager tracks the GitHub-backed script.

Then open an already-run WellnessLiving Payroll Details report. A floating **WL Payroll Driver**
panel should appear automatically.

Panel actions:

- **Scan**: classify the currently visible report rows, run attendance reconciliation checks,
  and populate the issue list.
- **Highlight**: mark fixable/manual rows directly in the report table.
- **Manual tabs**: open only rows that need human review, such as `Pure Bliss Staff`,
  appointments, and events.
- **Roster tabs**: open roster links for attendance rows with unresolved booked gaps. In
  Violentmonkey, these open in background tabs via `GM_openInTab`.
- **Set `<rate>`**: guarded per-row Quick Substitution pay-rate fix. Each click shows a native
  confirmation dialog with staff/date/class/rate context before changing anything.
- **Skip fix confirm**: disables the native confirmation dialog so `Set <rate>` immediately runs
  the Quick Substitution operation.
- **Reload**: reload the report after fixes so the table pulls fresh server-side data.

The console API remains available as `window.WLPayrollDriver`, so Claude/Chrome automation can
still call the same primitives when needed:

```js
WLPayrollDriver.runPanelScan()
WLPayrollDriver.highlightIssues()
WLPayrollDriver.openManualReviewTabs()
WLPayrollDriver.openReconciliationTabs()
```

This should not be an all-or-nothing automation. Keep the deterministic scanning and UI element
operations in the userscript, but keep pay-rate changes as user-invoked, confirmed actions until
the workflow has been validated across several payroll periods.

Row targeting uses `k_class_period` plus `dt_date` from the report Details/Booked URLs when
available. Both values matter: recurring classes can reuse the same display title/staff and may
have multiple payroll rows, while the Quick Substitution save rejects a period/date mismatch.

Pay-rate fixes now commit through the same `Wl\Classes\Period\Staff\Ajax::staffSubstituteSave`
method that the Quick Substitution apply button calls. The button-click path remains as a fallback,
but the primary path avoids bubbling click events that can close the popup before the save settles.

**One fix per class period per page load.** A successful save makes WL re-key the rest of that
recurring series: the fixed date keeps its `k_class_period`, sibling dates move to brand-new
period ids (verified 2026-06-11 on the May report). Rows still on the page that share the saved
period then hold stale keys; further saves through them are refused with `class-period-date-out`
or accepted with the report catching up on a later regeneration — never observed landing on a
wrong date. The driver tracks touched periods and refuses repeat fixes (`phase:
'reload-required'`); the panel prompts to reload only when other fixable rows share the saved
period. Rows of different periods can be fixed back-to-back without reloading — WL fragments
long-running series over time, so same-class sibling dates often already carry distinct ids.
`scan()` exposes the risk upfront via `sharedPeriodRows` per row (0 = single-date period, safe).

What the 2026-06-11 interleaved set/revert test established, and what is still open:

- Single-date periods are stable: repeated saves and reverts against the same (period, date) —
  nine in one session, both pay directions, driver and native interleaved — all succeeded with
  no side effects and no re-keying.
- Re-keys happen only off saves against periods that still span multiple dates, but they can
  complete **asynchronously** — one observed re-key materialized in a window with no adjacent
  save, minutes after the triggering fix. A `class-period-date-out` can therefore appear even on
  a freshly loaded page; the recovery is unchanged (reload, rescan, retry).
- Report rate display lags accepted saves by anywhere from ~30 seconds to ~45 minutes.
- Unexplained: one stale-period save was soft-accepted (status ok, applied correctly, late)
  while another was hard-refused (`class-period-date-out`). Both behaviors are handled, but the
  server's rule for choosing between them is not pinned down — keep the fix log when it recurs.
- Payload note: WL's native button sends `uid_staff` as a number, the driver as a string; the
  server accepts both.

## Claude/Chrome MCP setup (per session)

1. User opens the Payroll Details report in Chrome and navigates to the period being audited.
2. Claude verifies the Chrome MCP extension is connected (`list_connected_browsers`).
3. **No injection needed in the normal case** — the installed userscript auto-injects on the
   report URLs and re-injects after every reload. Verify reachability instead:

   ```js
   // Tool call: world-isolation probe (3 lines)
   ({ direct: typeof window.WLPayrollDriver,
      version: window.WLPayrollDriver?.version,
      panel: !!document.getElementById('wl-payroll-driver-panel') })
   ```

   - `direct: 'object'` + matching `version` → proceed; all driver calls work from `javascript_tool`.
   - `direct: 'undefined'` but `panel: true` → the userscript ran but `javascript_tool` executes
     in an isolated world that can't see the page's main world. Fallback: paste the entire
     contents of `wl-payroll-driver.user.js` in a `javascript_tool` call to get a same-world
     copy (must re-paste after each reload), and record the finding so we stop re-testing it.
   - `direct: 'undefined'` and `panel: false` → userscript didn't run at all (not installed,
     disabled, or URL not matching `@match`). Fix the install before automating.
4. Driver lives on `window.WLPayrollDriver` for the remainder of the session.

## Phase 1: Scan-only audit (single page)

```js
// Tool call 1: load driver (see Setup above)
// Tool call 2: scan
WLPayrollDriver.scan()
```

The scan returns:

```js
{
  ok: true,
  totalRows: 47,
  fixable: 3,   // Class rows with blank/wrong rate — auto-fixable
  manual: 5,    // Appointments/Events + Pure Bliss Staff — need human action
  ok_: 39,
  rows: [ /* one entry per row */ ]
}
```

Each row has `{key, staff, serviceType, payRate, details, date, expected, expectedKeyword, category, severity, issue}`.

Run `WLPayrollDriver.checkAttendance()` separately for the Booked = Attended + LateCx + NoShows math check.

## Phase 2: Auto-fix loop (per fixable row)

**Recommended: one orchestrated call per fixable row.**

```js
// rowKey + expectedKeyword come from scan().rows[]
await WLPayrollDriver.fixRow('jordan-loder|apr-18-2026-7-00pm|stream-radiance-flow', 'hybrid')
```

`fixRow` internally runs: open popup → **verify popup `k_class_period` + `dt_date` match the
targeted row** (blocks the stale-recurring-popup save) → trigger Quick Sub → select rate →
**`saveQuickSubDirect()` (AJAX `staffSubstituteSave`, the primary save path)** → button-click
`confirm()` only if the page AJAX object is unavailable → toast check. It owns the async waits,
so a single tool call is safe.

Returns `{ok, phase, saveMode, selected, reloadRequired, toast}`:
- `ok: true, saveMode: 'direct-ajax'` — normal success. `reloadRequired: true` means what it
  says: reload + rescan before the next fix (WL re-keyed the series — see above).
- `ok: true, saveMode: 'button-fallback'` — saved, but via the fallback; worth noting in the report.
- `ok: false, phase: '...'` — `phase` names the failed step (`reload-required`, `open`,
  `verify-popup`, `find`, `trigger`, `select`, `save`, `confirm`). `reload-required` is not an
  error — it is the driver refusing to reuse a period id it already touched this page load.

Every attempt is appended to the persistent fix log: `getFixLog()` / `exportFixLog()` — including
early-phase aborts (`fix-abort` entries) and refused/failed saves. The driver also passively
observes the page's own Quick Substitution saves: manual clicks on WL's apply button produce
`save-observed` / `save-observed-result` entries (`source: 'native'`) with the same payload and
popup snapshot, so manual sessions can be compared against driver-initiated ones.

**Debug only — stepwise primitives.** If a row keeps failing and you need to isolate the phase,
run the primitives in separate `javascript_tool` calls (WL renders the confirm form
asynchronously; combining trigger + select/confirm in one call fails silently):
`openRow(key)` → `findSubContainerId()` → `triggerQuickSub(id)` → `isConfirmReady()` (wait/retry
max 3) → `selectPayRate(keyword)` → `saveQuickSubDirect()` → `checkSuccessToast()`.

If any step returns `{ok: false, ...}`, log the row's `key` and the error to a skipped-rows
list and continue with the next fixable row. Do not retry automatically — a structural failure
(missing element, etc.) usually means WL changed something and the whole batch needs human review.

## Phase 3: Final report

After the loop completes, re-run `WLPayrollDriver.scan()` and diff against the initial scan:
- Initial fixable count → after fixable count → should be 0 if every fix succeeded
- Any rows that moved from `fixable` to `ok` confirm a successful save
- Any rows still in `fixable` indicate a fix that didn't take — flag for manual investigation

`WLPayrollDriver.checkFixesStuck()` automates that last check: it cross-references the
persistent fix log against the current page (ignoring period ids, which change across reloads)
and lists rows whose earlier fix reported ok but are still wrong — the signature of WL applying
a save to a different date of the series. The panel runs this on every scan and shows a
"Did not stick" pill plus a per-row warning.

Report back to user:
- N rows scanned, N flagged, N auto-fixed, N skipped (with reasons), N manual-review queued
- Attendance math errors (separate concern, never auto-fixed)
- Sources: Pay Rate Rules memory + the workspace SKILL.md

## Not-yet-implemented (Phase 2 work)

- **Pagination**: the driver assumes single-page. For multi-page reports we need to probe the
  pagination DOM first, then add `getCurrentPage / goToNextPage / getTotalPages` to the API.
  Until that lands, the user has to manually advance pages between scan runs.
- **Pure Bliss Staff reassignment**: needs the full Substitution flow (not Quick Sub), which
  picks a real instructor. Different UI path — flagged for manual fix in v1.
- **Appointment/Event rate validation**: rates are percentage-based or per-session variable;
  no automation possible without an explicit rate-per-service mapping from the user.

## Failure modes seen during skill development

| Symptom | Likely cause | Recovery |
|---|---|---|
| `findSubContainerId` returns no element | Popup didn't open — `openRow` link selector wrong or row not on current page | Verify row key matches a scanned row; check popup is actually visible |
| `selectPayRate` returns "select not found" | Quick Sub form not yet rendered — step 4 verification skipped | Re-run `isConfirmReady`, wait, retry |
| `selectPayRate` returns "no option matching keyword" — see availableOptions in error | WL rate option text changed | Update CASCADE keywords in driver |
| `confirm` returns `.js-button-apply not found` / `still visibility:hidden` | Quick Sub form not rendered yet — same async race — or `triggerQuickSub` never ran | Verify `isConfirmReady` returns `ready: true` before calling; note `confirm` is fallback-only — `saveQuickSubDirect` is the primary save |
| `fixRow` returns `saveMode: 'button-fallback'` | Page AJAX object (`AAjax.method`) unavailable to the driver | Save still succeeded; if persistent across rows, investigate why the page world lost `AAjax` |
| Fix fails with `opened popup date ... expected ...` | WL kept or reopened a stale class popup for a different recurring date | Close the popup, rescan, and retry the row; the driver blocks the save before calling WL |
| Save returns `class-period-date-out` / "Selected date does not belong to class period" | The row's period id is stale — WL re-keyed the series after an earlier fix (or a schedule edit); the date no longer belongs to that period. Re-keys can complete asynchronously minutes after the triggering save, so this can hit even a freshly loaded page | Reload + rescan to pick up the new period id, then retry; the driver marks the period reload-required automatically |
| Fix fails with `phase: 'reload-required'` | The driver already fixed a row of this class series this page load — remaining sibling rows hold stale period ids | Not an error: reload + rescan, then fix the row with its fresh period id |
| Fix reported ok but the row is still fixable after reload (`checkFixesStuck()` flags it) | Delayed materialization — WL accepted the save but the regenerated report has not caught up yet (observed: ok at 10:03, still stale at 10:35, applied by 11:22) | Reload again later and rescan before refixing; if the flag persists across regenerations, investigate the row manually via the class popup |

## Next steps for this driver

1. **Validate against real data** — run scan-only on a known-clean and a known-dirty payroll
   period, compare against manual audit results. False positives, false negatives, missed rows.
2. **Pagination probe + Phase 2 implementation** — once we know WL's pagination DOM.
3. **Persistent worklist artifact** — Cowork artifact that shows scan results + fix-history,
   refreshes from the live report each open. Tier 2 from the original automation plan.
4. **WL API investigation** — if WL exposes a REST/GraphQL endpoint for staff pay assignments
   on visits, the whole UI dance is unnecessary. Worth 30 min of network-tab inspection before
   investing further in the DOM driver.
