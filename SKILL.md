# WellnessLiving Payroll Details — Review & Fix Pay Rates

This skill covers the monthly payroll audit and pay rate correction workflow for Pure Bliss Yoga's
Payroll Details report in WellnessLiving.

## Pay Rate Rules

**Top-level rule:** no class has a blank pay rate. Use the cascade below to determine what each row's rate should be — the first matching condition wins, and the same expected value drives both "what to set if blank/wrong" and "is the current rate correct?"

### Priority cascade (first match wins)

| Priority | Detection | Expected pay rate |
|---|---|---|
| 1 | Details contains `community` | `Community Rate` |
| 2 | Details starts with `Stream:` | `Livestream (Hybrid) Rate` |
| 3 | Details contains `aerial` | `Aerial Rate` |
| 4 | Details contains `ashtanga` | `75-90 minute In-Person Class (500 ERYT)` |
| 5 | Details contains `75min` / `75 min` | `75 min In-Person Class` |
| 6 | Default (everything else) | `45-60 minute In-Person Class` |

**ERYT variants** of any in-person rate (e.g. `45-60 minute In-Person Class (500HR E-RYT Teacher)`) are legitimate for certified instructors and still pass the keyword match.

### Non-cascade flags (handled separately)

- **Staff column = `Pure Bliss Staff`** — substitute placeholder, not a real instructor. Flag "missing instructor — reassign before payroll" regardless of rate. Cannot be fixed via Quick Substitution (a real person needs to be picked through the full Substitution flow first).
- **Private sessions / appointments / events** — variable rates that can't be predicted by the cascade. Flag for manual review only; do NOT validate rate.

### Ordering rationale and tie-breakers

- Community beats Stream and Aerial. A `Stream: Community Flow` row gets Community Rate, not Hybrid Rate.
- Stream beats Aerial. A hybrid aerial class (if any exist) would get Hybrid Rate, not Aerial Rate.
- Aerial beats length rules. `EDGEWTR: Aerial` gets Aerial Rate, not 45-60 or 75 min — location prefix doesn't preclude aerial.
- Ashtanga beats generic length rules. Ashtanga should use `75-90 minute In-Person Class (500 ERYT)`.

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

## Step 1 — Scan All Pages for Issues

Before starting, check for pagination: if the report spans multiple pages, numbered pagination
controls appear at the bottom of the table. If absent, it's a single page. Note the total page
count so you know how many times to run the checker below.

Paste this checker into the browser console once per page, navigating through all pages via the
pagination controls. Collect results from every page before fixing anything — this gives a full
picture first.

```javascript
window._checkPayRates = function() {
  const rows = document.querySelectorAll('tr.js-content-row');
  const getText = (row, name) =>
    row.querySelector(`td[data-name="${name}"]`)?.innerText?.trim() || '';

  const issues = [];
  rows.forEach((row) => {
    const staff = getText(row, 'o_staff_member');
    if (!staff) return;
    const payRate     = getText(row, 'text_pay_rate');
    const serviceType = getText(row, 'text_service_type');
    const details     = getText(row, 'o_service');
    const date        = getText(row, 'o_date_add');

    const dl  = details.toLowerCase();
    const prl = payRate.toLowerCase();

    const isPureBlissStaff     = staff.toLowerCase().includes('pure bliss staff');
    const isAppointmentOrEvent = serviceType === 'Appointment' || serviceType === 'Event';
    const isCommunity          = dl.includes('community');
    const isLivestream         = dl.startsWith('stream:');
    const isAerial             = dl.includes('aerial');
    const isAshtanga           = dl.includes('ashtanga');
    const is75min              = dl.includes('75min') || dl.includes('75 min');

    // Priority cascade: first match wins (only meaningful for Service Type = 'Class')
    let expectedKeyword, expectedLabel;
    if (isCommunity)       { expectedKeyword = 'community';  expectedLabel = 'Community Rate'; }
    else if (isLivestream) { expectedKeyword = 'hybrid';     expectedLabel = 'Livestream (Hybrid) Rate'; }
    else if (isAerial)     { expectedKeyword = 'aerial';     expectedLabel = 'Aerial Rate'; }
    else if (isAshtanga)   { expectedKeyword = '75-90';      expectedLabel = '75-90 minute In-Person Class (500 ERYT)'; }
    else if (is75min)      { expectedKeyword = '75';         expectedLabel = '75 min In-Person Class'; }
    else                   { expectedKeyword = '45-60';      expectedLabel = '45-60 minute In-Person Class'; }

    let issue = null;
    if (isPureBlissStaff) {
      issue = '🚨 MISSING INSTRUCTOR — "Pure Bliss Staff" placeholder, reassign before payroll';
    }
    else if (isAppointmentOrEvent) {
      issue = `ℹ️ REVIEW — ${serviceType} with variable/percentage rate, verify manually`;
    }
    else if (!payRate) {
      issue = '🚨 BLANK pay rate — should be: "' + expectedLabel + '"';
    }
    else if (!prl.includes(expectedKeyword)) {
      issue = '🚨 Wrong rate → expected "' + expectedLabel + '", is: "' + payRate + '"';
    }

    if (issue) issues.push({
      staff, serviceType,
      expected: serviceType === 'Class' ? expectedLabel : '—',
      payRate: payRate || '(blank)', details, date, issue
    });
  });
  return issues;
};

console.table(_checkPayRates());
```

