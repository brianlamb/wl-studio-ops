# WellnessLiving Payroll Details — Review & Fix Pay Rates

This skill covers the monthly payroll audit and pay rate correction workflow for Pure Bliss Yoga's
Payroll Details report in WellnessLiving.

> **Implementation contract — read before editing this file.**
> This document is the *spec*: business rules, the report DOM data model, and the workflow.
> The *implementation* (CSS selectors, AJAX endpoints, async timing, popup sequencing) lives in
> exactly one place: `wl-payroll-driver.user.js`. Do not copy selector-level or endpoint-level
> code into this file or the playbook — call the driver API by name instead. When the driver's
> behavior changes, only its JSDoc must change; this file changes only when the business rules
> or the report DOM contract change. `scripts/check-docs-drift.sh` enforces this.

## Pay Rate Rules

**Top-level rule:** no class has a blank pay rate. Use the cascade below to determine what each row's rate should be — the first matching condition wins, and the same expected value drives both "what to set if blank/wrong" and "is the current rate correct?"

**The default (priority 7) only fills blanks — it never flags a non-blank rate as wrong.** A row that matches no specific keyword carries no reliable signal, so a rate the studio already set is trusted; the `45-60` default is used only to *fill a blank*. Only the specific rules (priorities 1–6, including the Radiance Flow and `75` length matches) flag a non-blank rate as wrong.

### Priority cascade (first match wins)

| Priority | Detection | Expected pay rate |
|---|---|---|
| 1 | Details contains `community` | `Community Rate` |
| 2 | Details starts with `Stream:` | `Livestream (Hybrid) Rate` |
| 3 | Details contains `aerial` | `Aerial Rate` |
| 4 | Details contains `ashtanga` | `75-90 minute In-Person Class (500 ERYT)` |
| 5 | Details contains `radiance flow` and does **not** contain `75` | `45-60 minute In-Person Class` |
| 6 | Details contains `75` | `75 min In-Person Class` |
| 7 | Default (everything else) | `45-60 minute In-Person Class` |

**ERYT variants** of any in-person rate (e.g. `45-60 minute In-Person Class (500HR E-RYT Teacher)`) are legitimate for certified instructors and still pass the keyword match.

This cascade is implemented as the `CASCADE` array in `wl-payroll-driver.user.js`. If a rule
changes, update **both** this table and that array in the same commit — this is the one
intentional spec/implementation duplication in the repo.

### Non-cascade flags (handled separately)

- **Staff column = `Pure Bliss Staff`** — substitute placeholder, not a real instructor. Flag "missing instructor — reassign before payroll" regardless of rate. Cannot be fixed via Quick Substitution (a real person needs to be picked through the full Substitution flow first).
- **Private sessions** — a Details value containing `private` paired with a pay
  rate containing `Private` is correct and must pass as valid. A Private session
  with a blank or non-Private rate is flagged for manual review; do not auto-fix
  it through the class-rate cascade.
- **Appointments / events** — variable rates that can't be predicted by the
  cascade. Flag for manual review only, except for the valid Private-session /
  Private-rate pairing above; do NOT otherwise validate their rates.
- **`Hourly` pay rate** — non-class compensation (subbing / coverage / admin time), not a class. Always valid; never flag against the class-rate cascade, whatever the row's details say.

### Ordering rationale and tie-breakers

- Community beats Stream and Aerial. A `Stream: Community Flow` row gets Community Rate, not Hybrid Rate.
- Stream beats Aerial. A hybrid aerial class (if any exist) would get Hybrid Rate, not Aerial Rate.
- Aerial beats length rules. `EDGEWTR: Aerial` gets Aerial Rate, not 45-60 or 75 min — location prefix doesn't preclude aerial.
- Ashtanga beats generic length rules. Ashtanga should use `75-90 minute In-Person Class (500 ERYT)`.
- A Radiance Flow definition without `75` uses the normal 45-60 minute rate. A
  Radiance Flow definition containing `75` skips that rule and uses the generic
  75-minute rate.

---

## Report DOM Reference

The Payroll Details report uses `data-name` attributes on each `<td>` — these are the stable
selectors for cell access, robust to column reordering by the user.

