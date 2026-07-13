# Status

## Current state
Active WellnessLiving automation project; this repo supersedes the old
attendance-payroll work. The current deliverable is WL Payroll Driver v1.7.0:
a browser userscript, operator panel/console API, business-rule spec, and Chrome
orchestration playbook for payroll-detail audits and guarded pay-rate fixes.

The docs/driver drift check and JavaScript syntax check pass. Local `main` is
one scaffold commit ahead of `origin/main` as of 2026-07-13.

## In flight
Nothing active.

## Known issues
- Public repo — keep member, payroll, and business data out. Local captured
  WellnessLiving pages live under ignored `reference/` and must never be staged.
- The userscript's `@downloadURL` and `@updateURL` target the raw file on
  `main`; pushing a userscript version bump can deploy through installed
  userscript managers.
- Pagination is a stub. Multi-page reports require manual page changes and a
  separate scan on every page.
- The guarded direct-AJAX save is the verified primary path. The rare UI-button
  fallback currently records success after clicking even when no success toast
  is found, so its result should be treated as unverified until hardened.
- WellnessLiving can asynchronously re-key recurring class periods and delay
  report updates. Reload/rescan and the driver's period/date guards are required.
- There is no fixture/unit-test suite; current automated coverage is the
  docs/cascade drift guard plus `node --check`.

## Next steps
1. Run scan-only validation against known-clean and known-dirty payroll periods,
   comparing results with a manual audit.
2. Probe a multi-page report and implement pagination support.
3. Harden the UI-button fallback so it cannot report success without positive
   save confirmation.
4. Consider a sanitized DOM fixture/test harness for classification and
   attendance parsing without committing real report data.
