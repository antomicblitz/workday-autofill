/**
 * tools.js — Primitive Workday interaction tools.
 *
 * These are the building blocks for LLM-orchestrated form filling.
 * An orchestrator (LLM or deterministic script) calls these functions
 * to inspect the form and make targeted mutations.
 *
 * Every tool returns a plain JSON-serialisable result so the orchestrator
 * can reason about what happened.
 */

import { writeFileSync } from 'fs';

// ─── Helpers ────────────────────────────────────────────────────────────────

const wait = ms => new Promise(r => setTimeout(r, ms));

/** React-native value setter — the only reliable way to update controlled inputs. */
function reactSet(el, value) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
            ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  el.dispatchEvent(new InputEvent('input',  { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('blur',  { bubbles: true }));
}

// ─── 1. INSPECT ─────────────────────────────────────────────────────────────

/**
 * Returns a complete snapshot of the current form page.
 * Shape:
 *   { step, stepName, fields[], addButtons[], uploadAreas[], errors[] }
 *
 * field types: text | textarea | date | checkbox | radio | listbox | typeahead | file
 */
export async function inspectPage(page) {
  return page.evaluate(() => {
    const stepEl = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    const stepText = stepEl?.textContent?.trim() ?? '';
    const stepMatch = stepText.match(/step (\d+) of \d+\s*(.*)/i);
    const step     = stepMatch ? parseInt(stepMatch[1]) : null;
    const stepName = stepMatch ? stepMatch[2].trim() : document.querySelector('h2')?.textContent?.trim() ?? '';

    const fields = [];

    // ── Form fields — visible only (previous steps stay in DOM but hidden) ──
    // Use getBoundingClientRect: hidden elements have zero dimensions.
    // offsetParent is unreliable for position:fixed/absolute containers.
    const ffs = [...document.querySelectorAll('[data-automation-id^="formField-"]')]
      .filter(ff => {
        const r = ff.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    for (const ff of ffs) {
      const ffAid   = ff.getAttribute('data-automation-id');
      const label   = ff.querySelector('[data-automation-id="richText"]')?.innerText?.trim()
                   ?? ff.querySelector('label')?.textContent?.trim()
                   ?? ffAid;

      // Section context: Workday encodes the panel in the INPUT id as
      // "{section}-{N}--{fieldName}". There is NO wrapping container element.
      // Extract it from the first input/button/textarea inside this formField.
      const anyInput = ff.querySelector('input,textarea,button[id]');
      const idMatch  = anyInput?.id?.match(/^([a-z][a-zA-Z]+-\d+)--/);
      const panelId  = idMatch ? idMatch[1] : null;

      // Listbox (aria-haspopup=listbox button inside field)
      const lbBtn = ff.querySelector('button[aria-haspopup="listbox"]');
      if (lbBtn) {
        fields.push({
          type: 'listbox',
          id: lbBtn.id,
          aid: ffAid,
          label,
          panelId,
          value: lbBtn.textContent.trim(),
        });
        continue;
      }

      // Button-group (multiple id*="questionnaire" buttons or radio-like buttons)
      const qBtns = [...ff.querySelectorAll('button[id*="questionnaire"], button[id*="Questionnaire"]')];
      if (qBtns.length) {
        fields.push({
          type: 'button-group',
          aid: ffAid,
          label,
          panelId,
          options: qBtns.map(b => ({ id: b.id, label: b.textContent.trim(), selected: b.getAttribute('aria-pressed') === 'true' || b.classList.contains('selected') })),
        });
        continue;
      }

      // Checkbox group — ARIA role="checkbox" or real <input type="checkbox">
      const ariaCbs = [...ff.querySelectorAll('[role="checkbox"]')];
      const inputCbs = [...ff.querySelectorAll('input[type="checkbox"]')];
      const allCbs = ariaCbs.length ? ariaCbs : inputCbs;
      if (allCbs.length) {
        fields.push({
          type: 'checkbox-group',
          aid: ffAid,
          label,
          panelId,
          options: allCbs.map(c => {
            // For real checkboxes the visible label is in an adjacent element
            const labelEl = c.id
              ? document.querySelector(`label[for="${c.id}"]`)
              : null;
            const ariaLabel = c.getAttribute('aria-label')
                           ?? labelEl?.textContent?.trim()
                           ?? c.getAttribute('name')
                           ?? c.id;
            return {
              id: c.id,
              ariaLabel,
              checked: c.type === 'checkbox' ? c.checked : c.getAttribute('aria-checked') === 'true',
            };
          }),
        });
        continue;
      }

      // Typeahead multiselect (multiselectInputContainer with searchBox input)
      const searchBox = ff.querySelector('[data-automation-id="searchBox"]');
      if (searchBox) {
        const selected = [...ff.querySelectorAll('[data-automation-id="selectedItem"]')].map(e => e.textContent.trim());
        fields.push({
          type: 'typeahead',
          id: searchBox.id,
          aid: ffAid,
          label,
          panelId,
          value: searchBox.value,
          selected,
        });
        continue;
      }

      // Date (spinbutton pair)
      const monthInput = ff.querySelector('[data-automation-id="dateSectionMonth-input"]');
      const dayInput   = ff.querySelector('[data-automation-id="dateSectionDay-input"]');
      const yearInput  = ff.querySelector('[data-automation-id="dateSectionYear-input"]');
      if (monthInput || dayInput || yearInput) {
        fields.push({
          type: 'date',
          monthId: monthInput?.id ?? null,
          dayId:   dayInput?.id   ?? null,
          yearId:  yearInput?.id  ?? null,
          aid: ffAid,
          label,
          panelId,
          value: { month: monthInput?.value ?? '', day: dayInput?.value ?? '', year: yearInput?.value ?? '' },
        });
        continue;
      }

      // Textarea
      const ta = ff.querySelector('textarea');
      if (ta) {
        fields.push({ type: 'textarea', id: ta.id, aid: ffAid, label, panelId, value: ta.value });
        continue;
      }

      // Plain text input
      const inp = ff.querySelector('input:not([type="checkbox"]):not([type="file"])');
      if (inp) {
        fields.push({ type: 'text', id: inp.id, aid: ffAid, label, panelId, value: inp.value });
        continue;
      }
    }

    // ── Add buttons ──────────────────────────────────────────────────────────
    const addButtons = [];
    const allBtns = [...document.querySelectorAll('button[data-automation-id="add-button"]')];
    for (const btn of allBtns) {
      const heading = (() => {
        // Walk up to find a heading or labelled section
        let el = btn.parentElement;
        for (let i = 0; i < 10 && el; i++) {
          const h = el.querySelector('h2,h3,h4,[data-automation-id="sectionTitle"],[data-automation-id="groupTitle"]');
          if (h) return h.textContent.trim();
          el = el.parentElement;
        }
        return btn.textContent.trim();
      })();
      addButtons.push({ label: btn.textContent.trim(), section: heading, disabled: btn.disabled });
    }

    // ── Upload areas ─────────────────────────────────────────────────────────
    const uploadAreas = [...document.querySelectorAll('[data-automation-id="file-upload-drop-zone"]')].map(z => {
      const items = [...z.closest('[data-automation-id^="attachments"]')?.querySelectorAll('[data-automation-id="file-upload-item-name"]') ?? []].map(n => n.textContent.trim());
      return { section: z.closest('[data-automation-id^="attachments"]')?.getAttribute('data-automation-id') ?? 'upload', files: items };
    });

    // ── Errors ───────────────────────────────────────────────────────────────
    const errors = [...document.querySelectorAll('[data-automation-id="errorHeading"],[data-automation-id="errorMessage"],[aria-invalid="true"]')]
      .map(e => e.textContent.trim()).filter(Boolean);

    return { step, stepName, fields, addButtons, uploadAreas, errors };
  });
}

// ─── 2. FILL TEXT / TEXTAREA ─────────────────────────────────────────────────

/**
 * Fill a plain text or textarea field by element ID.
 * Uses React native setter so controlled inputs update their state.
 */
export async function fillText(page, id, value) {
  // First try Puppeteer's CDP-based typing — real key events that React always picks up
  try {
    const handle = await page.$(`[id="${id}"]`);
    if (handle) {
      await handle.evaluate(el => {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        // Clear existing value via select-all + delete
        el.select?.();
      });
      await handle.click({ clickCount: 3 }); // triple-click to select all
      await page.keyboard.press('Backspace');
      if (value) await page.keyboard.type(value, { delay: 20 });
      await page.keyboard.press('Tab'); // blur to commit
      return { ok: true, id, value };
    }
  } catch (_) { /* fall through */ }

  // Fallback: React native setter
  const result = await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) return { ok: false, error: `Element #${id} not found` };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const setter = el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return { ok: true, id, value };
  }, { id, value });
  return result;
}

