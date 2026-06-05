/**
 * React-aware DOM helpers.
 *
 * Workday forms are React-controlled: el.value = x is silently overwritten.
 * Fix (confirmed from SpeedyApply source):
 *   1. Focus element
 *   2. Fire dummy keydown/keypress/keyup  → wakes React event handlers
 *   3. Native value setter                → bypasses React tracking
 *   4. Fire input + change events         → commits to React state
 *   5. Blur
 *
 * All functions that interact with the DOM run inside page.evaluate() via CDP.
 */

// ── Core value setter ─────────────────────────────────────────────────────────

/**
 * Set a React-controlled text input or textarea.
 * selector may be a CSS selector string.
 */
export async function reactFill(page, selector, value) {
  if (!value && value !== 0) return `SKIP: empty value for ${selector}`;
  return page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) return `NOT_FOUND: ${sel}`;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const tag    = el.tagName.toLowerCase();
    const proto  = tag === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, val) : (el.value = val);
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.blur();
    return `OK: ${sel} → "${el.value}"`;
  }, { sel: selector, val: String(value) });
}

/** Set a React-controlled input by element ID (avoids CSS escaping issues). */
export async function reactFillById(page, id, value) {
  if (!value && value !== 0) return `SKIP: empty value for #${id}`;
  return page.evaluate(({ id, val }) => {
    const el = document.getElementById(id);
    if (!el) return `NOT_FOUND: #${id}`;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const tag    = el.tagName.toLowerCase();
    const proto  = tag === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, val) : (el.value = val);
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.blur();
    return `OK: #${id} → "${el.value}"`;
  }, { id, val: String(value) });
}

// ── Spinbutton date filler ────────────────────────────────────────────────────

/**
 * Fill a Workday date spinbutton (month or year) by element ID.
 * SpeedyApply technique: fire dummy key events first to trigger React handlers,
 * then use native setter + input/change + blur.
 */
export async function reactFillDateById(page, id, value) {
  if (!value) return `SKIP: empty date for #${id}`;
  return page.evaluate(({ id, val }) => {
    const el = document.getElementById(id);
    if (!el) return `NOT_FOUND: #${id}`;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    ['keydown', 'keypress', 'keyup'].forEach(t =>
      el.dispatchEvent(new KeyboardEvent(t, { key: '5', keyCode: 53, bubbles: true, cancelable: true }))
    );
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.blur();
    return `OK: #${id} → "${el.value}"`;
  }, { id, val: String(value) });
}

// ── Dropdown (aria-controls listbox) ─────────────────────────────────────────

/**
 * Open a Workday dropdown button and click the first option whose text
 * matches `optionText` (case-insensitive, substring).
 * SpeedyApply cS technique: click button → find listbox by aria-controls → click option.
 */
export async function selectDropdown(page, buttonSelector, optionText) {
  if (!optionText) return `SKIP: no optionText`;
  return page.evaluate(({ sel, text }) => {
    const btn = document.querySelector(sel);
    if (!btn) return `NOT_FOUND: ${sel}`;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return new Promise(resolve => {
      setTimeout(() => {
        const ariaId  = btn.getAttribute('aria-controls');
        const listbox = ariaId
          ? document.getElementById(ariaId)
          : document.querySelector(
              '[data-automation-widget="wd-popup"][data-automation-activepopup="true"] ul[role="listbox"], ' +
              'ul[role="listbox"]'
            );
        if (!listbox) {
          btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(`NO_LISTBOX for "${sel}"`);
          return;
        }
        const opts  = [...listbox.querySelectorAll('li[role="option"]')]
          .filter(o => o.id !== 'select-one');
        const lower = text.toLowerCase();
        const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
                   ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
        if (match) {
          match.click();
          resolve(`OK: "${match.textContent.trim()}"`);
        } else {
          btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(`NO_MATCH "${text}" in [${opts.map(o => o.textContent.trim()).join(' | ')}]`);
        }
      }, 500);
    });
  }, { sel: buttonSelector, text: optionText });
}

// ── Checkbox / radio by label text ───────────────────────────────────────────

/**
 * Find a checkbox or radio whose visible label text includes `labelText`
 * (case-insensitive), set its checked state to `checked`, and fire click
 * if needed. Scopes search to `containerSelector` if provided.
 */
export async function setCheckboxByLabel(page, labelText, checked = true, containerSelector = null) {
  return page.evaluate(({ text, checked, container }) => {
    const root  = container ? (document.querySelector(container) ?? document) : document;
    const lower = text.toLowerCase();

    // Find all label elements whose text matches
    const labels = [...root.querySelectorAll('label, [role="checkbox"], [role="radio"]')]
      .filter(el => el.textContent.trim().toLowerCase().includes(lower));

    for (const lbl of labels) {
      // Get associated input
      let input = null;
      if (lbl.htmlFor) {
        input = document.getElementById(lbl.htmlFor);
      } else {
        input = lbl.querySelector('input[type="checkbox"], input[type="radio"]')
               ?? lbl.previousElementSibling?.querySelector('input')
               ?? lbl.closest('[role="row"], [role="cell"], li')?.querySelector('input');
      }
      if (!input) continue;
      if (input.checked === checked) return `ALREADY: "${text}" = ${checked}`;
      input.click();
      return `OK: "${text}" → ${input.checked}`;
    }
    return `NOT_FOUND: label "${text}"`;
  }, { text: labelText, checked, container: containerSelector });
}

// ── Section Add button ────────────────────────────────────────────────────────

/**
 * Find the Add button for a named section (e.g. "Work Experience", "Education").
 * Works on portals that have no aria-label on Add buttons (e.g. Novartis).
 * Strategy: find a leaf element whose text exactly matches the section name,
 * walk up the DOM until we find a container with an add-button child, click it.
 */
export async function clickAddForSection(page, sectionName) {
  return page.evaluate((name) => {
    const lower = name.toLowerCase();
    // Leaf text match
    const heading = [...document.querySelectorAll('*')].find(el =>
      el.children.length === 0 &&
      el.textContent.trim().toLowerCase() === lower
    );
    if (heading) {
      let parent = heading.parentElement;
      for (let i = 0; i < 12 && parent; i++) {
        const btn = [...parent.querySelectorAll('[data-automation-id="add-button"]')]
          .find(b => !b.disabled);
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return `OK: "${name}" (depth ${i})`;
        }
        parent = parent.parentElement;
      }
    }
    // Fallback: aria-label XPath pattern (SpeedyApply)
    const ariaBtn = document.querySelector(
      `button[aria-label*="${name}" i]:not([disabled]), ` +
      `button[aria-label*="Add"][aria-label*="${name.split(' ')[0]}" i]:not([disabled])`
    );
    if (ariaBtn) { ariaBtn.scrollIntoView({ block: 'center' }); ariaBtn.click(); return `OK: aria-label "${name}"`; }
    return `NOT_FOUND: section "${name}"`;
  }, sectionName);
}

// ── Generic JS click ──────────────────────────────────────────────────────────

export async function jsClick(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return `NOT_FOUND: ${sel}`;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return `CLICKED: ${sel}`;
  }, selector);
}
