# WellnessLiving SDK — Pay Rate & Class Management Evaluation

**Date:** 2026-06-11  
**Context:** Assessing whether `wl-sdk` can replace or complement the front-end driver (`wl-payroll-driver.user.js`) for management tasks such as changing instructor pay rates, class descriptions, and special instructions.

---

## Bottom Line

The SDK is **predominantly read-only** for the tasks most relevant to class and pay-rate management. No write endpoints were found for instructor pay rates per class, class descriptions, or special instructions.

---

## Task-by-Task Assessment

| Task | SDK Support | Notes |
|---|---|---|
| Change instructor pay rate on a class | ❌ No write endpoint | `StaffListModel` returns `a_pay_rate[]` and `k_staff_pay` read-only |
| Change class description | ❌ Read-only | `html_description` in `ClassViewModel`, `ElementModel` — GET result only |
| Change special instructions | ❌ Read-only | `html_special` / `html_special_instruction` — GET result only |
| Cancel / restore a class session | ✅ Write | `Schedule/CancelModel` |
| Edit staff profile (bio, role, employment) | ✅ Write | `Staff/StaffElementModel` — clean POST |
| Class schedule wizard (edit/instructor/resource) | ⚠️ Partial | `Classes/Period/Modify/ModifyModel` — step workflow, `a_set` undocumented |
| Read class details | ✅ Read | `Classes/ClassView/ElementModel`, `Schedule/ClassView/ClassViewModel` |
| Read staff list with pay rate keys | ✅ Read | `Staff/StaffList/StaffListModel` |

---

## Key Files

### Class read endpoints (descriptions, special instructions)
- `WellnessLiving/Wl/Schedule/ClassView/ClassViewModel.php` — `html_description`, `html_special` in `$a_class` array
- `WellnessLiving/Wl/Classes/ClassView/ElementModel.php` — `html_description`, `html_special_instruction` in `$a_class_list`
- `WellnessLiving/Wl/Schedule/Page/PageElementModel.php` — `$html_description`, `$html_special`
- `WellnessLiving/Wl/Classes/ClassList/BookListModel.php` — `text_description`

### Staff / pay rate read endpoints
- `WellnessLiving/Wl/Staff/StaffList/StaffListModel.php` — `a_pay_rate[]`, `a_staff_service[].k_staff_pay`
- `WellnessLiving/Wl/Catalog/Payment/PaymentModel.php` — `k_staff_pay` (read context, not writable)

### Write endpoints found
- `WellnessLiving/Wl/Classes/Period/Modify/ModifyModel.php` — step-based wizard; `$a_set` is the only POST-writable field (structure undocumented)
- `WellnessLiving/Wl/Staff/StaffElementModel.php` — edit staff profile fields
- `WellnessLiving/Wl/Schedule/CancelModel.php` — cancel/restore sessions

---

## The ModifyModel Situation

`ModifyModel` is a step-based wizard supporting:

- **Actions:** EDIT (1), CANCEL (2), RESTORE (3)
- **Modes:** FULL (1), INSTRUCTOR (2), STAFF_PERIOD (3), RESOURCE_PERIOD (4)

Its only POST-writable field is `$a_set` — an opaque array passed to server-side step handlers. The field structure per step is **not documented** in the SDK PHP models. Using it for programmatic class edits would require intercepting live XHR traffic from the class-edit wizard and reverse-engineering the payloads — the same effort as the current front-end driver, just at the HTTP level.

---

## Recommendation

**Keep the front-end driver** (`wl-payroll-driver.user.js`) for pay rate and description changes. Those mutations are not exposed as clean SDK endpoints.

**Where the SDK adds value:**
- Pre/post audit reads — use `ClassViewModel` or `ElementModel` GET calls to verify current class state without DOM scraping
- Staff profile edits — `StaffElementModel` is a clean, documented write endpoint for bio, role, employment dates, and location assignment
- Session cancel/restore — `CancelModel` is straightforward

**Potential future work:**  
Reverse-engineering `ModifyModel`'s `a_set` step payloads via XHR interception could unlock programmatic class edits at the API level. The privilege constant `STAFF_PAY_RATE_EDIT` exists in `WlPrivilegeSid`, suggesting a write endpoint may exist in the full (non-public) API — worth checking WL's private/partner API docs if access is available.
