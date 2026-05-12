// ==UserScript==
// @name        WL Payroll Driver
// @namespace   Pure Bliss Yoga
// @match       *://www.wellnessliving.com/rs/report-view.html*
// @match       *://www.wellnessliving.com/Wl/Staff/Pay/Report/StaffPaySummaryReport.html*
// @match       *://www.wellnessliving.com/Wl/Staff/Pay/Report/StaffPayDetailReport.html*
// @grant       none
// @version     1.1.0
// @description Payroll Details audit, review, and guarded pay-rate fixing for WellnessLiving
// ==/UserScript==

/**
 * WellnessLiving Payroll Details — Audit & Fix Driver
 *
 * Stateless JS library that exposes a clean API for Chrome MCP-driven automation
 * of the monthly payroll audit at Pure Bliss Yoga.
 *
 * Usage: paste this whole file into the browser console once per page. All methods
 * live under `window.WLPayrollDriver`. Each call is idempotent; state lives in the
 * DOM, not in this module.
 *
 * Orchestration model: each "step" of the fix sequence must be invoked in a
 * SEPARATE tool call (Chrome MCP javascript_tool). WellnessLiving's UI renders
 * the confirm buttons asynchronously after Quick Substitution is triggered; if
 * you combine trigger + confirm in one call, the click silently fails.
 *
 * Version: 1.1.0
 */