// ─── 3. FILL DATE ────────────────────────────────────────────────────────────

/**
 * Fill a Workday date spinbutton pair (month + year).
 * Pass month as 1-12 number string, year as 4-digit string.
 */
export async function fillDate(page, monthId, yearId, month, year, dayId, day) {
  const fill = (elId, val) => page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    // Spinbuttons need arrow-key simulation followed by direct value set
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSet?.call(el, value);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
    nativeSet?.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return true;
  }, { id: elId, value: val });

  const mOk = (monthId && month != null) ? await fill(monthId, String(month)) : true;
  await wait(80);
  const dOk = (dayId && day != null) ? await fill(dayId, String(day)) : true;
  await wait(80);
  const yOk = yearId  ? await fill(yearId,  String(year))  : true;
  return { ok: mOk && dOk && yOk, monthId, dayId, yearId, month, day, year };
}

// ─── 4. PICK FROM LISTBOX ────────────────────────────────────────────────────

/**
 * Click a button[aria-haspopup=listbox] to open it, then click the option
 * whose text matches `value` (exact first, then substring).
 */
export async function pickListbox(page, buttonId, value) {
  // Open the dropdown
  await page.evaluate(id => document.getElementById(id)?.click(), buttonId);
  await wait(600);

  const result = await page.evaluate(target => {
    const lower = target.toLowerCase();
    const opts  = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li')];
    const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
               ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
    if (match) {
      match.click();
      return { ok: true, picked: match.textContent.trim() };
    }
    return { ok: false, error: `"${target}" not found`, available: opts.map(o => o.textContent.trim()) };
  }, value);

  await wait(300);
  return result;
}

