# Agent Learnings — workday-autofill

Patterns discovered while building and iterating the Workday autofill
orchestrator. Each entry describes the problem, root cause, and solution.

---

## 1. React ignores `element.value =` for address/phone fields

**Symptom:** `fillText` sets DOM `.value` visually but the form fails
validation ("field is required") after clicking Next.

**Root cause:** Workday's React forms use controlled inputs. React tracks
value in its own fiber state, not the DOM attribute. `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` plus
`dispatchEvent(new InputEvent('input'))` works for _most_ fields but not for
tightly-controlled ones (address line, postal code, phone).

**Fix:** Use Puppeteer CDP for real keyboard events:
```js
await element.click({ clickCount: 3 }); // select-all
await page.keyboard.press('Backspace');
await page.keyboard.type(value, { delay: 20 });
await page.keyboard.press('Tab'); // blur → React commit
```
React processes CDP `keydown`/`keyup`/`input`/`change` events unconditionally.

---

## 2. `offsetParent` visibility filter breaks in fixed/absolute containers

**Symptom:** Questionnaire fields (`inspectPage`) returned 0 visible fields
even though the page clearly showed questions.

**Root cause:** `offsetParent === null` for elements inside `position:fixed`
or `overflow:hidden` containers — which Workday uses for the questionnaire
page layout.

**Fix:** Use `getBoundingClientRect().width > 0 && height > 0`. This checks
actual rendered size regardless of stacking context.

---

## 3. Questionnaire fields lag the page transition

**Symptom:** `inspectPage` immediately after `clickNext` advances to the
questionnaire step returns `fields: []`, causing all answers to be skipped
silently and the form to stay on the same step.

**Root cause:** React defers rendering question fields by ~1–2 s after the
step label updates. `waitForStep` detects the step label change first, but the
fields aren't in the DOM yet when `handleQuestions` immediately calls
`inspectPage`.

**Fix:** Retry loop in `handleQuestions` — poll `inspectPage` up to 8 s
(1 s intervals) until `snap.fields.length > 0` before proceeding.

---

## 4. Checkbox idempotency — second click unchecks

**Symptom:** On a resumed application, `clickById` on already-checked
checkboxes (e.g. LinkedIn, Other) toggles them OFF, then Next fails validation.

**Root cause:** The script clicked every answer unconditionally. Workday
checkboxes toggle on each click.

**Fix:** Check `opt.checked` before clicking. Log `already:` and skip if
already in the desired state.

---

## 5. Legal and preferred name sections share the same label text

**Symptom:** `findField(snap.fields, 'first name')` returns null; legal name
stays as autofill's "ANTONIO LAMB" even though profile has "Viktor Antonio".

**Root cause:** Both sections use identical Workday labels:
`"Given Name(s)*"` and `"Family Name*"`. Label-based search is ambiguous and
returns null or the wrong section.

**Fix:** Address all name fields by their confirmed stable input IDs:
- Legal: `name--legalName--firstName` / `name--legalName--lastName`
- Preferred: `name--preferredName--firstName` / `name--preferredName--lastName`
- Preferred checkbox: `name--preferredCheck`

---

## 6. Canton listbox uses English names, not German canton names

**Symptom:** `pickListbox` with `"Basel-Stadt"` returns "not found".

**Root cause:** Workday Switzerland canton dropdown uses English display names.
`"Basel-Stadt"` (official German) is listed as `"Basel-City"`.
`"Basel-Landschaft"` is listed as `"Basel-Country"`.

**Fix:** Use `"Basel-City"` in the profile `countryRegion` field.

---

## 7. Step numbers shift when autofill step is present

**Symptom:** Hardcoded step number checks break when the autofill-with-resume
page is present (adds one step), causing the orchestrator to wait for the
wrong step.

**Fix:** Use step-name fragment matching exclusively (`waitForStep(page, null, 'my information')`). Never match by step number.

---

## 8. Degree-time listbox options

**Actual options** (Novartis Workday, verified June 2026):
- `0-2 years`
- `2-4 years`
- `more than 4 years`

Profile answer for MSc completed 2021, applying 2026 (5 years): `"more than 4 years"`.

---

## 9. File upload input is `multiple=false`

**Symptom:** Uploading CV + cover letter in one `uploadFiles([cv, cl])` call
only uploaded the first file.

**Root cause:** The Workday file input has `multiple=false`.

**Fix:** `uploadFiles` sends files sequentially with a 2.5 s gap between each.

---

## 10. Preferred name checkbox selector

**Symptom:** `[data-automation-id*="preferredName"] input[type="checkbox"]`
never matched; preferred name checkbox reported `NOT_FOUND`.

**Root cause:** The checkbox `data-automation-id` is `formField-preferredCheck`
(not `preferredName`). Its input ID is `name--preferredCheck`.

**Fix:** Use `document.getElementById('name--preferredCheck')` directly.