| `data-name` | Content | Notes |
|---|---|---|
| `o_staff_member` | Staff | Watch for placeholder "Pure Bliss Staff" |
| `text_pay_rate` | Pay Rate | Text — may contain ERYT variants or `%` for events |
| `o_payment` | Total Pay | Has child span with `data-amount` for numeric access |
| `text_service_type` | **Service Type** | One of: `Class`, `Event`, `Appointment` — discriminator |
| `o_book` | Booked count | |
| `o_visit` | Attended count | May render as "X - Y" for paid/unpaid splits — prefer tooltip |
| `o_penalty` | Late Cancels count | |
| `o_truancy` | No Shows count | |
| `o_service` | Class/Service name | Has child `[data-title-backup]` tooltip with full attendance string |
| `o_date_add` | Date + Time | Format: `Apr 18, 2026 - 7:00pm` |
| `o_compensation_type` | Compensation Type | `Service` for flat rates, other values for percentage-based |
| `o_client` | Client | Only populated for Appointment rows |

Data rows have class `js-content-row`; the header row has `js-header-row`. The Details cell's
`data-title-backup` tooltip contains the canonical attendance breakdown as a single string:
`"Booked: 10, Attended: 5, No-shows: 0, Late cancels: 0"` — use this for attendance math
rather than parsing individual numeric columns.

---

## Setup — getting the driver onto the page

**Primary (normal case):** `wl-payroll-driver.user.js` is installed as a Violentmonkey/Tampermonkey
userscript (install from
`https://raw.githubusercontent.com/brianlamb/wl-studio-ops/main/wl-payroll-driver.user.js`).
Its `@match` rules auto-inject it on the payroll report pages and re-run it after every reload —
no per-page paste. The API is exposed on both `window.WLPayrollDriver` and
`unsafeWindow.WLPayrollDriver`; a floating operator panel also appears on the report.

**Fallback (no userscript manager):** paste the entire contents of `wl-payroll-driver.user.js`
into the browser console once per page load. Everything below works identically, but you must
re-paste after any reload.

Sanity check before starting:

```javascript
WLPayrollDriver.version   // should match the @version in the installed userscript
```

If this is `undefined` in a Chrome MCP `javascript_tool` call but the operator panel is visible,
you are in a world-isolation situation — see the playbook's verification section.

## Step 1 — Scan All Pages for Issues

Check for pagination first: if the report spans multiple pages, numbered pagination controls
appear at the bottom of the table. Pagination is not yet automated (driver `getPaginationInfo()`
is a stub) — advance pages manually and scan each one. Collect results from every page before
fixing anything.

Per page:

```javascript
WLPayrollDriver.scan()             // classify every row: fixable / manual / ok
WLPayrollDriver.checkAttendance()  // Booked = Attended + LateCx + NoShows reconciliation
```

`scan()` returns `{ok, totalRows, fixable, manual, ok_, rows}`; each row carries
`{key, staff, serviceType, payRate, details, date, expected, expectedKeyword, category, severity, issue}`.
The `key` and `expectedKeyword` are the inputs to the fix step. Helpers:
`getFixable()`, `getManualReview()`, `getIssues()`, `highlightIssues()`,
`openManualReviewTabs()`, `openReconciliationTabs()`.

## Step 2 — Fix a Pay Rate (Quick Substitution)

### Why the driver, not direct UI automation