// ─── 5. TYPEAHEAD SEARCH + PICK ──────────────────────────────────────────────

/**
 * Type a search term into a Workday typeahead (multiselectInputContainer),
 * wait for results, then click the option matching `value`.
 *
 * Returns { ok, picked } or { ok: false, available, error }.
 *
 * For hierarchical menus (Social Media → LinkedIn): if the first pick
 * doesn't match `value`, a sub-menu round is attempted automatically.
 */
export async function typeaheadPick(page, inputId, searchTerm, value) {
  // Focus and type
  await page.evaluate(({ id, term }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSet?.call(el, term);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: term }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id: inputId, term: searchTerm });

  await wait(1500);

  const NO_RESULTS = ['no items', 'no matches', 'no results'];

  // First pick
  const first = await page.evaluate(({ target, noResult }) => {
    const lower = target.toLowerCase();
    const opts  = [...document.querySelectorAll('[data-automation-id="promptOption"]')]
      .filter(o => !noResult.some(p => o.textContent.trim().toLowerCase().includes(p)));
    const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
               ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower))
               ?? opts[0];
    if (!match) return { ok: false, available: [] };
    match.closest('[role="option"]')?.click() ?? match.click();
    return { ok: true, picked: match.textContent.trim() };
  }, { target: value, noResult: NO_RESULTS });

  if (!first.ok) return { ok: false, error: `No options for "${searchTerm}"`, available: first.available };

  await wait(500);

  // If a sub-menu opened (we clicked a category), look for the real value
  if (first.picked.toLowerCase() !== value.toLowerCase()) {
    const sub = await page.evaluate(({ target, noResult }) => {
      const lower = target.toLowerCase();
      const opts  = [...document.querySelectorAll('[data-automation-id="promptOption"]')]
        .filter(o => !noResult.some(p => o.textContent.trim().toLowerCase().includes(p)));
      const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
                 ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
      if (match) { match.closest('[role="option"]')?.click() ?? match.click(); return { ok: true, picked: match.textContent.trim() }; }
      return { ok: false };
    }, { target: value, noResult: NO_RESULTS });
    if (sub.ok) { await wait(400); return sub; }
  }

  return first;
}

// ─── 6. CLICK ELEMENT BY ID ──────────────────────────────────────────────────

/** Click any element by its HTML id. Use for buttons, checkboxes, radios.
 *  For checkboxes, also fires a change event so React controlled inputs update. */
export async function clickById(page, id) {
  // Use Puppeteer's CDP click for real checkbox inputs — it properly dispatches
  // mousedown/mouseup/click/change in sequence, which React picks up.
  try {
    // Use attribute selector to avoid ID escaping issues with UUID-like IDs
    const handle = await page.$(`[id="${id}"]`);
    if (handle) {
      await handle.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await handle.click();
      return { ok: true, id };
    }
  } catch (_) { /* fall through to evaluate */ }

  return page.evaluate(id => {
    const el = document.getElementById(id);
    if (!el) return { ok: false, error: `#${id} not found` };
    el.scrollIntoView({ block: 'center' });
    el.click();
    if (el.type === 'checkbox') {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, id, text: el.textContent.trim() };
  }, id);
}

