# Map

Codebase orientation: where things live and why. Update only when the
structure changes.

## Runtime

- `wl-payroll-driver.user.js` — the single browser implementation. It is a
  Violentmonkey/Tampermonkey userscript (currently v1.7.0) that injects on
  WellnessLiving payroll summary/detail reports, exposes
  `WLPayrollDriver`, and renders the floating operator panel.
- Its major internal layers are: stable report-column selectors and pay-rate
  cascade; row classification and attendance reconciliation; period-id drift
  resolution and guarded Quick Substitution saves; persistent audit logging;
  operator-panel rendering and actions.

## Specification and operations

- `SKILL.md` — business rules, report DOM contract, and monthly audit/fix
  workflow. This is the specification; selector and endpoint details belong in
  the userscript.
- `wl-payroll-driver-playbook.md` — human/Chrome orchestration, safety model,
  failure recovery, and known WellnessLiving timing/re-key behavior.
- `sdk_payrate_eval.md` — records why the public WellnessLiving PHP SDK does not
  replace the browser driver for pay-rate writes.
- `scripts/check-docs-drift.sh` — checks forbidden implementation leakage into
  docs, save-path documentation, version/cascade parity, and JavaScript syntax.

## Project support

- `AGENTS.md` — canonical repository instructions; `CLAUDE.md` and `GEMINI.md`
  point to it.
- `.project/` — current status, append-only session changelog, and this map.
- `reference/` — ignored, local-only saved WellnessLiving pages used for
  investigation. It may contain private business data and is never committed.
- `wl-sdk/` — optional ignored vendor checkout used only for SDK evaluation.

## Operational flow

The report DOM is read by `scan()` and `checkAttendance()`. Deterministic rules
classify rows as OK, fixable, or manual review. A confirmed fix preflights the
row's period id, opens and verifies the matching period/date popup, selects the
expected pay rate, and normally saves through WellnessLiving's own AJAX method.
The local fix log and reload-required ledger protect against stale recurring
class ids. Pagination remains manual.

## Deployment boundary

The userscript's update/download URLs point at the raw `main` branch. A push
that changes and versions `wl-payroll-driver.user.js` can therefore reach
installed userscript managers; review and validate before pushing `main`.