WellnessLiving's popup UI is hostile to naive scripting: the substitution button only appears on
CSS `:hover` (JS events don't trigger it), bubbling click events hit a document-level
outside-click handler that closes the popup, the confirm form renders asynchronously, and the
"primary" button styling is shared with an unrelated navigation button. The driver encapsulates
all of this; the saved knowledge lives in its JSDoc, not here.

### How a fix commits (important for verification)

The driver's **primary save path is the same `staffSubstituteSave` AJAX call WL's own apply
button makes** — guarded so it refuses to save when the open popup's class period or date
doesn't match the targeted row (recurring classes can open a stale popup for a different date).
A UI button-click is used only as an automatic fallback when the page's AJAX object is
unavailable. The fix result reports which path ran via `saveMode: 'direct-ajax' | 'button-fallback'`.

### Recommended: one call per row

```javascript
// rowKey and expectedKeyword come straight from scan().rows[]
await WLPayrollDriver.fixRow(rowKey, expectedKeyword)
```

`fixRow` runs the whole guarded sequence (open popup → verify period/date → trigger Quick Sub →
select rate → AJAX save → toast check) and returns `{ok, phase, saveMode, selected, toast}` —
on failure, `phase` names the step that failed. Every attempt is recorded in the fix log
(`getFixLog()` / `exportFixLog()`).

With the operator panel, the equivalent is the per-row **Set `<rate>`** button, which shows a
native confirmation dialog before changing anything.

### Advanced: stepwise primitives (debugging only)

When `fixRow` fails and you need to isolate the failing phase, the primitives are
`openRow(key)` → `findSubContainerId()` → `triggerQuickSub(id)` → `isConfirmReady()` →
`selectPayRate(keyword)` → `saveQuickSubDirect()` (or `confirm()` as button fallback) →
`checkSuccessToast()`. Each must be a **separate** `javascript_tool` call — WL renders the
confirm form asynchronously, and combining trigger + confirm in one call fails silently.
See the playbook's Phase 2 section for the orchestrated sequence and failure table.

### After fixing

**Success indicator:** green toast — *"Staff member has been changed successfully"* — plus
`saveMode` in the `fixRow` result.

**One fix per class period per page load.** A successful save makes WellnessLiving re-key the
rest of that recurring series: the fixed date keeps its `k_class_period`, sibling dates move to
brand-new period ids (verified June 2026 against the May report). Rows still on the page that
share the saved period then carry stale keys — saving through one is refused server-side
(`class-period-date-out`), or accepted with the report only catching up on a later regeneration.
Saves were never observed landing on a wrong date. The driver tracks touched periods and refuses
repeat fixes (`phase: 'reload-required'`) until the page is reloaded; `fixRow` success results
carry `reloadRequired: true`, and the panel offers the reload when other fixable rows share the
saved period. Rows of **different** periods can be fixed back-to-back without reloading — note
that WL fragments long-running series over time, so sibling dates of the same weekly class often
already have distinct period ids, which is why manual one-by-one fixing on a fresh page works.

After reloading, re-run `scan()` — fixed rows move to `ok` and remaining rows come back with
fresh period ids. The scan also runs `checkFixesStuck()`, which cross-references the persistent
fix log: a row whose earlier fix reported ok but is **still fixable** usually means the report
has not caught up with the accepted save yet — reload again before refixing, and investigate if
it persists across regenerations. The userscript auto-re-injects after the reload.

### Drift verification and auto-heal (no reload required)

Staleness can also be checked **authoritatively without reloading**: `resolvePeriod(dateLocal,
period)` asks WL's own stale-link resolver for the canonical period id, and `verifyRowIds()`
sweeps the fixable rows (panel: **Verify ids**; drifted rows get a red badge with the canonical
id). `fixRow` preflights every fix with the same resolver. With the **Auto-heal drifted ids**
setting enabled, a fix whose page id is stale saves with the resolved canonical id instead of
failing — the date guards are unchanged, so a wrong-date write remains impossible. With it
disabled (the default), drifted rows are blocked (`phase: 'drift-detected'`) until a reload.
Every "date does not belong to class period" banner WL shows — from any flow, manual clicks
included — is counted on the panel and recorded in the fix log.

**Note on Pure Bliss Staff rows**: these can't be fixed by selecting a pay rate — the staff
member itself needs to be reassigned via the full Substitution flow (not Quick Substitution),
since you're picking a real instructor, not just adjusting the rate. Handle these separately
from the pay-rate fixes.

---

## Attendance Math Check

In addition to pay rates, verify the attendance totals add up:

**Booked = Attended + Late Cancels + No Shows**

`WLPayrollDriver.checkAttendance()` reads each row's Details-cell `data-title-backup` tooltip
(the single authoritative attendance string) rather than the numeric columns — this avoids the
"X - Y" total/unpaid split that appears in the Attended column when a teacher attended a class
as a guest. Rows whose tooltip can't be parsed are flagged as unreadable, not silently skipped.
For rows with unresolved booked gaps, `openReconciliationTabs()` opens the roster pages for
human review.

---

## Failure modes

The authoritative failure-mode table (symptom → cause → recovery, per driver API call) is
maintained in `wl-payroll-driver-playbook.md` — one table, one location. The short version:
any `{ok: false}` from a fix step means stop, log the row key, and continue with the next row;
structural failures (missing elements) usually mean WL changed their UI and the batch needs
human review.