// ─── 7. CLICK ELEMENT BY SELECTOR ────────────────────────────────────────────

/** Click any element by CSS selector. */
export async function clickSelector(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: `"${sel}" not found` };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, selector: sel, text: el.textContent.trim().slice(0, 60) };
  }, selector);
}

// ─── 8. UPLOAD FILES ─────────────────────────────────────────────────────────

/**
 * Upload one or more files to the first visible file-upload area on the page.
 * Optionally pass a section aid to scope the upload.
 */
/**
 * Upload one or more files to the Workday file upload area.
 * Workday upload inputs are typically multiple=false, so each file
 * is uploaded sequentially using the hidden file input element.
 */
export async function uploadFiles(page, filePaths, sectionAid = null) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const selector = sectionAid
    ? `[data-automation-id="${sectionAid}"] input[data-automation-id="file-upload-input-ref"]`
    : 'input[data-automation-id="file-upload-input-ref"]';

  const uploaded = [];
  for (const filePath of paths) {
    const handle = await page.$(selector);
    if (!handle) return { ok: false, error: `File upload input not found (${selector})`, uploaded };
    await handle.uploadFile(filePath);
    await wait(2500); // wait for this file to be processed before uploading next
    uploaded.push(filePath.split('/').pop());
  }
  return { ok: true, files: uploaded };
}

// ─── 9b. TYPE AND COMMIT (multiselect free-text) ─────────────────────────────

/**
 * Type a value into a Workday multiselect / typeahead input and press Enter
 * to commit it as a custom (free-text) tag.
 *
 * Used for fields that live inside a `multiselectInputContainer` and accept
 * free-text entries: school names, certification names, etc.
 *
 * Returns { ok, selected: string[] } where `selected` is the list of
 * committed tags after the Enter press.
 */
export async function typeAndEnter(page, inputId, value) {
  await page.evaluate(id => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'center' });
  }, inputId);

  await page.focus(`#${inputId}`);
  await wait(150);

  // Clear existing text
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  await page.keyboard.type(value, { delay: 40 });
  await wait(800);
  await page.keyboard.press('Enter');
  await wait(400);

  const result = await page.evaluate(id => {
    const container = document.getElementById(id)
      ?.closest('[data-automation-id="multiSelectContainer"]');
    const selected = [...(container?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
      .map(e => e.textContent.trim());
    // Some fields store the value directly in the input (not as a selectedItem tag)
    const inputVal = document.getElementById(id)?.value ?? '';
    return { selected, inputVal };
  }, inputId);

  // ok if either: a selectedItem tag was added, OR the input itself holds the value
  const ok = result.selected.length > 0 || result.inputVal !== '';
  return { ok, selected: result.selected, inputVal: result.inputVal, inputId, value };
}

// ─── 9. CLICK ADD BUTTON ─────────────────────────────────────────────────────

/**
 * Click the "Add" button for a named section (e.g. "Work Experience", "Education").
 *
 * Workday does NOT put section titles in <h2>/<h3> inside the section container.
 * Instead, the section name appears as the FIRST text of an ancestor div.
 * Strategy: walk up from each add-button up to 10 levels; if any ancestor's
 * trimmed textContent STARTS WITH the target section name → that's our section.
 */
export async function clickAdd(page, sectionName) {
  // Count existing indexed inputs before the click
  const countBefore = await page.evaluate(prefix => {
    const re = new RegExp(`^${prefix}-\\d+--`);
    return [...document.querySelectorAll('input[id],textarea[id],button[id]')]
      .filter(e => re.test(e.id)).length;
  }, sectionName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '').slice(0, 12));

  const result = await page.evaluate(target => {
    const lower = target.toLowerCase();
    const btns  = [...document.querySelectorAll('button[data-automation-id="add-button"]')];

    for (const btn of btns) {
      let el = btn.parentElement;
      for (let i = 0; i < 12 && el; i++) {
        const text = el.textContent.trim().toLowerCase();
        if (text.startsWith(lower)) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return { ok: true, section: el.textContent.trim().slice(0, 40), btnText: btn.textContent.trim() };
        }
        el = el.parentElement;
      }
    }

    // Fallback: aria-label
    const ariaBtn = btns.find(b => b.getAttribute('aria-label')?.toLowerCase().includes(lower));
    if (ariaBtn) { ariaBtn.click(); return { ok: true, section: target, btnText: ariaBtn.textContent.trim() }; }

    return { ok: false, error: `Add button for "${target}" not found`, available: btns.map(b => b.textContent.trim()) };
  }, sectionName);

  if (result.ok) {
    await wait(800);
  }
  return result;
}