---

## Step 2 — Fix a Pay Rate (Quick Substitution)

### Why direct clicking doesn't work

Two quirks make pixel-clicking unreliable:
1. The 3-dots (⋮) substitution button is hidden unless the row is CSS-hovered — JS mouse events
   don't trigger CSS `:hover`, so the button stays invisible.
2. Dispatching a `click` event with `bubbles:true` on anything inside the popup triggers the
   document-level outside-click handler, which closes the popup immediately.

**The solution**: skip clicking the button entirely and call the QUICK Substitution dropdown
item's built-in `onclick` handler directly.

### Full fix sequence — run these steps in order

#### 2a. Open the class popup

```javascript
// Adjust the match strings to target the exact row (class name + date)
const rows = document.querySelectorAll('table tbody tr');
rows.forEach(row => {
  const cells = row.querySelectorAll('td');
  if (cells.length < 10) return;
  const details = cells[9]?.innerText?.trim() || '';
  const date = cells[10]?.innerText?.trim() || '';
  // Example: targeting a specific stream class on Mar 26
  if (details.toLowerCase().startsWith('stream: radiance flow')
      && date.includes('Mar 26') && date.includes('6:30pm')) {
    const link = cells[9].querySelector('a');
    if (link) link.click();
  }
});
```

Take a screenshot to confirm the popup appeared.

#### 2b. Find the substitution container ID

The numeric class visit ID is embedded in DOM element IDs. Find it once after the popup opens:

```javascript
document.querySelectorAll('[id*="staff_substitution"]')
// Returns elements like: rs-staff_substitution-view-409512-button
//                         rs-staff_substitution-view-409512
// The number (409512 here) is the ID you need.
```

#### 2c. Trigger QUICK Substitution

Call the `onclick` handler directly on the QUICK Substitution list item — **do not** dispatch
a click event, as that will bubble up and close the popup:

```javascript
const dropdownContainer = document.getElementById('rs-staff_substitution-view-409512');
// ↑ replace 409512 with your actual ID

const items = dropdownContainer.querySelectorAll('li');
const quickSub = Array.from(items).find(li =>
  (li.getAttribute('data-title') || '').toUpperCase().includes('QUICK')
);
if (quickSub) quickSub.onclick.call(quickSub, new MouseEvent('click'));
```

**Critical — run this as a SEPARATE call and wait for it to complete before proceeding.**
WellnessLiving shows the confirm buttons asynchronously after the onclick fires. The buttons
start as `display:none / visibility:hidden` and are revealed by WL's JS after a tick. If you
combine trigger + confirm in the same call the button can appear reachable while the form is not
ready, which can cause a silent failed save or a stale popup interaction.

Verify the form is ready before moving to 2d:

```javascript
// Run this in a separate call — should return true before proceeding
const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
const primaryBtn = Array.from(popup.querySelectorAll('button'))
  .find(b => b.className.includes('css-btn-filled-primary'));
const style = primaryBtn ? window.getComputedStyle(primaryBtn) : null;
style && style.visibility === 'visible' && style.display !== 'none';
// Must return true before running 2d
```

#### 2d. Select the correct pay rate

