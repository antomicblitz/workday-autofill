# workday-autofill

Fills Workday job applications from a JSON profile. Connects to an existing
browser session over Chrome DevTools Protocol — no headless Chrome, no
Chromium download, no extension required.

## How it works

1. Open Brave/Chrome with `--remote-debugging-port=9222`
2. Navigate to the Workday application page and sign in
3. Run the script — it fills every step and stops at Review
4. Inspect the review screenshot, then submit manually (or pass `--submit`)

## Architecture

```
src/
  tools.js          — 14 Workday interaction primitives (inspect, fill, upload, navigate)
  run-novartis.js   — Orchestrator for the Novartis AI Specialist application
profiles/
  antonio.json      — Ground-truth profile (names, address, WE, education, languages, Q&A)
```

### Primitives (`src/tools.js`)

| Tool | Purpose |
|---|---|
| `inspectPage` | Snapshot of all visible form fields, upload areas, add-buttons, errors |
| `fillText` | CDP keyboard typing into any text/textarea input (real key events — React always commits) |
| `fillDate` | Month + year spinbutton pair |
| `pickListbox` | Open a `[aria-haspopup="listbox"]` button dropdown and click a matching option |
| `typeaheadPick` | Type into a Workday multiselect typeahead and click the matching result |
| `typeAndEnter` | Type text + Enter to commit a free-text custom entry (e.g. school not in directory) |
| `clickById` | CDP click on any element by DOM id |
| `clickSelector` | CDP click on first matching CSS selector |
| `uploadFiles` | Sequential file upload (Workday inputs are `multiple=false`) |
| `clickAdd` | Click an "Add" button by label (Work Experience, Education, Language…) |
| `clickNext` | Click the footer Next button and return any validation errors |
| `getErrors` | Return all visible error messages |
| `screenshot` | Save a PNG of the current viewport |
| `dismissModals` | Close any open Workday overlay modals |
| `deletePanel` | Delete a repeating panel (work experience, education, language) |

### Why CDP typing instead of React setter?

`element.value = x` is silently overwritten by React. The reliable fix is real
keyboard events via Puppeteer's CDP layer:

```js
await element.click({ clickCount: 3 }); // select all
await page.keyboard.press('Backspace');
await page.keyboard.type(value, { delay: 20 });
await page.keyboard.press('Tab'); // blur to commit
```

React always processes `keydown`/`keypress`/`keyup`/`input`/`change` from CDP
key events, even for tightly-controlled inputs like address and phone fields.

## Setup

```bash
# Requires Node ≥ 18
npm install

# Start Brave with debug port (run once per session)
brave-browser --remote-debugging-port=9222 &
```

## Usage

```bash
# Full run from the autofill-with-resume step
node src/run-novartis.js

# Resume from a specific step (0-indexed)
node src/run-novartis.js --from-step=3

# Fill everything and submit (5-second abort window)
node src/run-novartis.js --submit
```

## Profile format (`profiles/antonio.json`)

```json
{
  "firstName":          "Legal first name(s)",
  "lastName":           "Legal last name",
  "preferredFirstName": "Preferred / display first name",
  "preferredLastName":  "Preferred / display last name",
  "street":             "Claragraben 101",
  "city":               "Basel",
  "postalCode":         "4057",
  "countryRegion":      "Basel-City",
  "phoneNumber":        "0767347766",
  "resumePath":         "/absolute/path/to/cv.docx",
  "coverLetterPath":    "/absolute/path/to/cover-letter.docx",
  "workExperiences":    [ { "jobTitle": "...", "company": "...", "current": false, ... } ],
  "education":          [ { "school": "...", "degree": "Master", "endYear": "2021" } ],
  "languages":          [ { "language": "English", "proficiency": "Fluent" } ],
  "applicationQuestions": {
    "social media or professional network": "LinkedIn",
    "inspired you to apply":               "Other",
    "indicate your gender":                "I prefer not to identify",
    "employed by or contracted":           "No",
    "confirm your nationality":            "EU/EFTA",
    "degree will you have completed":      "Master",
    "long before the start date":          "more than 4 years"
  }
}
```

## Step map (Novartis Workday — without autofill)

| Step | Page name                   | Handler in run-novartis.js |
|------|-----------------------------|----------------------------|
| 0    | Autofill with Resume        | `handleStep0`              |
| 1    | My Information              | `handleStep1`              |
| 2    | My Experience               | `handleStep2`              |
| 3    | Application Questions 1 of 3| `handleQuestions`          |
| 4    | Application Questions 2 of 3| `handleQuestions`          |
| 5    | Application Questions 3 of 3| `handleQuestions`          |
| 6    | Voluntary Disclosures       | `handleStep6`              |
| 7    | Review                      | `handleStep7`              |

## Known Workday quirks

| Quirk | Fix |
|---|---|
| React ignores `element.value =` | Use CDP `page.keyboard.type()` with Tab-blur |
| File input is `multiple=false` | Upload files sequentially with 2.5 s gap |
| `offsetParent` visibility check breaks in fixed containers | Use `getBoundingClientRect().width > 0 && height > 0` |
| Question fields render slowly after page transition | Retry `inspectPage` up to 8 s until `fields.length > 0` |
| Legal/preferred name sections share the same label text | Address by confirmed stable input IDs (`name--legalName--firstName` etc.) |
| Canton listbox uses English name | `"Basel-City"` = Basel-Stadt; `"Basel-Country"` = Basel-Landschaft |
| Checkbox idempotency | Check `opt.checked` before clicking — a second click unchecks |
| Step numbers shift when autofill is present | Use step-name fragment matching, never step numbers |
</content>
</invoke>