// ─── 10. CLICK NEXT ──────────────────────────────────────────────────────────

/**
 * Click the Next / Save button and wait for the page to transition.
 * Returns { ok, newStep } or { ok: false, errors }.
 */
export async function clickNext(page) {
  await page.evaluate(() => {
    const btn = document.querySelector(
      '[data-automation-id="bottom-navigation-next-button"]:not([disabled]),' +
      '[data-automation-id="pageFooterNextButton"]:not([disabled])'
    );
    btn?.click();
  });
  await wait(2500);

  const state = await page.evaluate(() => {
    const stepEl = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    const errors = [...document.querySelectorAll('[data-automation-id="errorHeading"]')].map(e => e.textContent.trim());
    return { stepText: stepEl?.textContent?.trim() ?? '', errors };
  });

  const m = state.stepText.match(/step (\d+) of \d+/i);
  return { ok: state.errors.length === 0, newStep: m ? parseInt(m[1]) : null, errors: state.errors };
}

// ─── 11. GET ERRORS ──────────────────────────────────────────────────────────

/** Return the current list of validation error messages on the page. */
export async function getErrors(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-automation-id="errorHeading"],[data-automation-id="errorMessage"]')]
      .map(e => e.textContent.trim()).filter(Boolean)
  );
}

// ─── 12. SCREENSHOT ──────────────────────────────────────────────────────────

/** Save a PNG screenshot to path and return the path. */
export async function screenshot(page, path) {
  const outPath = path ?? `/tmp/workday_${Date.now()}.png`;
  await page.screenshot({ path: outPath, fullPage: true });
  return { ok: true, path: outPath };
}

// ─── 13. DISMISS MODALS ──────────────────────────────────────────────────────

/** Dismiss any visible modal/overlay by clicking its close button. */
export async function dismissModals(page) {
  return page.evaluate(() => {
    const closers = [...document.querySelectorAll('[data-automation-id="closeButton"], [aria-label="Close"]')];
    closers.forEach(b => b.click());
    return { dismissed: closers.length };
  });
}

// ─── 14. DELETE PANEL ────────────────────────────────────────────────────────

/**
 * Delete a form panel identified by its INPUT id prefix (e.g. "workExperience-41").
 *
 * Workday has no wrapping container with a data-automation-id for each panel.
 * Instead, the panel's fields share an ID prefix like "workExperience-41--*".
 * The Delete button lives as a sibling/cousin of those fields and can be
 * identified by walking up from one field until we find a Delete button.
 */
export async function deletePanel(page, panelPrefix) {
  const result = await page.evaluate(prefix => {
    // Find any input that belongs to this panel
    const anchor = document.querySelector(`input[id^="${prefix}--"], textarea[id^="${prefix}--"], button[id^="${prefix}--"]`);
    if (!anchor) return { ok: false, error: `No input found for panel "${prefix}"` };

    // Walk up until we find an ancestor that contains a Delete button
    // (The delete button may be in a sibling branch, not a direct descendant of
    //  the input's ancestors at shallow depth.)
    const isDeleteBtn = b =>
      b.getAttribute('data-automation-id') === 'delete-button' ||
      (b.getAttribute('aria-label') ?? '').toLowerCase().includes('delete') ||
      (b.getAttribute('aria-label') ?? '').toLowerCase().includes('remove') ||
      b.textContent.trim().toLowerCase() === 'delete' ||
      b.textContent.trim().toLowerCase() === 'remove';

    let el = anchor.parentElement;
    for (let i = 0; i < 20 && el; i++) {
      // Only search this level if its textContent already hints at a delete button
      // (avoids matching Delete buttons in unrelated sections higher up)
      if (el.textContent.trim().toLowerCase().includes('delete')) {
        const delBtn = [...el.querySelectorAll('button')].find(isDeleteBtn);
        if (delBtn) {
          delBtn.scrollIntoView({ block: 'center' });
          delBtn.click();
          return { ok: true, panel: prefix };
        }
      }
      el = el.parentElement;
    }
    return { ok: false, error: `No delete button found near "${prefix}"` };
  }, panelPrefix);

  if (result.ok) await wait(600);
  return result;
}