```javascript
const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
const selects = popup ? popup.querySelectorAll('select') : document.querySelectorAll('select');
const paySelect = Array.from(selects).find(s => s.name === 'k_staff_pay');

// Pick the right search term based on the priority rules above:
//   Aerial     → 'aerial'
//   Community  → 'community'
//   Livestream → 'livestream'
//   Ashtanga   → '75-90'
//   75 min     → '75'
//   45-60 min  → '45-60'
const target = Array.from(paySelect.options).find(o =>
  o.text.toLowerCase().includes('livestream')   // ← change this
);

if (target) {
  paySelect.value = target.value;
  paySelect.dispatchEvent(new Event('change', {bubbles: true}));
  paySelect.dispatchEvent(new Event('input',  {bubbles: true}));
  console.log('Selected:', target.text);
}
```

#### 2e. Confirm (click the blue checkmark)

```javascript
const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
// Use computed style check — offsetParent alone is not enough; button can have offsetParent
// while still visibility:hidden (WL's async render sequence)
const primaryBtn = Array.from(popup.querySelectorAll('button')).find(b => {
  if (!b.className.includes('css-btn-filled-primary')) return false;
  const s = window.getComputedStyle(b);
  return s.visibility === 'visible' && s.display !== 'none';
});
if (primaryBtn) {
  primaryBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
  primaryBtn.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true}));
  primaryBtn.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true}));
}
```

**Success indicator**: green toast at top of page — *"Staff member has been changed successfully"*

Repeat steps 2a–2e for each remaining issue. After all fixes on a page, refresh and re-run
`_checkPayRates()` to verify the page is clean before moving on.

**Note on Pure Bliss Staff rows**: these can't be fixed by selecting a pay rate — the staff
member itself needs to be reassigned via the full Substitution flow (not Quick Substitution),
since you're picking a real instructor, not just adjusting the rate. Handle these separately
from the pay-rate fixes.

---

## Common Issues Reference

| Symptom | Cause | Fix |
|---|---|---|
| Popup closes the moment you click anything in it | Event bubbling hits document outside-click handler | Use `li.onclick.call(...)` instead of dispatching click events |
| 3-dots button reports `offsetParent === null` | CSS `:hover` hides it; JS mouseover doesn't trigger CSS hover | Skip clicking 3-dots — go straight to the dropdown container |
| "Selected date does not belong to class period" error | Popup date and selected row date/class period do not match, often from a stale popup on recurring classes | Close the popup, rescan, and retry; the driver should verify both `k_class_period` and `dt_date` before saving |
| Two sets of 3-dots visible in popup | Top-right ⋮ = class-level actions; inline ⋮ = staff pay substitution | Always target `[id*="staff_substitution"]` |
| Table sorts unexpectedly after fix | Pagination click lands on column header | After page navigation re-sort by clicking the Staff column header, or use `document.querySelector('td.css-column--o_staff_member').click()` |
| Report shows stale data after fix | Page was not refreshed | `location.reload()` then re-run checker |

---

## Attendance Math Check

In addition to pay rates, verify the attendance totals add up correctly:

**Booked = Attended + Late Cancels + No Shows**

The checker below reads from the Details cell's `data-title-backup` tooltip, which is a single
authoritative string (`"Booked: X, Attended: Y, No-shows: Z, Late cancels: W"`). This avoids the
"X - Y" total/unpaid split that can appear in the Attended column when a teacher attended a
class as a guest (not paid for the visit).

```javascript
window._checkAttendance = function() {
  const rows = document.querySelectorAll('tr.js-content-row');
  const getCell = (row, name) => row.querySelector(`td[data-name="${name}"]`);
  const getText = (row, name) => getCell(row, name)?.innerText?.trim() || '';

  const errors = [];
  rows.forEach((row) => {
    const staff = getText(row, 'o_staff_member');
    if (!staff) return;

    const tipEl = getCell(row, 'o_service')?.querySelector('[data-title-backup]');
    const tip = tipEl?.getAttribute('data-title-backup') || '';
    const m = tip.match(/Booked:\s*(\d+).*?Attended:\s*(\d+).*?No-shows:\s*(\d+).*?Late cancels:\s*(\d+)/i);
    if (!m) return;
    const [, booked, attended, noShows, lateCx] = m.slice(1).map(Number);

    if (booked !== attended + noShows + lateCx) {
      errors.push({
        staff, details: getText(row, 'o_service'),
        date: getText(row, 'o_date_add'),
        booked, attended, noShows, lateCx,
        error: `${attended} + ${noShows} + ${lateCx} = ${attended + noShows + lateCx} ≠ Booked ${booked}`
      });
    }
  });
  return errors;
};
console.table(_checkAttendance());
```
