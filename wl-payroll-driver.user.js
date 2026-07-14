// ==UserScript==
// @name        WL Payroll Driver
// @namespace   https://github.com/brianlamb/wl-studio-ops
// @homepageURL https://github.com/brianlamb/wl-studio-ops
// @supportURL  https://github.com/brianlamb/wl-studio-ops/issues
// @downloadURL https://raw.githubusercontent.com/brianlamb/wl-studio-ops/main/wl-payroll-driver.user.js
// @updateURL   https://raw.githubusercontent.com/brianlamb/wl-studio-ops/main/wl-payroll-driver.user.js
// @match       *://www.wellnessliving.com/rs/report-view.html*
// @match       *://www.wellnessliving.com/Wl/Staff/Pay/Report/StaffPaySummaryReport.html*
// @match       *://www.wellnessliving.com/Wl/Staff/Pay/Report/StaffPayDetailReport.html*
// @grant       GM_openInTab
// @grant       unsafeWindow
// @version     1.7.2
// @description Payroll Details audit, review, and guarded pay-rate fixing for WellnessLiving
// ==/UserScript==

/**
 * WellnessLiving Payroll Details — Audit & Fix Driver
 *
 * Stateless JS library that exposes a clean API for Chrome MCP-driven automation
 * of the monthly payroll audit at Pure Bliss Yoga.
 *
 * Injection: install as a userscript (Violentmonkey/Tampermonkey). The @match
 * patterns auto-inject this on the three payroll report URLs and re-run it after
 * every reload, so no per-page paste is needed. The API is exposed on both
 * `window.WLPayrollDriver` and `unsafeWindow.WLPayrollDriver` (the latter is what
 * page-context console / Chrome MCP javascript_tool reach). Console-paste still
 * works as a dev fallback when the manager isn't available. Each call is
 * idempotent; state lives in the DOM, not in this module.
 *
 * Orchestration model: each "step" of the fix sequence must be invoked in a
 * SEPARATE tool call (Chrome MCP javascript_tool). WellnessLiving's UI renders
 * the confirm buttons asynchronously after Quick Substitution is triggered; if
 * you combine trigger + confirm in one call, the click silently fails.
 *
 * Version: 1.7.2
 */