(function () {
  'use strict';

  // -- Selectors (data-name attributes are stable across WL column reorders) --
  const COL = {
    staff:    'o_staff_member',
    rate:     'text_pay_rate',
    payment:  'o_payment',
    service:  'text_service_type',
    booked:   'o_book',
    attended: 'o_visit',
    lateCx:   'o_penalty',
    noShows:  'o_truancy',
    details:  'o_service',
    date:     'o_date_add',
    compType: 'o_compensation_type',
    client:   'o_client',
  };

  // -- Pay-rate priority cascade (Class rows only) --
  const CASCADE = [
    { test: dl => dl.includes('community'),                    keyword: 'community', label: 'Community Rate' },
    { test: dl => dl.startsWith('stream:'),                    keyword: 'hybrid',    label: 'Livestream (Hybrid) Rate' },
    { test: dl => dl.includes('aerial'),                       keyword: 'aerial',    label: 'Aerial Rate' },
    { test: dl => dl.includes('75min') || dl.includes('75 min'), keyword: '75',      label: '75 min In-Person Class' },
    { test: () => true,                                        keyword: '45-60',     label: '45-60 minute In-Person Class' },
  ];

  // -- Helpers --
  const getCell = (row, name) => row.querySelector(`td[data-name="${name}"]`);
  const getText = (row, name) => getCell(row, name)?.innerText?.trim() || '';
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function makeRowKey(row) {
    const staff = getText(row, COL.staff);
    const date  = getText(row, COL.date);
    const det   = getText(row, COL.details);
    return `${slug(staff)}|${slug(date)}|${slug(det)}`;
  }

  function classifyRow(row) {
    const staff       = getText(row, COL.staff);
    const payRate     = getText(row, COL.rate);
    const serviceType = getText(row, COL.service);
    const details     = getText(row, COL.details);
    const date        = getText(row, COL.date);

    const dl  = details.toLowerCase();
    const prl = payRate.toLowerCase();

    const isPureBlissStaff     = staff.toLowerCase().includes('pure bliss staff');
    const isAppointmentOrEvent = serviceType === 'Appointment' || serviceType === 'Event';

    // Priority cascade — first match wins (only meaningful for Service Type 'Class')
    const matched = CASCADE.find(rule => rule.test(dl));
    const expected = matched ? { keyword: matched.keyword, label: matched.label } : null;

    let category = null;   // 'fixable' | 'manual' | 'ok'
    let issue    = null;
    let severity = null;   // 'error' | 'review' | null

    if (isPureBlissStaff) {
      category = 'manual';
      severity = 'error';
      issue = 'MISSING INSTRUCTOR — "Pure Bliss Staff" placeholder, reassign before payroll (cannot fix via Quick Sub)';
    } else if (isAppointmentOrEvent) {
      category = 'manual';
      severity = 'review';
      issue = `${serviceType} with variable/percentage rate — verify manually`;
    } else if (!payRate) {
      category = 'fixable';
      severity = 'error';
      issue = `BLANK pay rate — should be: "${expected.label}"`;
    } else if (expected && !prl.includes(expected.keyword)) {
      category = 'fixable';
      severity = 'error';
      issue = `Wrong rate — expected "${expected.label}", is: "${payRate}"`;
    } else {
      category = 'ok';
    }

    return {
      key: makeRowKey(row),
      staff, serviceType, payRate: payRate || '(blank)', details, date,
      expected: expected?.label || null,
      expectedKeyword: expected?.keyword || null,
      category, severity, issue,
    };
  }

  function getDataRows() {
    return Array.from(document.querySelectorAll('tr.js-content-row'))
      .filter(row => getText(row, COL.staff));
  }

  function getRowByKey(rowKey) {
    return getDataRows().find(row => makeRowKey(row) === rowKey) || null;
  }

  function openAnchorInTab(anchor) {
    if (!anchor) return false;
    const originalTarget = anchor.target;
    anchor.target = '_blank';
    try {
      anchor.click();
      return true;
    } finally {
      anchor.target = originalTarget;
    }
  }

  // -- Public API --
  const API = {
    version: '1.1.0',

    /** Read-only: classify every row on the current page. */
    scan() {
      const rows = document.querySelectorAll('tr.js-content-row');
      const results = [];
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;
        results.push(classifyRow(row));
      });
      return {
        ok: true,
        totalRows: results.length,
        fixable: results.filter(r => r.category === 'fixable').length,
        manual:  results.filter(r => r.category === 'manual').length,
        ok_:     results.filter(r => r.category === 'ok').length,
        rows: results,
      };
    },

    /** Read-only: just the fixable rows (Class + blank/wrong rate). */
    getFixable() {
      return this.scan().rows.filter(r => r.category === 'fixable');
    },

    /** Read-only: just the rows needing manual attention. */
    getManualReview() {
      return this.scan().rows.filter(r => r.category === 'manual');
    },

    /** Read-only: every non-OK pay-rate issue on the current page. */
    getIssues() {
      return this.scan().rows.filter(r => r.category !== 'ok');
    },

    /**
     * Read-only: attendance reconciliation check using the canonical tooltip.
     *
     * Semantics (matches Brian's reconcile_attendance.user.js workflow):
     *   - errors: rows where Attended+NoShows+LateCx > Booked (impossible over-count — real data bug)
     *   - needsReconciliation: rows where Booked > sum. NOT necessarily wrong — the gap
     *     represents unresolved check-in status (could be attended/no-show/other unmarked).
     *     Requires manual roster review; do NOT auto-flag as error. Each row includes
     *     `rosterUrl` (from the Booked column anchor) for one-click opening.
     */
    checkAttendance() {
      const rows = document.querySelectorAll('tr.js-content-row');
      const errors = [];
      const needsReconciliation = [];
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;
        const tipEl = getCell(row, COL.details)?.querySelector('[data-title-backup]');
        const tip = tipEl?.getAttribute('data-title-backup') || '';
        const m = tip.match(/Booked:\s*(\d+).*?Attended:\s*(\d+).*?No-shows:\s*(\d+).*?Late cancels:\s*(\d+)/i);
        if (!m) return;
        const [booked, attended, noShows, lateCx] = m.slice(1).map(Number);
        const sum = attended + noShows + lateCx;
        const gap = booked - sum;  // positive = unresolved check-ins, negative = impossible over-count
        const rosterUrl = getCell(row, COL.booked)?.querySelector('a')?.href || null;
        const base = {
          key: makeRowKey(row),
          staff, details: getText(row, COL.details), date: getText(row, COL.date),
          booked, attended, noShows, lateCx, rosterUrl,
        };
        if (gap < 0) {
          errors.push({ ...base, overCount: -gap, error: `${attended} + ${noShows} + ${lateCx} = ${sum} > Booked ${booked}` });
        } else if (gap > 0) {
          needsReconciliation.push({ ...base, gap });
        }
      });
      return { ok: true, errors, needsReconciliation };
    },

    /**
     * Return reconciliation rows with roster URLs (URLs are in page context — they
     * may be redacted on the return trip to the tool; use openReconciliationTabs()
     * to open them without round-tripping the URL).
     */
    getReconciliationUrls() {
      const a = this.checkAttendance();
      return {
        ok: true,
        count: a.needsReconciliation.length,
        totalGap: a.needsReconciliation.reduce((s, r) => s + r.gap, 0),
        rows: a.needsReconciliation.map(r => ({
          staff: r.staff,
          date: r.date,
          details: r.details,
          gap: r.gap,
          booked: r.booked,
          rosterUrl: r.rosterUrl,
        })),
      };
    },

    /**
     * Open each reconciliation row's class roster in a new tab. Modifies each
     * Booked-column anchor to target="_blank" and triggers a click so the browser
     * treats it as a real anchor activation (less likely to popup-block than
     * window.open). Restores target afterwards.
     *
     * Returns count of tabs opened. First call after page load usually requires
     * popups allowed for wellnessliving.com; if blocked, browser shows the popup
     * icon in the URL bar and you can allowlist there.
     */
    openReconciliationTabs() {
      const rows = document.querySelectorAll('tr.js-content-row');
      let opened = 0;
      let blocked = 0;
      const opens = [];
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;
        const tipEl = getCell(row, COL.details)?.querySelector('[data-title-backup]');
        const tip = tipEl?.getAttribute('data-title-backup') || '';
        const m = tip.match(/Booked:\s*(\d+).*?Attended:\s*(\d+).*?No-shows:\s*(\d+).*?Late cancels:\s*(\d+)/i);
        if (!m) return;
        const [booked, attended, noShows, lateCx] = m.slice(1).map(Number);
        if (booked - (attended + noShows + lateCx) <= 0) return;  // skip rows that don't need reconciliation

        const link = getCell(row, COL.booked)?.querySelector('a');
        if (!link) return;
        const originalTarget = link.target;
        link.target = '_blank';
        try {
          link.click();
          opened++;
          opens.push({ staff, details: getText(row, COL.details).slice(0, 50), date: getText(row, COL.date) });
        } catch (e) {
          blocked++;
        } finally {
          link.target = originalTarget;
        }
      });
      return { ok: true, opened, blocked, opens };
    },

    /**
     * Open manual-review class/service rows in new tabs. This is intentionally
     * limited to manual rows, so the bulk "review" action does not also open
     * rows that can be fixed through Quick Substitution.
     */
    openManualReviewTabs() {
      let opened = 0;
      const opens = [];
      for (const item of this.getManualReview()) {
        const row = getRowByKey(item.key);
        const link = row ? getCell(row, COL.details)?.querySelector('a') : null;
        if (openAnchorInTab(link)) {
          opened++;
          opens.push({ key: item.key, staff: item.staff, date: item.date, details: item.details });
        }
      }
      return { ok: true, opened, opens };
    },

    /** Open the details/class popup for one issue row in a new browser tab. */
    openReviewTab(rowKey) {
      const row = getRowByKey(rowKey);
      if (!row) return { ok: false, error: `no row matching key: ${rowKey}` };
      const link = getCell(row, COL.details)?.querySelector('a');
      if (!link) return { ok: false, error: 'no details link in row' };
      return { ok: true, opened: openAnchorInTab(link), key: rowKey };
    },

    /** Open the booked/roster link for one reconciliation row in a new tab. */
    openRosterTab(rowKey) {
      const row = getRowByKey(rowKey);
      if (!row) return { ok: false, error: `no row matching key: ${rowKey}` };
      const link = getCell(row, COL.booked)?.querySelector('a');
      if (!link) return { ok: false, error: 'no booked/roster link in row' };
      return { ok: true, opened: openAnchorInTab(link), key: rowKey };
    },

    /**
     * Mark issue rows directly in the report table for visual review.
     * Uses data attributes and inline styles so it works from console or userscript.
     */
    highlightIssues() {
      const summary = { ok: true, highlighted: 0, fixable: 0, manual: 0 };
      for (const row of getDataRows()) {
        row.removeAttribute('data-wl-payroll-category');
        row.removeAttribute('data-wl-payroll-issue');
        row.title = '';
        row.style.outline = '';
        row.style.backgroundColor = '';

        const item = classifyRow(row);
        if (item.category === 'ok') continue;

        row.dataset.wlPayrollCategory = item.category;
        row.dataset.wlPayrollIssue = item.issue || '';
        row.title = item.issue || '';
        row.style.outline = item.category === 'fixable'
          ? '2px solid rgba(180, 83, 9, 0.65)'
          : '2px solid rgba(185, 28, 28, 0.65)';
        row.style.backgroundColor = item.category === 'fixable'
          ? 'rgba(251, 191, 36, 0.16)'
          : 'rgba(248, 113, 113, 0.14)';
        summary.highlighted++;
        summary[item.category]++;
      }
      return summary;
    },

    // -- Pre-flight confirmation prompts (human-in-the-loop checkpoints) --

    /**
     * Show a native confirm() dialog with current page context before scanning.
     * Returns boolean — true if user clicked OK, false if Cancel.
     */
    confirmBeforeScan() {
      const title = document.title || 'this page';
      const rowCount = document.querySelectorAll('tr.js-content-row').length;
      const msg = [
        'WL Payroll Driver — pre-scan checkpoint',
        '',
        `Page:  ${title}`,
        `Rows:  ${rowCount} data rows detected`,
        '',
        'Click OK to scan and classify pay rates.',
        'Click Cancel to abort.',
      ].join('\n');
      return confirm(msg);
    },

    /**
     * Show a native confirm() dialog with row context before applying a fix.
     * Pass a classified row from scan() (or getFixable()).
     * Returns boolean — true if user clicked OK, false if Cancel (skip this row).
     */
    confirmBeforeFix(row) {
      if (!row || typeof row !== 'object') {
        return confirm('WL Payroll Driver — confirmBeforeFix called without row context. Proceed anyway?');
      }
      const msg = [
        'WL Payroll Driver — fix checkpoint',
        '',
        `Staff:    ${row.staff || '(unknown)'}`,
        `Class:    ${row.details || '(unknown)'}`,
        `Date:     ${row.date || '(unknown)'}`,
        `Current:  ${row.payRate || '(blank)'}`,
        `Set to:   ${row.expected || '(unknown)'}`,
        '',
        'Click OK to apply this fix.',
        'Click Cancel to skip this row.',
      ].join('\n');
      return confirm(msg);
    },

    // -- Fix sequence primitives — each returns structured status --

    /**
     * Step 2a: open the class popup for a row matching the given key.
     * Returns {ok, opened: rowKey} or {ok: false, error}.
     */
    openRow(rowKey) {
      const rows = document.querySelectorAll('tr.js-content-row');
      let target = null;
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;
        if (makeRowKey(row) === rowKey) target = row;
      });
      if (!target) return { ok: false, error: `no row matching key: ${rowKey}` };
      const link = getCell(target, COL.details)?.querySelector('a');
      if (!link) return { ok: false, error: 'no details link in row' };
      link.click();
      return { ok: true, opened: rowKey };
    },

    /**
     * Step 2b: find the staff_substitution container ID for the CURRENTLY OPEN popup.
     *
     * IMPORTANT: WL leaves stale staff_substitution-view-* elements in the DOM after
     * popups close. Filter to visible elements only and prefer the most recently
     * added (last in DOM order) to avoid hitting a stale container from a prior fix.
     */
    findSubContainerId() {
      const isVisible = (el) => {
        let cur = el;
        while (cur && cur !== document.body) {
          const s = window.getComputedStyle(cur);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          cur = cur.parentElement;
        }
        return true;
      };
      const els = Array.from(document.querySelectorAll('[id*="staff_substitution-view-"]'))
        .filter(el => !/-button$/.test(el.id))
        .filter(el => isVisible(el.parentElement));
      if (!els.length) return { ok: false, error: 'no visible staff_substitution element' };
      const container = els[els.length - 1];
      const m = container.id.match(/staff_substitution-view-(\d+)/);
      if (!m) return { ok: false, error: `unexpected ID format: ${container.id}` };
      return { ok: true, id: m[1], containerId: container.id, visibleCount: els.length };
    },

    /**
     * Step 2c: trigger QUICK Substitution AND reveal the edit panel.
     *
     * CRITICAL: calling the LI's onclick alone does NOT reveal the apply button —
     * Wl_Classes.quickStaffChangeShow(li) is what actually transitions the holder
     * out of `js-hide-elem` state and makes `.js-button-apply` visible. The skill's
     * original flow missed this step; the apply button stayed visibility:hidden
     * and the save never committed.
     */
    triggerQuickSub(visitId) {
      const container = document.getElementById(`rs-staff_substitution-view-${visitId}`);
      if (!container) return { ok: false, error: `container not found for id ${visitId}` };
      const quickSub = Array.from(container.querySelectorAll('li')).find(li =>
        (li.getAttribute('data-title') || '').toUpperCase().includes('QUICK'));
      if (!quickSub) return { ok: false, error: 'QUICK Substitution menu item not found' };
      if (!window.Wl_Classes || typeof window.Wl_Classes.quickStaffChangeShow !== 'function') {
        return { ok: false, error: 'Wl_Classes.quickStaffChangeShow not available — page may not be fully loaded' };
      }
      try {
        // Close the gear menu first (mimics the onclick string's a_grid_gear_show(...,'hide'))
        if (typeof window.a_grid_gear_show === 'function') {
          window.a_grid_gear_show(`rs-staff_substitution-view-${visitId}`, 'hide');
        }
        // Then reveal the edit panel
        window.Wl_Classes.quickStaffChangeShow(quickSub);
      } catch (e) {
        return { ok: false, error: 'Wl_Classes.quickStaffChangeShow threw: ' + e.message };
      }
      return { ok: true, triggered: visitId };
    },

    /**
     * Verification step: is the apply (.js-button-apply > button.css-fa--check) now visible?
     */
    isConfirmReady() {
      const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
      if (!popup) return { ok: false, error: 'popup not present' };
      const applyWrap = popup.querySelector('.js-button-apply');
      if (!applyWrap) return { ok: true, ready: false, reason: 'no .js-button-apply element' };
      const btn = applyWrap.querySelector('button');
      if (!btn) return { ok: true, ready: false, reason: 'no button inside .js-button-apply' };
      const wrapVis = window.getComputedStyle(applyWrap).visibility;
      const btnVis = window.getComputedStyle(btn).visibility;
      const ready = wrapVis === 'visible' && btnVis === 'visible';
      return { ok: true, ready, wrapVisibility: wrapVis, btnVisibility: btnVis };
    },

    /**
     * Step 2d: select the correct pay rate from the dropdown.
     * Pass the keyword from the cascade (e.g. 'community', 'hybrid', 'aerial', '75', '45-60').
     */
    selectPayRate(keyword) {
      const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
      const selects = popup ? popup.querySelectorAll('select') : document.querySelectorAll('select');
      const paySelect = Array.from(selects).find(s => s.name === 'k_staff_pay');
      if (!paySelect) return { ok: false, error: 'k_staff_pay select not found — form not ready?' };

      const target = Array.from(paySelect.options).find(o =>
        o.text.toLowerCase().includes(keyword.toLowerCase()));
      if (!target) {
        return {
          ok: false,
          error: `no option matching keyword "${keyword}"`,
          availableOptions: Array.from(paySelect.options).map(o => o.text),
        };
      }
      paySelect.value = target.value;
      paySelect.dispatchEvent(new Event('change', { bubbles: true }));
      paySelect.dispatchEvent(new Event('input',  { bubbles: true }));
      return { ok: true, selected: target.text, value: target.value };
    },

    /**
     * Step 2e: click the actual save button (.js-button-apply > button.css-fa--check).
     *
     * The skill's original selector ('css-btn-filled-primary' anywhere in popup) caught
     * the "View attendance list" button instead — that nav button is also styled primary.
     * The correct target is the checkmark button INSIDE .js-button-apply.
     */
    confirm() {
      const popup = document.querySelector('.css-sg-second.rs-class-view-ti, [class*="rs-class-view"]');
      if (!popup) return { ok: false, error: 'popup not present' };
      const applyWrap = popup.querySelector('.js-button-apply');
      if (!applyWrap) return { ok: false, error: '.js-button-apply not found — triggerQuickSub did not complete?' };
      if (window.getComputedStyle(applyWrap).visibility !== 'visible') {
        return { ok: false, error: '.js-button-apply still visibility:hidden — Wl_Classes.quickStaffChangeShow did not run?' };
      }
      const btn = applyWrap.querySelector('button.css-fa--check, button');
      if (!btn) return { ok: false, error: 'no button inside .js-button-apply' };
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
      return { ok: true, clicked: true };
    },

    /**
     * Reload the report page to pull fresh server-side data. The Payroll Details
     * table caches rows from when the report was generated, so post-fix changes
     * don't appear until the page is reloaded. Use this after a batch of fixes.
     * NOTE: this also wipes window.WLPayrollDriver — caller must re-inject.
     */
    refreshReport() {
      location.reload();
      return { ok: true, reloaded: true };
    },

    /**
     * All-in-one fix: open popup, wait for render, run the full Quick Sub sequence.
     * Returns {ok, phase, ...} — phase identifies the failure point if any step fails.
     * Recommended over manually chaining the individual primitives.
     *
     * @param {string} rowKey - from scan().rows[].key
     * @param {string} keyword - one of 'community', 'hybrid', 'aerial', '75', '45-60'
     */
    async fixRow(rowKey, keyword) {
      const open = this.openRow(rowKey);
      if (!open.ok) return { phase: 'open', key: rowKey, ...open };
      await sleep(800);
      const id = this.findSubContainerId();
      if (!id.ok) return { phase: 'find', key: rowKey, ...id };
      const trig = this.triggerQuickSub(id.id);
      if (!trig.ok) return { phase: 'trigger', key: rowKey, visitId: id.id, ...trig };
      await sleep(300);
      const sel = this.selectPayRate(keyword);
      if (!sel.ok) return { phase: 'select', key: rowKey, visitId: id.id, ...sel };
      const conf = this.confirm();
      if (!conf.ok) return { phase: 'confirm', key: rowKey, visitId: id.id, ...conf };
      await sleep(500);
      return { ok: true, key: rowKey, visitId: id.id, selected: sel.selected };
    },

    /**
     * Verification step: check whether the success toast appeared.
     * WL shows a green toast "Staff member has been changed successfully" on success.
     */
    checkSuccessToast() {
      // WL toast usually has class .css-toast, .js-toast, or similar — try a few patterns
      const candidates = document.querySelectorAll(
        '.css-toast, .js-toast, [class*="toast"], [class*="notification"]'
      );
      for (const el of candidates) {
        const text = (el.innerText || '').toLowerCase();
        if (text.includes('staff member has been changed') ||
            text.includes('successfully')) {
          return { ok: true, found: true, text: el.innerText.trim().slice(0, 200) };
        }
      }
      return { ok: true, found: false };
    },

    // -- Pagination (Phase 2 stubs — need a probe to fill in) --
    getPaginationInfo() {
      // TODO Phase 2: inspect actual pagination DOM on a multi-page report,
      // then implement getCurrentPage / goToNextPage / getTotalPages.
      return { ok: false, error: 'pagination not yet implemented — Phase 2' };
    },
  };

  // -- Userscript operator panel --
  const UI = {
    id: 'wl-payroll-driver-panel',
    styleId: 'wl-payroll-driver-style',
    lastScan: null,
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function injectPanelStyle() {
    if (document.getElementById(UI.styleId)) return;
    const style = document.createElement('style');
    style.id = UI.styleId;
    style.textContent = `
      #${UI.id} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        width: min(460px, calc(100vw - 36px));
        max-height: min(720px, calc(100vh - 36px));
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        background: #ffffff;
        color: #172033;
        border: 1px solid #b8c2d1;
        border-radius: 8px;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.24);
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${UI.id}.is-collapsed .wlpd-body { display: none; }
      #${UI.id} .wlpd-body {
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #${UI.id} button {
        appearance: none;
        border: 1px solid #aab5c5;
        background: #f8fafc;
        color: #172033;
        border-radius: 6px;
        padding: 5px 8px;
        font: inherit;
        line-height: 1.2;
        cursor: pointer;
      }
      #${UI.id} button:hover { background: #eef2f7; }
      #${UI.id} button[data-primary="true"] {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      #${UI.id} button[data-danger="true"] {
        border-color: #b91c1c;
        background: #fff5f5;
        color: #991b1b;
      }
      #${UI.id} .wlpd-head,
      #${UI.id} .wlpd-actions,
      #${UI.id} .wlpd-counts,
      #${UI.id} .wlpd-row-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${UI.id} .wlpd-head { justify-content: space-between; }
      #${UI.id} .wlpd-title { font-weight: 700; }
      #${UI.id} .wlpd-actions,
      #${UI.id} .wlpd-counts { flex-wrap: wrap; }
      #${UI.id} .wlpd-pill {
        border-radius: 999px;
        padding: 2px 8px;
        background: #eef2f7;
        white-space: nowrap;
      }
      #${UI.id} .wlpd-pill[data-tone="bad"] { background: #fee2e2; color: #991b1b; }
      #${UI.id} .wlpd-pill[data-tone="warn"] { background: #fef3c7; color: #92400e; }
      #${UI.id} .wlpd-pill[data-tone="ok"] { background: #dcfce7; color: #166534; }
      #${UI.id} .wlpd-status {
        min-height: 18px;
        color: #475569;
      }
      #${UI.id} .wlpd-list {
        min-height: 0;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-right: 2px;
      }
      #${UI.id} .wlpd-issue {
        border: 1px solid #d8dee8;
        border-left: 4px solid #f59e0b;
        border-radius: 6px;
        padding: 8px;
        background: #ffffff;
      }
      #${UI.id} .wlpd-issue[data-category="manual"],
      #${UI.id} .wlpd-issue[data-category="attendance"] { border-left-color: #dc2626; }
      #${UI.id} .wlpd-main { font-weight: 650; }
      #${UI.id} .wlpd-meta { color: #475569; margin-top: 2px; overflow-wrap: anywhere; }
      #${UI.id} .wlpd-empty {
        padding: 12px;
        border: 1px dashed #cbd5e1;
        border-radius: 6px;
        color: #475569;
      }
    `;
    document.head.appendChild(style);
  }

  function notifyPanel(message, tone = 'info') {
    const panel = document.getElementById(UI.id);
    const status = panel?.querySelector('.wlpd-status');
    if (status) {
      status.textContent = message;
      status.dataset.tone = tone;
    }
    const log = tone === 'error' ? console.error : tone === 'warn' ? console.warn : console.log;
    log(`[WL Payroll] ${message}`);
    if (window.Notification && Notification.permission === 'granted' && tone !== 'info') {
      new Notification('WL Payroll Driver', { body: message });
    }
  }

  function renderPanel(scan, attendance) {
    const panel = document.getElementById(UI.id);
    if (!panel) return;
    const counts = panel.querySelector('.wlpd-counts');
    const list = panel.querySelector('.wlpd-list');
    const attErrors = attendance?.errors || [];
    const attReview = attendance?.needsReconciliation || [];
    const issueRows = scan.rows.filter(row => row.category !== 'ok');

    counts.innerHTML = [
      `<span class="wlpd-pill">Rows ${scan.totalRows}</span>`,
      `<span class="wlpd-pill" data-tone="${scan.fixable ? 'warn' : 'ok'}">Fixable ${scan.fixable}</span>`,
      `<span class="wlpd-pill" data-tone="${scan.manual ? 'bad' : 'ok'}">Manual ${scan.manual}</span>`,
      `<span class="wlpd-pill" data-tone="${attReview.length ? 'warn' : 'ok'}">Roster review ${attReview.length}</span>`,
      `<span class="wlpd-pill" data-tone="${attErrors.length ? 'bad' : 'ok'}">Attendance errors ${attErrors.length}</span>`,
    ].join('');

    const parts = [];
    for (const row of issueRows) {
      const canFix = row.category === 'fixable';
      parts.push(`
        <div class="wlpd-issue" data-category="${escapeHtml(row.category)}" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">${escapeHtml(row.staff)} - ${escapeHtml(row.date)}</div>
          <div class="wlpd-meta">${escapeHtml(row.details)}</div>
          <div class="wlpd-meta">${escapeHtml(row.issue || '')}</div>
          <div class="wlpd-row-actions" style="margin-top:7px;">
            <button data-action="open" data-key="${escapeHtml(row.key)}">Open</button>
            ${canFix ? `<button data-action="fix" data-primary="true" data-key="${escapeHtml(row.key)}">Set ${escapeHtml(row.expectedKeyword)}</button>` : ''}
          </div>
        </div>
      `);
    }
    for (const row of attErrors) {
      parts.push(`
        <div class="wlpd-issue" data-category="attendance" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">Attendance over-count - ${escapeHtml(row.staff)}</div>
          <div class="wlpd-meta">${escapeHtml(row.date)} - ${escapeHtml(row.details)}</div>
          <div class="wlpd-meta">${escapeHtml(row.error)}</div>
          <div class="wlpd-row-actions" style="margin-top:7px;">
            <button data-action="roster" data-key="${escapeHtml(row.key)}">Roster</button>
          </div>
        </div>
      `);
    }
    for (const row of attReview) {
      parts.push(`
        <div class="wlpd-issue" data-category="attendance" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">Roster review - ${escapeHtml(row.staff)}</div>
          <div class="wlpd-meta">${escapeHtml(row.date)} - ${escapeHtml(row.details)}</div>
          <div class="wlpd-meta">Booked gap: ${escapeHtml(row.gap)}</div>
          <div class="wlpd-row-actions" style="margin-top:7px;">
            <button data-action="roster" data-key="${escapeHtml(row.key)}">Roster</button>
          </div>
        </div>
      `);
    }

    list.innerHTML = parts.length
      ? parts.join('')
      : '<div class="wlpd-empty">No pay-rate or attendance issues found on this page.</div>';
  }

  function runPanelScan() {
    const scan = API.scan();
    const attendance = API.checkAttendance();
    UI.lastScan = { scan, attendance, at: new Date() };
    API.highlightIssues();
    renderPanel(scan, attendance);
    notifyPanel(`Scan complete: ${scan.fixable} fixable, ${scan.manual} manual, ${attendance.needsReconciliation.length} roster review.`);
    return UI.lastScan;
  }

  async function onPanelClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const key = button.dataset.key;

    if (action === 'scan') {
      runPanelScan();
      return;
    }
    if (action === 'highlight') {
      const result = API.highlightIssues();
      notifyPanel(`Highlighted ${result.highlighted} issue rows.`);
      return;
    }
    if (action === 'manual-tabs') {
      const result = API.openManualReviewTabs();
      notifyPanel(`Opened ${result.opened} manual-review tabs.`);
      return;
    }
    if (action === 'reconcile-tabs') {
      const result = API.openReconciliationTabs();
      notifyPanel(`Opened ${result.opened} roster tabs.`);
      return;
    }
    if (action === 'refresh') {
      if (confirm('Reload the Payroll Details report now? The userscript will reattach after reload.')) {
        API.refreshReport();
      }
      return;
    }
    if (action === 'collapse') {
      document.getElementById(UI.id)?.classList.toggle('is-collapsed');
      return;
    }
    if (action === 'close') {
      document.getElementById(UI.id)?.remove();
      return;
    }
    if (action === 'open' && key) {
      const result = API.openReviewTab(key);
      notifyPanel(result.ok ? 'Opened review tab.' : result.error, result.ok ? 'info' : 'error');
      return;
    }
    if (action === 'roster' && key) {
      const result = API.openRosterTab(key);
      notifyPanel(result.ok ? 'Opened roster tab.' : result.error, result.ok ? 'info' : 'error');
      return;
    }
    if (action === 'fix' && key) {
      const item = (UI.lastScan?.scan?.rows || API.scan().rows).find(row => row.key === key);
      if (!item) {
        notifyPanel('Could not find row in current scan.', 'error');
        return;
      }
      if (!API.confirmBeforeFix(item)) {
        notifyPanel('Skipped fix.');
        return;
      }
      button.disabled = true;
      notifyPanel(`Fixing ${item.staff} - ${item.date}...`);
      const result = await API.fixRow(item.key, item.expectedKeyword);
      button.disabled = false;
      if (!result.ok) {
        notifyPanel(`Fix failed at ${result.phase || 'unknown'}: ${result.error || 'unknown error'}`, 'error');
        return;
      }
      notifyPanel(`Fix saved: ${result.selected}. Reload before final verification.`, 'warn');
    }
  }

  function installPanel(options = {}) {
    if (!document.body) return { ok: false, error: 'document.body is not ready' };
    injectPanelStyle();
    let panel = document.getElementById(UI.id);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = UI.id;
      panel.innerHTML = `
        <div class="wlpd-head">
          <div class="wlpd-title">WL Payroll Driver v${escapeHtml(API.version)}</div>
          <div class="wlpd-row-actions">
            <button data-action="collapse" title="Collapse panel">-</button>
            <button data-action="close" title="Close panel">x</button>
          </div>
        </div>
        <div class="wlpd-body">
          <div class="wlpd-actions">
            <button data-action="scan" data-primary="true">Scan</button>
            <button data-action="highlight">Highlight</button>
            <button data-action="manual-tabs">Manual tabs</button>
            <button data-action="reconcile-tabs">Roster tabs</button>
            <button data-action="refresh">Reload</button>
          </div>
          <div class="wlpd-counts"></div>
          <div class="wlpd-status">Ready. Run Scan after the Payroll Details report has loaded.</div>
          <div class="wlpd-list"></div>
        </div>
      `;
      panel.addEventListener('click', onPanelClick);
      document.body.appendChild(panel);
    }
    if (options.autoScan) runPanelScan();
    return { ok: true, panelId: UI.id };
  }

  API.installPanel = installPanel;
  API.runPanelScan = runPanelScan;
  API.notify = notifyPanel;

  window.WLPayrollDriver = API;
  console.log(`%cWLPayrollDriver v${API.version} loaded`, 'color: #0a7; font-weight: bold');
  console.log('Available methods:', Object.keys(API).filter(k => typeof API[k] === 'function'));

  function autoInstallPanel() {
    if (!document.body) return;
    installPanel({ autoScan: Boolean(document.querySelector('tr.js-content-row')) });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(autoInstallPanel, 800), { once: true });
  } else {
    setTimeout(autoInstallPanel, 800);
  }
})();
