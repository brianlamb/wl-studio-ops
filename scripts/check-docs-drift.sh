#!/bin/zsh
# check-docs-drift.sh — guard against implementation detail leaking back into the docs.
#
# Contract (see SKILL.md header): SKILL.md + playbook are spec/orchestration docs that
# reference the WLPayrollDriver API by name. Selector-level and endpoint-level code lives
# ONLY in wl-payroll-driver.user.js. This script fails when that contract is violated.
#
# Run manually:        ./scripts/check-docs-drift.sh
# Or as pre-commit:    ln -sf ../../scripts/check-docs-drift.sh .git/hooks/pre-commit
#
# Exit 0 = clean, 1 = drift found.

set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
docs=("$repo/SKILL.md" "$repo/wl-payroll-driver-playbook.md")
driver="$repo/wl-payroll-driver.user.js"
fail=0

err() { echo "DRIFT: $1"; fail=1; }

# 1. Forbidden implementation tokens in docs.
#    css-btn-filled-primary  — known-wrong selector (matched "View attendance list")
#    cells[N] indexing       — the off-by-one bug class; docs must use data-name names
#    querySelector / onclick.call / dispatchEvent — selector-level code belongs in the driver
for doc in "${docs[@]}"; do
  for pattern in 'css-btn-filled-primary' 'cells\[[0-9]' 'querySelector' 'onclick\.call' 'dispatchEvent'; do
    if grep -nE "$pattern" "$doc" >/dev/null 2>&1; then
      err "$(basename "$doc") contains forbidden implementation token /$pattern/:"
      grep -nE "$pattern" "$doc" | head -3 | sed 's/^/    /'
    fi
  done
done

# 2. Both docs must acknowledge the AJAX save as the primary path (presence check —
#    if someone rewrites the fix flow and drops this, the contract is being violated).
for doc in "${docs[@]}"; do
  if ! grep -qE 'staffSubstituteSave|direct-ajax' "$doc"; then
    err "$(basename "$doc") no longer mentions the AJAX primary save path (staffSubstituteSave / direct-ajax)"
  fi
done

# 3. Version consistency inside the driver: @version must appear in all three spots.
ver=$(grep -m1 '@version' "$driver" | awk '{print $3}')
n=$(grep -cF "$ver" "$driver")
if [[ -z "$ver" || "$n" -lt 3 ]]; then
  err "driver @version '$ver' found $n time(s) — expected 3 (header, JSDoc, API.version)"
fi

# 4. Cascade parity (spec vs implementation): the 6 expected rate labels in SKILL.md's
#    cascade table must each appear in the driver's CASCADE array.
for label in 'Community Rate' 'Livestream (Hybrid) Rate' 'Aerial Rate' \
             '75-90 minute In-Person Class (500 ERYT)' '75 min In-Person Class' \
             '45-60 minute In-Person Class'; do
  grep -qF "$label" "$repo/SKILL.md" || err "SKILL.md cascade missing label: $label"
  grep -qF "$label" "$driver"        || err "driver CASCADE missing label: $label"
done

# 5. Driver syntax.
if command -v node >/dev/null 2>&1; then
  node --check "$driver" >/dev/null 2>&1 || err "node --check failed on wl-payroll-driver.user.js"
fi

if [[ $fail -eq 0 ]]; then
  echo "OK: docs/driver in sync (driver $ver)"
fi
exit $fail