(function () {
  'use strict';

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

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
    {
      test: dl => dl.includes('ashtanga'),
      keyword: '75-90',
      label: '75-90 minute In-Person Class (500 ERYT)',
      payRateTest: prl => prl.includes('75-90') && prl.includes('500') && prl.includes('eryt'),
      optionTest: optionText => optionText.includes('75-90') && optionText.includes('500') && optionText.includes('eryt'),
    },
    {
      test: dl => dl.includes('radiance flow') && !dl.includes('75'),
      keyword: '45-60',
      label: '45-60 minute In-Person Class',
    },
    { test: dl => dl.includes('75'),                           keyword: '75',      label: '75 min In-Person Class' },
    // Catch-all default. `isDefault` marks it a guess used ONLY to fill a BLANK
    // rate — a specifically-identified class flags a non-blank wrong rate, but
    // this default never does, so a rate the studio already set is trusted.
    { test: () => true,                                        keyword: '45-60',     label: '45-60 minute In-Person Class', isDefault: true },
  ];

  // -- Helpers --
  const getCell = (row, name) => row.querySelector(`td[data-name="${name}"]`);
  const getText = (row, name) => getCell(row, name)?.innerText?.trim() || '';
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function getCellActionUrl(row, name) {
    const cell = getCell(row, name);
    if (!cell) return '';
    const source = cell.matches('[data-url-click], [data-url-hover], a[href]')
      ? cell
      : cell.querySelector('[data-url-click], [data-url-hover], a[href]');
    return source?.getAttribute('data-url-click') ||
      source?.getAttribute('data-url-hover') ||
      source?.getAttribute('href') ||
      '';
  }

  function getUrlParam(rawUrl, param) {
    if (!rawUrl) return '';
    try {
      const normalized = rawUrl.replace(/&amp;/g, '&');
      return new URL(normalized, location.origin).searchParams.get(param) || '';
    } catch (e) {
      const match = rawUrl.replace(/&amp;/g, '&').match(new RegExp(`[?&]${param}=([^&]+)`));
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
    }
  }

  function getRowPeriod(row) {
    return getUrlParam(getCellActionUrl(row, COL.details), 'k_class_period') ||
      getUrlParam(getCellActionUrl(row, COL.booked), 'k_class_period');
  }

  function normalizeDateLocal(value) {
    return String(value || '').trim().replace('T', ' ').replace(/\s+/g, ' ');
  }

  function getRowDateLocal(row) {
    return normalizeDateLocal(
      getUrlParam(getCellActionUrl(row, COL.details), 'dt_date') ||
      getUrlParam(getCellActionUrl(row, COL.booked), 'dt_date')
    );
  }

  function getRowIdentity(row) {
    const period = getRowPeriod(row);
    const dateLocal = getRowDateLocal(row);
    if (period && dateLocal) return `period-${period}-${slug(dateLocal)}`;
    if (period) return `period-${period}`;
    const uid = getCell(row, COL.staff)?.querySelector('[data-uid]')?.getAttribute('data-uid') ||
      row.querySelector('[data-uid]')?.getAttribute('data-uid') ||
      '';
    const rowIndex = row.parentElement ? Array.prototype.indexOf.call(row.parentElement.children, row) : row.rowIndex;
    return `row-${uid || 'unknown'}-${rowIndex}`;
  }

  function makeRowKey(row) {
    const staff = getText(row, COL.staff);
    const date  = getText(row, COL.date);
    const det   = getText(row, COL.details);
    return `${slug(staff)}|${slug(date)}|${slug(det)}|${getRowIdentity(row)}`;
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
    const isPrivateSession     = dl.includes('private');
    const isPrivateRate        = prl.includes('private');
    const isAppointmentOrEvent = serviceType === 'Appointment' || serviceType === 'Event';

    // Priority cascade — first match wins (only meaningful for Service Type 'Class')
    const matched = CASCADE.find(rule => rule.test(dl));
    const expected = matched ? { keyword: matched.keyword, label: matched.label } : null;
    // Only a specifically-identified class (75/community/aerial/ashtanga/livestream/Radiance Flow)
    // flags a non-blank wrong rate; the catch-all default (isDefault) just fills blanks.
    const matchedSpecific = Boolean(matched && !matched.isDefault);
    // Hourly pay is a non-class compensation (subbing/coverage/admin time), not
    // a class-rate error — never flag it, whatever the row's details say.
    const isHourlyRate = prl.includes('hourly');

    let category = null;   // 'fixable' | 'manual' | 'ok'
    let issue    = null;
    let severity = null;   // 'error' | 'review' | null

    if (isPureBlissStaff) {
      category = 'manual';
      severity = 'error';
      issue = 'MISSING INSTRUCTOR — "Pure Bliss Staff" placeholder, reassign before payroll (cannot fix via Quick Sub)';
    } else if (isPrivateSession && isPrivateRate) {
      // Private is a known correct pairing even when the service type would
      // otherwise send the row to manual appointment/event review.
      category = 'ok';
    } else if (isPrivateSession) {
      category = 'manual';
      severity = 'review';
      issue = 'Private session without a Private pay rate — verify manually';
    } else if (isAppointmentOrEvent) {
      category = 'manual';
      severity = 'review';
      issue = `${serviceType} with variable/percentage rate — verify manually`;
    } else if (isHourlyRate) {
      category = 'ok';
    } else if (!payRate) {
      category = 'fixable';
      severity = 'error';
      issue = `BLANK pay rate — should be: "${expected.label}"`;
    } else if (matchedSpecific && !(matched.payRateTest ? matched.payRateTest(prl) : prl.includes(expected.keyword))) {
      category = 'fixable';
      severity = 'error';
      issue = `Wrong rate — expected "${expected.label}", is: "${payRate}"`;
    } else {
      category = 'ok';
    }

    return {
      key: makeRowKey(row),
      period: getRowPeriod(row) || null,
      dateLocal: getRowDateLocal(row) || null,
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

  // Detail report has per-visit rows with pay rate, class period, and date.
  // Summary report has per-staff aggregate rows (no rate, no period, no per-class
  // breakdown) — only the booked/attended/noShows/lateCx totals.
  function getReportMode() {
    const path = location.pathname || '';
    if (path.includes('StaffPaySummaryReport')) return 'summary';
    if (path.includes('StaffPayDetailReport') || path.includes('report-view.html')) return 'detail';
    return 'unknown';
  }

  function getRowByKey(rowKey) {
    return getDataRows().find(row => makeRowKey(row) === rowKey) || null;
  }

  function openAnchorInTab(anchor, options = {}) {
    if (!anchor) return false;
    const href = anchor.href;
    const active = options.active !== false;
    if (href && typeof GM_openInTab === 'function') {
      GM_openInTab(href, {
        active,
        insert: true,
        setParent: true,
      });
      return true;
    }
    const originalTarget = anchor.target;
    anchor.target = '_blank';
    try {
      anchor.click();
      return true;
    } finally {
      anchor.target = originalTarget;
    }
  }

  function getVisibleClassPopup() {
    const isVisible = (el) => {
      if (!el) return false;
      let cur = el;
      while (cur && cur !== document.body) {
        const s = window.getComputedStyle(cur);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        cur = cur.parentElement;
      }
      return true;
    };
    const popups = Array.from(document.querySelectorAll('.css-sg-second.rs-class-view-ti, .css-sg-second.rs-class-view-tip, [class*="rs-class-view"]'))
      .filter(isVisible);
    return popups[popups.length - 1] || null;
  }

  function getOpenPopupPeriod() {
    const popup = getVisibleClassPopup();
    if (!popup) return '';
    return popup.querySelector('[data-period]')?.getAttribute('data-period') ||
      getUrlParam(popup.querySelector('a[href*="k_class_period"]')?.getAttribute('href') || '', 'k_class_period') ||
      '';
  }

  function getOpenPopupDateLocal() {
    const popup = getVisibleClassPopup();
    if (!popup) return '';
    return normalizeDateLocal(
      popup.querySelector('.js-staff-container')?.getAttribute('data-date') ||
      getUrlParam(popup.querySelector('a[href*="dt_date="]')?.getAttribute('href') || '', 'dt_date')
    );
  }

  function closeVisibleClassPopup() {
    if (!getVisibleClassPopup()) return;
    try {
      if (typeof PAGE.a_popup_box_hide === 'function') {
        PAGE.a_popup_box_hide();
        return;
      }
    } catch (e) {
      // Fall through to DOM close button.
    }
    getVisibleClassPopup()?.querySelector('.css-fa--times')?.click();
  }

  function pageQuery(el) {
    const jq = PAGE.jQuery || PAGE.$;
    return typeof jq === 'function' ? jq(el) : null;
  }

  // -- Fix log (audit + phantom-row investigation) --
  // Every fix attempt and save payload is recorded so we can correlate userscript
  // actions with database state if phantom rows reappear. Persisted to localStorage,
  // capped to MAX_ENTRIES to avoid bloat.
  const FIX_LOG = {
    entries: [],
    max: 200,
    storageKey: 'WLPayrollDriver.fixLog',
    push(entry) {
      const event = { ts: new Date().toISOString(), ...entry };
      this.entries.push(event);
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
      try { localStorage.setItem(this.storageKey, JSON.stringify(this.entries)); } catch (e) { /* quota or disabled */ }
      return event;
    },
    load() {
      try {
        const stored = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
        if (Array.isArray(stored)) this.entries = stored.slice(-this.max);
      } catch (e) { /* corrupt or disabled */ }
    },
    clear() {
      this.entries = [];
      try { localStorage.removeItem(this.storageKey); } catch (e) {}
    },
  };
  FIX_LOG.load();

  // Class periods re-keyed server-side during this page load. WL's
  // staffSubstituteSave SPLITS a recurring series on a successful save: the
  // fixed date keeps its k_class_period, sibling dates move to NEW period ids
  // (verified 2026-06-11: fixing (18062815, May 13) re-keyed May 20 to
  // 18064081). Rows of that series still on the page then hold stale period
  // keys; a save through one is refused server-side ("class-period-date-out")
  // or accepted with the report only catching up on a later regeneration —
  // saves were never observed landing on a wrong date. Refixes on touched
  // periods are blocked until reload so every save uses a fresh id.
  const RELOAD_REQUIRED_PERIODS = new Set();

  // "Selected date does not belong to class period." banners seen this page
  // load, from ANY source (manual clicks included). Surfaced as a panel pill.
  let SESSION_DATE_OUT_COUNT = 0;

  // `${period}|${dateLocal}` -> canonical period id, filled by resolvePeriod()
  // and verifyRowIds(). Page-load lifetime, like RELOAD_REQUIRED_PERIODS.
  const DRIFT_MAP = new Map();

  // Snapshot of popup state for diagnosing phantom-row bugs. Captures the
  // attributes the save payload is built from so we can spot mismatches.
  function capturePopupSnapshot() {
    const popup = getVisibleClassPopup();
    if (!popup) return { popupPresent: false };
    const staffContainer = popup.querySelector('.js-staff-container');
    const shownStaff = staffContainer?.querySelector('.js-single-staff-block.js-show');
    return {
      popupPresent: true,
      popupPeriod: getOpenPopupPeriod(),
      popupDateLocal: getOpenPopupDateLocal(),
      staffContainerDataDate: staffContainer?.getAttribute('data-date') || null,
      shownStaffDataPeriod: shownStaff?.getAttribute('data-period') || null,
      shownStaffDataStaff: shownStaff?.getAttribute('data-staff') || null,
      shownStaffDataDate: shownStaff?.getAttribute('data-date') || null,
    };
  }

  // -- Passive native-save observer --
  // Records EVERY Quick Substitution save that goes through the page's AAjax —
  // including ones triggered by manual clicks on WL's own apply button — into
  // the same fix log. This makes manual sessions auditable: reload, fix rows
  // by hand, Export log, and each native save's payload + popup snapshot +
  // server status is captured for comparison against driver-initiated saves.
  let DRIVER_SAVE_IN_FLIGHT = false;

  function installNativeSaveObserver() {
    const ajax = PAGE.AAjax;
    if (!ajax || typeof ajax.method !== 'function') return false;
    if (ajax.method.wlPayrollObserved) return true;
    const original = ajax.method;
    const wrapped = function (opts) {
      try {
        if (opts && String(opts.s_method || '').includes('staffSubstituteSave')) {
          const source = DRIVER_SAVE_IN_FLIGHT ? 'driver' : 'native';
          const period = String(opts.a_data?.k_class_period || '');
          FIX_LOG.push({ phase: 'save-observed', source, payload: opts.a_data, snapshot: capturePopupSnapshot() });
          const onSuccess = opts.call_success;
          const onFail = opts.call_fail;
          opts.call_success = function (_sender, response) {
            const status = response?.s_status || response?.status || null;
            FIX_LOG.push({ phase: 'save-observed-result', source, ok: status === 'ok', status });
            // Native saves invalidate periods exactly like driver saves do —
            // feed the same staleness ledger so mixed manual/driver sessions
            // share one source of truth (verified 2026-06-11: a manual save on
            // (18002108, May 2) re-keyed May 9/16/23/30 within ~90s).
            if (period && (status === 'ok' || status === 'class-period-date-out')) {
              RELOAD_REQUIRED_PERIODS.add(period);
            }
            if (source === 'native' && status === 'ok') {
              const sharing = getDataRows().filter(row => getRowPeriod(row) === period).length;
              if (sharing > 1) {
                notifyPanel(`Manual save touched class period ${period} — ${sharing - 1} other on-page row${sharing - 1 === 1 ? '' : 's'} share it and will go stale; reload before saving them.`, 'warn');
              }
            } else if (source === 'native' && status === 'class-period-date-out') {
              notifyPanel(`WL refused the manual save: this date no longer belongs to class period ${period} (re-keyed). Reload and retry from fresh rows.`, 'warn');
            }
            return typeof onSuccess === 'function' ? onSuccess.apply(this, arguments) : undefined;
          };
          opts.call_fail = function (_sender, response) {
            FIX_LOG.push({ phase: 'save-observed-result', source, ok: false, status: 'request-failed' });
            return typeof onFail === 'function' ? onFail.apply(this, arguments) : undefined;
          };
        }
      } catch (e) { /* observation must never break the page's save */ }
      return original.apply(this, arguments);
    };
    wrapped.wlPayrollObserved = true;
    ajax.method = wrapped;
    return true;
  }

  // AAjax may not exist yet at userscript injection time — retry until armed.
  (function armNativeSaveObserver(attempt = 0) {
    if (installNativeSaveObserver()) return;
    if (attempt < 40) setTimeout(() => armNativeSaveObserver(attempt + 1), 500);
  })();

  // -- Passive banner observer --
  // MpNote.show(message, type) is WL's single banner API ('error'|'note'|'ok').
  // Wrapping it captures every banner from every flow — including date-out
  // refusals raised by paths the AAjax observer's method filter doesn't cover.
  // Observation must never break the page's banner display.
  function installBannerObserver() {
    const note = PAGE.MpNote;
    if (!note || typeof note.show !== 'function') return false;
    if (note.show.wlPayrollObserved) return true;
    const original = note.show;
    const wrapped = function (message, type) {
      try {
        const text = String(message ?? '').slice(0, 300);
        const snapshot = capturePopupSnapshot();
        FIX_LOG.push({ phase: 'banner-observed', text, bannerType: type || null, snapshot });
        if (/does not belong to class period/i.test(text)) {
          SESSION_DATE_OUT_COUNT++;
          if (snapshot.popupPeriod) RELOAD_REQUIRED_PERIODS.add(snapshot.popupPeriod);
          notifyPanel(
            `Date-out refusal #${SESSION_DATE_OUT_COUNT} observed` +
            (snapshot.popupPeriod ? ` — period ${snapshot.popupPeriod} is stale; reload before retrying it.` : '.'),
            'warn'
          );
        }
      } catch (e) { /* observation must never break the page banner */ }
      return original.apply(this, arguments);
    };
    wrapped.wlPayrollObserved = true;
    note.show = wrapped;
    return true;
  }

  // MpNote may not exist yet at userscript injection time — retry until armed.
  (function armBannerObserver(attempt = 0) {
    if (installBannerObserver()) return;
    if (attempt < 40) setTimeout(() => armBannerObserver(attempt + 1), 500);
  })();

  // -- Public API --
  const API = {
    version: '1.7.2',

    /** Read-only: classify every row on the current page. */
    scan() {
      const mode = getReportMode();
      if (mode === 'summary') {
        // Summary report has no pay rate / class period — pay-rate scan is N/A.
        // Attendance check is handled separately via checkAttendance().
        const totalRows = getDataRows().length;
        return { ok: true, mode, totalRows, fixable: 0, manual: 0, ok_: totalRows, rows: [] };
      }
      const rows = document.querySelectorAll('tr.js-content-row');
      const results = [];
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;
        results.push(classifyRow(row));
      });
      // Rows sharing a k_class_period are the re-key risk: saving one re-keys
      // the others (sometimes minutes later, asynchronously). Fully fragmented
      // single-date periods (sharedPeriodRows: 0) are stable across repeated
      // saves and reverts — verified 2026-06-11 interleaved set/revert test.
      const periodCounts = new Map();
      for (const r of results) {
        if (r.period) periodCounts.set(r.period, (periodCounts.get(r.period) || 0) + 1);
      }
      for (const r of results) {
        r.sharedPeriodRows = r.period ? periodCounts.get(r.period) - 1 : 0;
      }
      return {
        ok: true,
        mode,
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
     * Cross-reference the persistent fix log against the current page: a row whose
     * earlier fix reported ok but that is STILL fixable after a reload. Most often
     * this is delayed materialization — WL accepted the save but the regenerated
     * report hasn't caught up yet (observed 2026-06-11: a May 14 fix reported ok
     * at 10:03, the 10:35 report still showed the old rate, the 11:22 report
     * showed it applied). Reload again before refixing; if the flag persists
     * across regenerations, investigate before saving again. Matching ignores the
     * period id segment of the row key, because WL re-keys series after saves and
     * the id legitimately changes across reloads.
     */
    checkFixesStuck() {
      const prefixOf = (key) => String(key || '').split('|').slice(0, 3).join('|');
      const okFixes = new Map();
      for (const e of FIX_LOG.entries) {
        if (e.phase === 'fix-end' && e.ok && e.rowKey) okFixes.set(prefixOf(e.rowKey), e);
      }
      const rows = this.getFixable()
        .filter(r => okFixes.has(prefixOf(r.key)))
        .map(r => ({
          key: r.key,
          staff: r.staff,
          date: r.date,
          details: r.details,
          period: r.period,
          fixReportedAt: okFixes.get(prefixOf(r.key)).ts,
          warning: 'earlier fix reported ok but this rate still shows wrong — usually the report has not ' +
            'caught up with the save yet; reload again before refixing, and investigate if it persists',
        }));
      return { ok: true, count: rows.length, rows };
    },

    /**
     * Read-only: resolve the CANONICAL class period id for a (date, period)
     * pair using WL's own stale-link recovery endpoint
     * (Wl\Login\Attendance::findNewPeriod — the page uses it to repair
     * attendance URLs whose period was re-keyed). Response semantics:
     * url_attendance present -> the URL embeds the canonical k_class_period
     * (drifted when it differs from the asked id); ok without url_attendance
     * -> the pair is current. Anything else -> unknown, never authoritative.
     */
    resolvePeriod(dateLocal, periodId) {
      const dt = normalizeDateLocal(dateLocal);
      const period = String(periodId || '');
      if (!dt || !period) {
        return Promise.resolve({ ok: false, unknown: true, error: 'resolvePeriod requires dateLocal and periodId' });
      }
      if (!PAGE.AAjax || typeof PAGE.AAjax.method !== 'function') {
        return Promise.resolve({ ok: false, unknown: true, error: 'AAjax.method not available' });
      }
      FIX_LOG.push({ phase: 'resolve-request', dateLocal: dt, period });
      return new Promise(resolve => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          FIX_LOG.push({
            phase: 'resolve-result', dateLocal: dt, period,
            drifted: result.drifted ?? null,
            canonicalPeriod: result.canonicalPeriod || null,
            unknown: result.unknown || false,
            error: result.error || null,
          });
          if (result.drifted === true && result.canonicalPeriod) {
            DRIFT_MAP.set(`${period}|${dt}`, result.canonicalPeriod);
          }
          resolve(result);
        };
        try {
          PAGE.AAjax.method({
            a_data: { dt_date: dt, k_class_period: period },
            call_success(_sender, response) {
              const url = response?.url_attendance || '';
              if (url) {
                const canonical = getUrlParam(url, 'k_class_period');
                if (canonical && canonical !== period) {
                  finish({ ok: true, drifted: true, canonicalPeriod: canonical, urlAttendance: url });
                } else if (canonical) {
                  finish({ ok: true, drifted: false, canonicalPeriod: canonical });
                } else {
                  finish({ ok: true, drifted: null, unknown: true, error: 'url_attendance present but no k_class_period parsed' });
                }
              } else {
                const status = response?.s_status || response?.status || '';
                if (status === 'ok' || !status) {
                  finish({ ok: true, drifted: false, canonicalPeriod: period });
                } else {
                  finish({ ok: true, drifted: null, unknown: true, status, error: `resolver returned status "${status}"` });
                }
              }
            },
            call_fail(_sender, response) {
              finish({ ok: false, drifted: null, unknown: true, error: 'resolver request failed', response });
            },
            s_method: 'Wl\\Login\\Attendance::findNewPeriod',
          });
        } catch (e) {
          finish({ ok: false, drifted: null, unknown: true, error: `resolver threw: ${e.message}` });
        }
        setTimeout(() => finish({ ok: false, drifted: null, unknown: true, error: 'resolver timed out' }), 12000);
      });
    },

    /**
     * Authoritative drift sweep: resolve the canonical period id for scanned
     * rows and report which page ids are stale. scope 'fixable' (default)
     * checks only rows the cascade wants to fix; 'all' checks every row with
     * a (period, date) identity. Sequential, ~0.3s per row.
     */
    async verifyRowIds(scope = 'fixable') {
      const scan = this.scan();
      if (scan.mode !== 'detail') return { ok: false, error: 'id verification requires the detail report' };
      const rows = scan.rows.filter(r => r.period && r.dateLocal && (scope === 'all' || r.category === 'fixable'));
      const drifted = [];
      const unknown = [];
      for (const row of rows) {
        const probe = await this.resolvePeriod(row.dateLocal, row.period);
        if (probe.ok && probe.drifted === true) {
          drifted.push({
            key: row.key, staff: row.staff, date: row.date, details: row.details,
            period: row.period, canonicalPeriod: probe.canonicalPeriod,
          });
        } else if (!probe.ok || probe.unknown) {
          unknown.push({ key: row.key, period: row.period, error: probe.error || null });
        }
        await sleep(250);
      }
      return { ok: true, scope, checked: rows.length, drifted, unknown };
    },

    /**
     * Read-only: attendance reconciliation check using the canonical tooltip.
     *
     * Semantics (matches previous reconcile_attendance.user.js workflow):
     *   - errors: rows where Attended+NoShows+LateCx > Booked (impossible over-count — real data bug)
     *   - needsReconciliation: rows where Booked > sum. NOT necessarily wrong — the gap
     *     represents unresolved check-in status (could be attended/no-show/other unmarked).
     *     Requires manual roster review; do NOT auto-flag as error. Each row includes
     *     `rosterUrl` (from the Booked column anchor) for one-click opening.
     */
    checkAttendance() {
      const mode = getReportMode();
      const rows = document.querySelectorAll('tr.js-content-row');
      const errors = [];
      const needsReconciliation = [];
      const parseSkipped = [];
      rows.forEach(row => {
        const staff = getText(row, COL.staff);
        if (!staff) return;

        let booked, attended, noShows, lateCx;
        let detailsText = '';
        let dateText = '';
        let rosterUrl = null;

        if (mode === 'summary') {
          // Summary rows expose totals directly in the data cells — no tooltip,
          // no per-class breakdown. Just verify the aggregate adds up.
          booked   = parseInt(getText(row, COL.booked),   10);
          attended = parseInt(getText(row, COL.attended), 10);
          noShows  = parseInt(getText(row, COL.noShows),  10);
          lateCx   = parseInt(getText(row, COL.lateCx),   10);
          if ([booked, attended, noShows, lateCx].some(n => Number.isNaN(n))) {
            parseSkipped.push({ key: makeRowKey(row), staff, date: '', details: 'summary row: counts unreadable' });
            return;
          }
          detailsText = `Booked ${booked} / Att ${attended} / NS ${noShows} / LC ${lateCx}`;
        } else {
          const serviceType = getText(row, COL.service);
          const tipEl = getCell(row, COL.details)?.querySelector('[data-title-backup]');
          const tip = tipEl?.getAttribute('data-title-backup') || '';
          const m = tip.match(/Booked:\s*(\d+).*?Attended:\s*(\d+).*?No-shows:\s*(\d+).*?Late cancels:\s*(\d+)/i);
          if (!m) {
            if (serviceType === 'Class') {
              parseSkipped.push({ key: makeRowKey(row), staff, date: getText(row, COL.date), details: getText(row, COL.details) });
            }
            return;
          }
          [booked, attended, noShows, lateCx] = m.slice(1).map(Number);
          detailsText = getText(row, COL.details);
          dateText = getText(row, COL.date);
          rosterUrl = getCell(row, COL.booked)?.querySelector('a')?.href || null;
        }

        const sum = attended + noShows + lateCx;
        const gap = booked - sum;  // positive = unresolved check-ins, negative = impossible over-count
        const base = {
          key: makeRowKey(row),
          staff, details: detailsText, date: dateText,
          booked, attended, noShows, lateCx, rosterUrl,
        };
        if (gap < 0) {
          errors.push({ ...base, overCount: -gap, error: `${attended} + ${noShows} + ${lateCx} = ${sum} > Booked ${booked}` });
        } else if (gap > 0) {
          needsReconciliation.push({ ...base, gap });
        }
      });
      return { ok: true, mode, errors, needsReconciliation, parseSkipped };
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
     * Open each reconciliation row's class roster in a background tab when the
     * userscript manager exposes GM_openInTab. Falls back to anchor activation,
     * which may focus the new tab depending on browser settings.
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
        try {
          if (openAnchorInTab(link, { active: false })) {
            opened++;
            opens.push({ staff, details: getText(row, COL.details).slice(0, 50), date: getText(row, COL.date) });
          } else {
            blocked++;
          }
        } catch (e) {
          blocked++;
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
      return { ok: true, opened: openAnchorInTab(link, { active: false }), key: rowKey };
    },

    /**
     * Mark issue rows directly in the report table for visual review.
     * Uses data attributes and inline styles so it works from console or userscript.
     */
    highlightIssues() {
      if (getReportMode() === 'summary') {
        // Summary mode: only meaningful check is attendance aggregation.
        const att = this.checkAttendance();
        const errKeys = new Map(att.errors.map(e => [e.key, e]));
        const reviewKeys = new Map(att.needsReconciliation.map(r => [r.key, r]));
        const summary = { ok: true, mode: 'summary', highlighted: 0, errors: 0, reconciliation: 0 };
        for (const row of getDataRows()) {
          row.removeAttribute('data-wl-payroll-category');
          row.removeAttribute('data-wl-payroll-issue');
          row.title = '';
          row.style.outline = '';
          row.style.backgroundColor = '';

          const key = makeRowKey(row);
          const err = errKeys.get(key);
          const review = reviewKeys.get(key);
          if (!err && !review) continue;

          const issueText = err
            ? err.error
            : `Booked ${review.booked} > sum ${review.attended + review.noShows + review.lateCx} (gap ${review.gap})`;
          row.dataset.wlPayrollCategory = err ? 'attendance-error' : 'attendance-review';
          row.dataset.wlPayrollIssue = issueText;
          row.title = issueText;
          row.style.outline = err
            ? '2px solid rgba(185, 28, 28, 0.65)'
            : '2px solid rgba(180, 83, 9, 0.65)';
          row.style.backgroundColor = err
            ? 'rgba(248, 113, 113, 0.14)'
            : 'rgba(251, 191, 36, 0.16)';
          summary.highlighted++;
          if (err) summary.errors++; else summary.reconciliation++;
        }
        return summary;
      }

      const summary = { ok: true, mode: 'detail', highlighted: 0, fixable: 0, manual: 0 };
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
        row.period ? `Period:   ${row.period}` : null,
        `Current:  ${row.payRate || '(blank)'}`,
        `Set to:   ${row.expected || '(unknown)'}`,
        '',
        'Click OK to apply this fix.',
        'Click Cancel to skip this row.',
      ].filter(Boolean).join('\n');
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
      closeVisibleClassPopup();
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
      if (!PAGE.Wl_Classes || typeof PAGE.Wl_Classes.quickStaffChangeShow !== 'function') {
        return { ok: false, error: 'Wl_Classes.quickStaffChangeShow not available — page may not be fully loaded' };
      }
      try {
        // Close the gear menu first (mimics the onclick string's a_grid_gear_show(...,'hide'))
        if (typeof PAGE.a_grid_gear_show === 'function') {
          PAGE.a_grid_gear_show(`rs-staff_substitution-view-${visitId}`, 'hide');
        }
        // Then reveal the edit panel
        PAGE.Wl_Classes.quickStaffChangeShow(quickSub);
      } catch (e) {
        return { ok: false, error: 'Wl_Classes.quickStaffChangeShow threw: ' + e.message };
      }
      return { ok: true, triggered: visitId };
    },

    /**
     * Verification step: is the apply (.js-button-apply > button.css-fa--check) now visible?
     */
    isConfirmReady() {
      const popup = getVisibleClassPopup();
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
     * Pass the keyword from the cascade (e.g. 'community', 'hybrid', 'aerial', '75-90', '75', '45-60').
     */
    selectPayRate(keyword) {
      const popup = getVisibleClassPopup();
      const selects = popup ? popup.querySelectorAll('select') : document.querySelectorAll('select');
      const paySelect = Array.from(selects).find(s => s.name === 'k_staff_pay');
      if (!paySelect) return { ok: false, error: 'k_staff_pay select not found — form not ready?' };

      const rule = CASCADE.find(item => item.keyword === keyword);
      const target = Array.from(paySelect.options).find(o => {
        const optionText = o.text.toLowerCase();
        return rule?.optionTest ? rule.optionTest(optionText) : optionText.includes(keyword.toLowerCase());
      });
      if (!target) {
        return {
          ok: false,
          error: `no option matching keyword "${keyword}"`,
          availableOptions: Array.from(paySelect.options).map(o => o.text),
        };
      }
      paySelect.value = target.value;
      target.selected = true;
      paySelect.dispatchEvent(new Event('change', { bubbles: true }));
      paySelect.dispatchEvent(new Event('input',  { bubbles: true }));
      const jqSelect = pageQuery(paySelect);
      if (jqSelect) {
        jqSelect.val(target.value).trigger('change').trigger('input');
        if (PAGE.Core_Html_Select?.update) PAGE.Core_Html_Select.update(jqSelect);
      }
      if (paySelect.value !== target.value) {
        return {
          ok: false,
          error: `pay select did not retain value "${target.value}"`,
          selectedValue: paySelect.value,
          expectedValue: target.value,
        };
      }
      return { ok: true, selected: target.text, value: target.value };
    },

    /**
     * Commit Quick Substitution through the same AJAX endpoint WL's apply button
     * uses, without dispatching a bubbling click that can close the popup first.
     *
     * canonicalPeriodOverride (auto-heal): when the page's period id is stale
     * and resolvePeriod() returned the canonical id, the override replaces
     * ONLY the payload's k_class_period. The popup/holder/period guards still
     * compare the popup against the page row (stale == stale, by design), and
     * the DATE guards stay fully strict — the override never touches dates, so
     * a wrong-date write remains impossible; a wrong override id is refused
     * server-side (date-out) without writing. k_staff/k_staff_pay ids are
     * business-global, safe to send under a different period id.
     */
    saveQuickSubDirect(expectedPayValue = null, expectedDateLocal = null, expectedPeriod = null, canonicalPeriodOverride = null) {
      const popup = getVisibleClassPopup();
      if (!popup) return Promise.resolve({ ok: false, error: 'popup not present' });
      if (!PAGE.AAjax || typeof PAGE.AAjax.method !== 'function') {
        return Promise.resolve({ ok: false, error: 'AAjax.method not available' });
      }

      const staffContainer = popup.querySelector('.js-staff-container');
      if (!staffContainer) return Promise.resolve({ ok: false, error: '.js-staff-container not found' });
      const shownStaff = staffContainer.querySelector('.js-single-staff-block.js-show');
      const currentStaff = shownStaff?.getAttribute('data-staff') || '';
      const currentPeriod = shownStaff?.getAttribute('data-period') || getOpenPopupPeriod();
      if (!currentPeriod) return Promise.resolve({ ok: false, error: 'could not determine class period for save' });
      const popupDateLocal = getOpenPopupDateLocal();
      const popupPeriod = getOpenPopupPeriod();
      const normalizedExpected = normalizeDateLocal(expectedDateLocal);

      // Strict guards to prevent phantom DB rows from mismatched (period, date)
      // upserts. The WL endpoint creates a NEW payroll record when the (period,
      // date) PK doesn't exist. Refuse to save unless every value is known and
      // matches — no fallback to staffContainer data-date for the payload.
      const refuse = (error, extras) => {
        const result = { ok: false, error, currentPeriod, ...extras };
        FIX_LOG.push({ phase: 'save-refused', ...result, snapshot: capturePopupSnapshot() });
        return Promise.resolve(result);
      };
      if (!normalizedExpected) {
        return refuse('save refused: expectedDateLocal required (call via fixRow, not direct)');
      }
      if (!popupDateLocal) {
        return refuse('save refused: popup date unreadable (popup may not be fully rendered)', { expectedDateLocal: normalizedExpected });
      }
      if (normalizedExpected !== popupDateLocal) {
        return refuse(`save refused: popup date mismatch — expected ${normalizedExpected}, got ${popupDateLocal}`, { expectedDateLocal: normalizedExpected, popupDateLocal });
      }
      if (expectedPeriod && currentPeriod !== expectedPeriod) {
        return refuse(`save refused: popup period mismatch — expected ${expectedPeriod}, got ${currentPeriod}`, { expectedPeriod });
      }
      if (popupPeriod && currentPeriod !== popupPeriod) {
        return refuse(`save refused: internal period mismatch — shown staff ${currentPeriod}, popup ${popupPeriod}`, { popupPeriod });
      }
      const dateLocal = normalizedExpected;
      const savePeriod = canonicalPeriodOverride || currentPeriod;

      const holder = staffContainer.querySelector(`.js-class-quick-holder--${currentPeriod}-${currentStaff}`) ||
        Array.from(staffContainer.querySelectorAll('.js-class-quick-one-holder')).find(el =>
          el.querySelector('select[name="k_staff"]')?.getAttribute('data-period') === currentPeriod);
      if (!holder) return Promise.resolve({ ok: false, error: 'quick substitution holder not found' });

      const staffSelect = holder.querySelector('select[name="k_staff"]');
      const paySelect = holder.querySelector('select[name="k_staff_pay"]');
      if (!staffSelect) return Promise.resolve({ ok: false, error: 'k_staff select not found' });
      if (!paySelect) return Promise.resolve({ ok: false, error: 'k_staff_pay select not found' });
      if (expectedPayValue && paySelect.value !== expectedPayValue) {
        return Promise.resolve({
          ok: false,
          error: `pay select value mismatch before save: expected ${expectedPayValue}, got ${paySelect.value || '(blank)'}`,
          expectedPayValue,
          actualPayValue: paySelect.value,
        });
      }

      const staffPayload = Array.from(staffContainer.querySelectorAll('.js-class-quick-one-holder')).map(item => {
        const kStaff = item.querySelector('select[name="k_staff"]');
        const kStaffPay = item.querySelector('select[name="k_staff_pay"]');
        return {
          k_staff: kStaff?.value || '',
          k_staff_pay: kStaffPay?.value || '',
          uid_staff: kStaff?.selectedOptions?.[0]?.getAttribute('data-uid') || '',
        };
      }).filter(item => item.k_staff);

      const payload = {
        a_staff: staffPayload,
        dt_date_local: dateLocal,
        k_class_period: savePeriod,
      };
      FIX_LOG.push({
        phase: 'save-payload',
        payload,
        periodOverride: canonicalPeriodOverride ? { from: currentPeriod, to: canonicalPeriodOverride } : null,
        snapshot: capturePopupSnapshot(),
      });

      return new Promise(resolve => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          FIX_LOG.push({ phase: 'save-result', ok: result.ok, error: result.error || null, status: result.status || null, period: savePeriod, healed: Boolean(canonicalPeriodOverride), dateLocal });
          resolve(result);
        };
        try {
          DRIVER_SAVE_IN_FLIGHT = true;
          PAGE.AAjax.method({
            a_data: payload,
            call_success(_sender, response) {
              const status = response?.s_status || response?.status || '';
              if (status === 'ok') {
                RELOAD_REQUIRED_PERIODS.add(currentPeriod);
                if (canonicalPeriodOverride) RELOAD_REQUIRED_PERIODS.add(canonicalPeriodOverride);
                const selectedPay = paySelect.selectedOptions?.[0];
                const staffName = staffSelect.selectedOptions?.[0]?.textContent?.trim() || '';
                const payTitle = selectedPay?.getAttribute('data-title') || selectedPay?.textContent?.trim() || '';
                shownStaff?.querySelector('.js-service-popup-staff-name')?.replaceChildren(document.createTextNode(staffName));
                shownStaff?.querySelector('.js-service-popup-staff-pay-name')?.replaceChildren(document.createTextNode(payTitle));
                staffSelect.dataset.staff = staffSelect.value;
                staffSelect.dataset.pay = paySelect.value;
                holder.querySelector('.js-buttons-container')?.style.setProperty('display', 'none');
                finish({ ok: true, status, period: savePeriod, periodUsed: savePeriod, healed: Boolean(canonicalPeriodOverride), dateLocal, selected: payTitle, value: paySelect.value });
              } else if (status === 'class-period-date-out') {
                holder.querySelector('.js-buttons-container')?.style.removeProperty('display');
                RELOAD_REQUIRED_PERIODS.add(currentPeriod);
                if (canonicalPeriodOverride) RELOAD_REQUIRED_PERIODS.add(canonicalPeriodOverride);
                finish({
                  ok: false,
                  status,
                  staleClassPeriod: true,
                  error: `WL refused: ${dateLocal} no longer belongs to class period ${savePeriod} — ` +
                    'the series was re-keyed by an earlier fix or a schedule edit. Reload the report and ' +
                    'rescan to pick up the new period id, then retry this row.',
                  response,
                });
              } else {
                holder.querySelector('.js-buttons-container')?.style.removeProperty('display');
                finish({ ok: false, status: status || null, error: `save returned status "${status || 'unknown'}"`, response });
              }
            },
            call_fail(_sender, response) {
              holder.querySelector('.js-buttons-container')?.style.removeProperty('display');
              finish({ ok: false, error: 'save request failed', response });
            },
            is_overlay: true,
            s_method: 'Wl\\Classes\\Period\\Staff\\Ajax::staffSubstituteSave',
          });
        } catch (e) {
          finish({ ok: false, error: `AAjax save threw: ${e.message}` });
        } finally {
          DRIVER_SAVE_IN_FLIGHT = false;
        }
        setTimeout(() => finish({ ok: false, error: 'save request timed out' }), 12000);
      });
    },

    /**
     * Step 2e: click the actual save button (.js-button-apply > button.css-fa--check).
     *
     * The skill's original selector ('css-btn-filled-primary' anywhere in popup) caught
     * the "View attendance list" button instead — that nav button is also styled primary.
     * The correct target is the checkmark button INSIDE .js-button-apply.
     */
    confirm() {
      const popup = getVisibleClassPopup();
      if (!popup) return { ok: false, error: 'popup not present' };
      const applyWrap = popup.querySelector('.js-button-apply');
      if (!applyWrap) return { ok: false, error: '.js-button-apply not found — triggerQuickSub did not complete?' };
      if (window.getComputedStyle(applyWrap).visibility !== 'visible') {
        return { ok: false, error: '.js-button-apply still visibility:hidden — Wl_Classes.quickStaffChangeShow did not run?' };
      }
      const btn = applyWrap.querySelector('button.css-fa--check, button');
      if (!btn) return { ok: false, error: 'no button inside .js-button-apply' };
      const jqButton = pageQuery(btn);
      if (jqButton) {
        jqButton.triggerHandler('click');
      } else {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
      }
      return { ok: true, clicked: true };
    },

    /**
     * Reload the report page to pull fresh server-side data. The Payroll Details
     * table caches rows from when the report was generated, so post-fix changes
     * don't appear until the page is reloaded. Use this after a batch of fixes.
     * NOTE: reload tears down this instance, but the @match userscript re-injects
     * automatically on the fresh page (the URL still matches). Manual re-injection
     * is only needed under the console-paste dev fallback.
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
     * IMPORTANT: a successful save re-keys the rest of the class series server-side
     * (see RELOAD_REQUIRED_PERIODS). The result carries `reloadRequired: true`;
     * reload + rescan before fixing any other row, especially of the same series —
     * further fixRow calls against the touched period are refused with phase
     * 'reload-required' until the page is reloaded.
     *
     * @param {string} rowKey - from scan().rows[].key
     * @param {string} keyword - one of 'community', 'hybrid', 'aerial', '75-90', '75', '45-60'
     * @param {object} [options] - {autoHeal}: override the Auto-heal panel
     *   setting for this call. When the preflight resolver reports the row's
     *   period id drifted: autoHeal on -> save with the canonical id;
     *   off -> abort with phase 'drift-detected'.
     */
    async fixRow(rowKey, keyword, options = {}) {
      const row = getRowByKey(rowKey);
      const expectedPeriod = row ? getRowPeriod(row) : '';
      const expectedDateLocal = row ? getRowDateLocal(row) : '';
      FIX_LOG.push({ phase: 'fix-start', rowKey, keyword, expectedPeriod, expectedDateLocal });
      // Early aborts must reach the fix log too — without this, failures before
      // the save phase (verify-popup especially) are invisible in exports.
      const abort = (result) => {
        FIX_LOG.push({ phase: 'fix-abort', rowKey, keyword, ...result });
        return result;
      };
      if (expectedPeriod && RELOAD_REQUIRED_PERIODS.has(expectedPeriod)) {
        return abort({
          ok: false,
          phase: 'reload-required',
          key: rowKey,
          period: expectedPeriod,
          error: `class period ${expectedPeriod} was re-keyed by an earlier fix this page load — ` +
            'reload the report and rescan before fixing this row',
        });
      }
      // Drift preflight: ask WL's resolver whether the page's period id is
      // still canonical. Unknown/unreachable resolver falls through to the
      // existing guarded behavior — the preflight only ever tightens safety.
      let canonicalOverride = null;
      if (expectedPeriod && expectedDateLocal) {
        const autoHeal = options.autoHeal ?? UI.settings.autoHealDrift;
        const probe = await this.resolvePeriod(expectedDateLocal, expectedPeriod);
        if (probe.ok && probe.drifted === true && probe.canonicalPeriod) {
          if (!autoHeal) {
            return abort({
              ok: false,
              phase: 'drift-detected',
              key: rowKey,
              period: expectedPeriod,
              canonicalPeriod: probe.canonicalPeriod,
              error: `page period id ${expectedPeriod} is stale (canonical ${probe.canonicalPeriod}) — ` +
                'reload the report, or enable the Auto-heal drifted ids setting',
            });
          }
          canonicalOverride = probe.canonicalPeriod;
          FIX_LOG.push({ phase: 'fix-heal', rowKey, keyword, from: expectedPeriod, to: canonicalOverride });
        }
      }
      const open = this.openRow(rowKey);
      if (!open.ok) return abort({ ok: false, phase: 'open', key: rowKey, ...open });
      await sleep(800);
      const actualPeriod = getOpenPopupPeriod();
      const actualDateLocal = getOpenPopupDateLocal();
      if (expectedPeriod && actualPeriod && actualPeriod !== expectedPeriod) {
        return abort({
          ok: false,
          phase: 'verify-popup',
          key: rowKey,
          expectedPeriod,
          actualPeriod,
          error: `opened popup period ${actualPeriod}, expected ${expectedPeriod}`,
        });
      }
      if (expectedDateLocal && actualDateLocal && actualDateLocal !== expectedDateLocal) {
        return abort({
          ok: false,
          phase: 'verify-popup',
          key: rowKey,
          expectedDateLocal,
          actualDateLocal,
          error: `opened popup date ${actualDateLocal}, expected ${expectedDateLocal}`,
        });
      }
      const id = this.findSubContainerId();
      if (!id.ok) return abort({ ok: false, phase: 'find', key: rowKey, ...id });
      const trig = this.triggerQuickSub(id.id);
      if (!trig.ok) return abort({ ok: false, phase: 'trigger', key: rowKey, visitId: id.id, ...trig });
      await sleep(300);
      const sel = this.selectPayRate(keyword);
      if (!sel.ok) return abort({ ok: false, phase: 'select', key: rowKey, visitId: id.id, ...sel });
      await sleep(150);
      const direct = await this.saveQuickSubDirect(sel.value, expectedDateLocal, expectedPeriod, canonicalOverride);
      if (!direct.ok && direct.error !== 'AAjax.method not available') {
        const failed = { phase: 'save', key: rowKey, visitId: id.id, selected: sel.selected, ...direct };
        FIX_LOG.push({ phase: 'fix-end', rowKey, keyword, ok: false, error: direct.error });
        return failed;
      }
      if (!direct.ok) {
        const conf = this.confirm();
        if (!conf.ok) {
          FIX_LOG.push({ phase: 'fix-end', rowKey, keyword, ok: false, error: conf.error });
          return { phase: 'confirm', key: rowKey, visitId: id.id, ...conf };
        }
      }
      await sleep(800);
      const toast = this.checkSuccessToast();
      FIX_LOG.push({ phase: 'fix-end', rowKey, keyword, ok: true, saveMode: direct.ok ? 'direct-ajax' : 'button-fallback', selected: direct.selected || sel.selected, healed: direct.healed || false });
      return {
        ok: true,
        key: rowKey,
        visitId: id.id,
        selected: direct.selected || sel.selected,
        saveMode: direct.ok ? 'direct-ajax' : 'button-fallback',
        reloadRequired: true,
        period: expectedPeriod || null,
        healed: direct.healed || false,
        periodUsed: direct.periodUsed || null,
        toast,
      };
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

    // -- Fix log access (audit + phantom-row debugging) --
    getFixLog() {
      return { ok: true, count: FIX_LOG.entries.length, entries: FIX_LOG.entries.slice() };
    },
    clearFixLog() {
      const n = FIX_LOG.entries.length;
      FIX_LOG.clear();
      return { ok: true, cleared: n };
    },
    exportFixLog() {
      return { ok: true, count: FIX_LOG.entries.length, json: JSON.stringify(FIX_LOG.entries, null, 2) };
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
    settings: {
      skipFixConfirm: loadSetting('skipFixConfirm', false),
      autoHealDrift: loadSetting('autoHealDrift', false),
      remindReload: loadSetting('remindReload', true),
    },
  };

  function loadSetting(name, fallback) {
    try {
      const value = localStorage.getItem(`WLPayrollDriver.${name}`);
      return value === null ? fallback : value === 'true';
    } catch (e) {
      return fallback;
    }
  }

  function saveSetting(name, value) {
    try {
      localStorage.setItem(`WLPayrollDriver.${name}`, value ? 'true' : 'false');
    } catch (e) {
      // Ignore storage failures; the checkbox still controls this page session.
    }
  }

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
      #${UI.id} .wlpd-option {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #334155;
        white-space: nowrap;
      }
      #${UI.id} .wlpd-option input { margin: 0; }
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
      #${UI.id} .wlpd-investigate {
        border: 1px solid #d8dee8;
        border-radius: 6px;
        padding: 8px 10px;
        background: #f8fafc;
        color: #334155;
      }
      #${UI.id} .wlpd-investigate[hidden] { display: none; }
      #${UI.id} .wlpd-investigate ol { margin: 6px 0 6px 18px; padding: 0; }
      #${UI.id} .wlpd-investigate li { margin: 3px 0; }
      #${UI.id} .wlpd-investigate code {
        background: #e2e8f0;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 12px;
      }
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

  function renderPanel(scan, attendance, stuck) {
    const panel = document.getElementById(UI.id);
    if (!panel) return;
    const counts = panel.querySelector('.wlpd-counts');
    const list = panel.querySelector('.wlpd-list');
    const attErrors = attendance?.errors || [];
    const attReview = attendance?.needsReconciliation || [];
    const attSkipped = attendance?.parseSkipped || [];
    const stuckByKey = new Map((stuck?.rows || []).map(row => [row.key, row]));
    const issueRows = scan.rows.filter(row => row.category !== 'ok');

    counts.innerHTML = [
      `<span class="wlpd-pill">Rows ${scan.totalRows}</span>`,
      `<span class="wlpd-pill" data-tone="${scan.fixable ? 'warn' : 'ok'}">Fixable ${scan.fixable}</span>`,
      `<span class="wlpd-pill" data-tone="${scan.manual ? 'bad' : 'ok'}">Manual ${scan.manual}</span>`,
      `<span class="wlpd-pill" data-tone="${attReview.length ? 'warn' : 'ok'}">Roster review ${attReview.length}</span>`,
      `<span class="wlpd-pill" data-tone="${attErrors.length ? 'bad' : 'ok'}">Attendance errors ${attErrors.length}</span>`,
      ...(attSkipped.length ? [`<span class="wlpd-pill" data-tone="warn">Unreadable ${attSkipped.length}</span>`] : []),
      ...(stuckByKey.size ? [`<span class="wlpd-pill" data-tone="bad">Did not stick ${stuckByKey.size}</span>`] : []),
      ...(SESSION_DATE_OUT_COUNT ? [`<span class="wlpd-pill" data-tone="bad">Date-out ${SESSION_DATE_OUT_COUNT}</span>`] : []),
      ...(DRIFT_MAP.size ? [`<span class="wlpd-pill" data-tone="bad">Drifted ${DRIFT_MAP.size}</span>`] : []),
    ].join('');

    const parts = [];
    for (const row of issueRows) {
      const canFix = row.category === 'fixable';
      const stuckRow = stuckByKey.get(row.key);
      const driftCanonical = row.period && row.dateLocal ? DRIFT_MAP.get(`${row.period}|${row.dateLocal}`) : null;
      parts.push(`
        <div class="wlpd-issue" data-category="${escapeHtml(row.category)}" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">${escapeHtml(row.staff)} - ${escapeHtml(row.date)}</div>
          <div class="wlpd-meta">${escapeHtml(row.details)}</div>
          ${row.period ? `<div class="wlpd-meta">Class period ${escapeHtml(row.period)}${row.dateLocal ? ` / ${escapeHtml(row.dateLocal)}` : ''}</div>` : ''}
          ${row.sharedPeriodRows ? `<div class="wlpd-meta" style="color:#92400e;font-weight:600;">Period shared with ${escapeHtml(row.sharedPeriodRows)} other row${row.sharedPeriodRows === 1 ? '' : 's'} — fixing one re-keys the rest; reload before fixing them</div>` : ''}
          <div class="wlpd-meta">${escapeHtml(row.issue || '')}</div>
          ${stuckRow ? `<div class="wlpd-meta" style="color:#991b1b;font-weight:600;">Earlier fix reported ok but still shows wrong — report may not have caught up; reload again before refixing</div>` : ''}
          ${driftCanonical ? `<div class="wlpd-meta" style="color:#991b1b;font-weight:600;">ID drifted — canonical period ${escapeHtml(driftCanonical)}; auto-heal or reload</div>` : ''}
          <div class="wlpd-row-actions" style="margin-top:7px;">
            <button data-action="open" data-key="${escapeHtml(row.key)}">Open</button>
            ${canFix ? `<button data-action="fix" data-primary="true" data-key="${escapeHtml(row.key)}">Set ${escapeHtml(row.expectedKeyword)}</button>` : ''}
          </div>
        </div>
      `);
    }
    const rowMeta = (row) => row.date ? `${escapeHtml(row.date)} - ${escapeHtml(row.details)}` : escapeHtml(row.details);
    const rosterActions = (row) => row.rosterUrl
      ? `<div class="wlpd-row-actions" style="margin-top:7px;"><button data-action="roster" data-key="${escapeHtml(row.key)}">Roster</button></div>`
      : '';
    for (const row of attErrors) {
      parts.push(`
        <div class="wlpd-issue" data-category="attendance" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">Attendance over-count - ${escapeHtml(row.staff)}</div>
          <div class="wlpd-meta">${rowMeta(row)}</div>
          <div class="wlpd-meta">${escapeHtml(row.error)}</div>
          ${rosterActions(row)}
        </div>
      `);
    }
    for (const row of attReview) {
      parts.push(`
        <div class="wlpd-issue" data-category="attendance" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">Roster review - ${escapeHtml(row.staff)}</div>
          <div class="wlpd-meta">${rowMeta(row)}</div>
          <div class="wlpd-meta">Booked gap: ${escapeHtml(row.gap)}</div>
          ${rosterActions(row)}
        </div>
      `);
    }
    for (const row of attSkipped) {
      parts.push(`
        <div class="wlpd-issue" data-category="unreadable" data-key="${escapeHtml(row.key)}">
          <div class="wlpd-main">Unreadable - ${escapeHtml(row.staff)}</div>
          <div class="wlpd-meta">${escapeHtml(row.date)} - ${escapeHtml(row.details)}</div>
          <div class="wlpd-meta">Tooltip did not match expected attendance format</div>
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
    const stuck = scan.mode === 'summary' ? { ok: true, count: 0, rows: [] } : API.checkFixesStuck();
    UI.lastScan = { scan, attendance, stuck, at: new Date() };
    API.highlightIssues();
    renderPanel(scan, attendance, stuck);
    const skippedNote = attendance.parseSkipped.length ? `, ${attendance.parseSkipped.length} unreadable` : '';
    if (scan.mode === 'summary') {
      const mismatches = attendance.errors.length + attendance.needsReconciliation.length;
      notifyPanel(`Summary scan: ${scan.totalRows} staff, ${mismatches} attendance mismatch${mismatches === 1 ? '' : 'es'}${skippedNote}.`);
    } else if (stuck.count) {
      notifyPanel(`Scan complete: ${scan.fixable} fixable, ${scan.manual} manual${skippedNote} — ${stuck.count} earlier fix${stuck.count === 1 ? '' : 'es'} did NOT stick; check sibling dates.`, 'warn');
    } else {
      notifyPanel(`Scan complete: ${scan.fixable} fixable, ${scan.manual} manual, ${attendance.needsReconciliation.length} roster review${skippedNote}.`);
    }
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
      notifyPanel(`Opened ${result.opened} roster tabs in background.`);
      return;
    }
    if (action === 'verify-ids') {
      button.disabled = true;
      notifyPanel('Verifying period ids against WL…');
      const result = await API.verifyRowIds('fixable');
      button.disabled = false;
      if (!result.ok) {
        notifyPanel(`Id verification failed: ${result.error}`, 'error');
        return;
      }
      if (UI.lastScan) renderPanel(UI.lastScan.scan, UI.lastScan.attendance, UI.lastScan.stuck);
      const unknownNote = result.unknown.length ? `, ${result.unknown.length} unknown` : '';
      notifyPanel(result.drifted.length
        ? `Id check: ${result.drifted.length} of ${result.checked} fixable rows DRIFTED${unknownNote} — auto-heal or reload before fixing them.`
        : `Id check: all ${result.checked} fixable row ids are current${unknownNote}.`,
        result.drifted.length ? 'warn' : 'info');
      return;
    }
    if (action === 'refresh') {
      if (confirm('Reload the Payroll Details report now? The userscript will reattach after reload.')) {
        API.refreshReport();
      }
      return;
    }
    if (action === 'export-log') {
      const result = API.exportFixLog();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(result.json).then(
          () => notifyPanel(`Copied ${result.count} fix-log entries to clipboard.`),
          () => notifyPanel(`Clipboard blocked. ${result.count} entries available via WLPayrollDriver.getFixLog().`, 'warn')
        );
      } else {
        notifyPanel(`Clipboard unavailable. ${result.count} entries available via WLPayrollDriver.getFixLog().`, 'warn');
      }
      return;
    }
    if (action === 'clear-log') {
      if (!confirm('Clear all stored fix-log entries? This cannot be undone.')) return;
      const result = API.clearFixLog();
      notifyPanel(`Cleared ${result.cleared} fix-log entries.`);
      return;
    }
    if (action === 'toggle-investigate') {
      const box = document.getElementById(UI.id)?.querySelector('.wlpd-investigate');
      if (box) box.hidden = !box.hidden;
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
      notifyPanel(result.ok ? 'Opened roster tab in background.' : result.error, result.ok ? 'info' : 'error');
      return;
    }
    if (action === 'fix' && key) {
      const item = (UI.lastScan?.scan?.rows || API.scan().rows).find(row => row.key === key);
      if (!item) {
        notifyPanel('Could not find row in current scan.', 'error');
        return;
      }
      if (!UI.settings.skipFixConfirm && !API.confirmBeforeFix(item)) {
        notifyPanel('Skipped fix.');
        return;
      }
      button.disabled = true;
      notifyPanel(`Fixing ${item.staff} - ${item.date}...`);
      const result = await API.fixRow(item.key, item.expectedKeyword);
      button.disabled = false;
      if (!result.ok) {
        const tone = result.phase === 'reload-required' || result.staleClassPeriod ? 'warn' : 'error';
        notifyPanel(`Fix failed at ${result.phase || 'unknown'}: ${result.error || 'unknown error'}`, tone);
        return;
      }
      const sharesPeriod = result.period
        ? (UI.lastScan?.scan?.rows || []).some(r =>
            r.key !== result.key && r.category === 'fixable' && r.period === result.period)
        : false;
      if (!sharesPeriod) {
        notifyPanel(`Fix saved: ${result.selected}.${result.healed ? ` Healed: saved with canonical period ${result.periodUsed}.` : ''} Other rows can be fixed without reloading.`, 'info');
        return;
      }
      notifyPanel(`Fix saved: ${result.selected}.${result.healed ? ` Healed: saved with canonical period ${result.periodUsed}.` : ''} Other fixable rows share this class period — reload before fixing them.`, 'warn');
      // The blocking reload prompt is a convenience only — RELOAD_REQUIRED_PERIODS
      // already refuses further same-period saves until reload, so suppressing the
      // modal (Reload reminders off) is safe; the warn note above still informs.
      if (UI.settings.remindReload && confirm([
        'Fix saved.',
        '',
        'Other fixable rows on this page share the class period just saved, and WL',
        're-keys the series after a save — their period ids are now stale.',
        '',
        'Reload the report now? (Recommended. Cancel only to fix rows of OTHER classes;',
        'same-period rows stay blocked until reload either way.)',
      ].join('\n'))) {
        API.refreshReport();
      }
    }
  }

  function onPanelChange(event) {
    const input = event.target.closest('input[data-setting]');
    if (!input) return;
    if (input.dataset.setting === 'skip-fix-confirm') {
      UI.settings.skipFixConfirm = input.checked;
      saveSetting('skipFixConfirm', UI.settings.skipFixConfirm);
      notifyPanel(UI.settings.skipFixConfirm
        ? 'Fix confirmation is disabled.'
        : 'Fix confirmation is enabled.');
    }
    if (input.dataset.setting === 'auto-heal-drift') {
      UI.settings.autoHealDrift = input.checked;
      saveSetting('autoHealDrift', UI.settings.autoHealDrift);
      notifyPanel(UI.settings.autoHealDrift
        ? 'Auto-heal is ON: fixes on drifted rows save with the resolved canonical period id.'
        : 'Auto-heal is OFF: fixes on drifted rows are blocked until reload.');
    }
    if (input.dataset.setting === 'remind-reload') {
      UI.settings.remindReload = input.checked;
      saveSetting('remindReload', UI.settings.remindReload);
      notifyPanel(UI.settings.remindReload
        ? 'Reload reminders are ON: a fix that re-keys a shared class period prompts to reload.'
        : 'Reload reminders are OFF: same-period rows still stay blocked until you reload manually.');
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
            <button data-action="verify-ids" title="Authoritative period-id check via WL's resolver">Verify ids</button>
            <button data-action="refresh">Reload</button>
            <button data-action="export-log" title="Copy fix log JSON to clipboard">Export log</button>
            <button data-action="toggle-investigate" title="Show phantom-row debug tip">Phantom tip</button>
            <label class="wlpd-option">
              <input type="checkbox" data-setting="skip-fix-confirm" ${UI.settings.skipFixConfirm ? 'checked' : ''}>
              Skip fix confirm
            </label>
            <label class="wlpd-option" title="When a fix's period id is stale, save with the resolved canonical id instead of blocking">
              <input type="checkbox" data-setting="auto-heal-drift" ${UI.settings.autoHealDrift ? 'checked' : ''}>
              Auto-heal drifted ids
            </label>
            <label class="wlpd-option" title="Show the blocking 'reload now?' prompt after a fix that re-keys a shared class period. Off drops the modal only — stale same-period saves stay blocked until you reload.">
              <input type="checkbox" data-setting="remind-reload" ${UI.settings.remindReload ? 'checked' : ''}>
              Reload reminders
            </label>
          </div>
          <div class="wlpd-investigate" hidden>
            <strong>If you suspect a phantom row</strong>
            <ol>
              <li>Open DevTools (Cmd+Opt+I / F12) before clicking Fix.</li>
              <li>Run the Fix as normal.</li>
              <li>Click <strong>Export log</strong> &mdash; the JSON copies to your clipboard.</li>
              <li>Paste it anywhere and look at the most recent <code>save-payload</code> entry. The <code>snapshot</code> shows what the popup told us; the <code>payload</code> shows what we sent to WL. Mismatch = phantom risk.</li>
            </ol>
            <details>
              <summary>Deeper investigation (manual DOM/network check)</summary>
              <ol>
                <li>Elements tab: watch <code>.js-single-staff-block.js-show</code> &mdash; note <code>data-period</code> and <code>data-date</code> as the popup opens.</li>
                <li>Network tab: filter by <code>staffSubstituteSave</code> and inspect the request payload.</li>
                <li>Reload the report after fix. A new $0/0/0/0 row at the same date/time = mis-keyed save.</li>
              </ol>
            </details>
            <div style="margin-top:6px;">
              <button data-action="clear-log" data-danger="true" title="Wipe stored fix log">Clear log</button>
            </div>
          </div>
          <div class="wlpd-counts"></div>
          <div class="wlpd-status">Ready. Run Scan after the Payroll Details report has loaded.</div>
          <div class="wlpd-list"></div>
        </div>
      `;
      panel.addEventListener('click', onPanelClick);
      panel.addEventListener('change', onPanelChange);
      document.body.appendChild(panel);
    }
    if (options.autoScan) runPanelScan();
    return { ok: true, panelId: UI.id };
  }

  API.installPanel = installPanel;
  API.runPanelScan = runPanelScan;
  API.notify = notifyPanel;

  window.WLPayrollDriver = API;
  PAGE.WLPayrollDriver = API;
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
