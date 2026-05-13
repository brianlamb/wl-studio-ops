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

Row targeting uses `k_class_period` from the report Details/Booked URLs when available. This
matters when two rows share the same staff, date/time, and class title, such as a normal booking
row plus a zero-booking duplicate.

Pay-rate fixes now commit through the same `Wl\Classes\Period\Staff\Ajax::staffSubstituteSave`
method that the Quick Substitution apply button calls. The button-click path remains as a fallback,
but the primary path avoids bubbling click events that can close the popup before the save settles.

## Console/Claude setup (per session)

1. User opens the Payroll Details report in Chrome and navigates to the period being audited.
2. Claude verifies the Chrome MCP extension is connected (`list_connected_browsers`).
3. Claude injects the driver library via `javascript_tool` — paste the entire contents of
   `wl-payroll-driver.user.js`. Verify the load message in the console.
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

For every row where `category === 'fixable'`, walk this 6-step sequence. Each step is a separate
`javascript_tool` call — WL's async confirm-button render requires a real gap between trigger
and select.

```
# Step 1 — open the row's class popup (2a in skill)
WLPayrollDriver.openRow('jordan-loder|apr-18-2026-7-00pm|stream-radiance-flow')

# Step 2 — find the substitution container ID (2b)
WLPayrollDriver.findSubContainerId()
# → { ok: true, id: '409512', containerId: 'rs-staff_substitution-view-409512' }

# Step 3 — trigger QUICK Substitution (2c)
WLPayrollDriver.triggerQuickSub('409512')
# IMPORTANT: do NOT combine this with step 5 — WL renders the confirm button
# asynchronously and the click will silently fail.

# Step 4 — verify the confirm button is rendered before proceeding
WLPayrollDriver.isConfirmReady()
# → { ok: true, ready: true } — proceed
# → { ok: true, ready: false, reason: '...' } — wait and re-check, max 3 tries

# Step 5 — select the correct pay rate from the dropdown (2d)
WLPayrollDriver.selectPayRate('hybrid')  // pass the row's expectedKeyword

# Step 6 — confirm (2e)
WLPayrollDriver.confirm()

# Step 7 — verify success toast appeared
WLPayrollDriver.checkSuccessToast()
# → { ok: true, found: true, text: 'Staff member has been changed successfully' }
```

If any step returns `{ok: false, ...}`, log the row's `key` and the error to a skipped-rows
list and continue with the next fixable row. Do not retry automatically — a structural failure
(missing element, etc.) usually means WL changed something and the whole batch needs human review.

## Phase 3: Final report

After the loop completes, re-run `WLPayrollDriver.scan()` and diff against the initial scan:
- Initial fixable count → after fixable count → should be 0 if every fix succeeded
- Any rows that moved from `fixable` to `ok` confirm a successful save
- Any rows still in `fixable` indicate a fix that didn't take — flag for manual investigation

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
| `confirm` returns "no visible primary button" | Same async render race — confirm called too early | Verify `isConfirmReady` returns `ready: true` before calling |
| Confirm clicks but no success toast | "Selected date does not belong to class period" error from WL — same async race | Step 4 was probably skipped; retry the whole fix from step 1 |

## Next steps for this driver

1. **Validate against real data** — run scan-only on a known-clean and a known-dirty payroll
   period, compare against manual audit results. False positives, false negatives, missed rows.
2. **Pagination probe + Phase 2 implementation** — once we know WL's pagination DOM.
3. **Persistent worklist artifact** — Cowork artifact that shows scan results + fix-history,
   refreshes from the live report each open. Tier 2 from the original automation plan.
4. **WL API investigation** — if WL exposes a REST/GraphQL endpoint for staff pay assignments
   on visits, the whole UI dance is unnecessary. Worth 30 min of network-tab inspection before
   investing further in the DOM driver.
