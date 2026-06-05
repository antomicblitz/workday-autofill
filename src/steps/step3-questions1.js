/**
 * Step 3 — Application Questions 1 of 3  (primary questionnaire)
 *
 * Fully dynamic: reads every formField on the page, extracts its question text,
 * and looks up the answer in profile.applicationQuestions (substring key match).
 *
 * Supports:
 *   - Checkbox groups (multi-select) — uncheck all, then check desired value(s)
 *   - Button toggles (Workday radio-style single-select buttons)
 *   - Dropdown buttons (aria-controls listbox)
 *   - Text inputs / textareas
 */
import { selectDropdown, setCheckboxByLabel } from '../react.js';
import { wait, nextStep, attempt } from '../browser.js';

/**
 * Get all formField question blocks on the current page.
 * Returns [{aid, questionText, type, options}]
 */
async function getFormFields(page) {
  return page.evaluate(() => {
    const fields = [...document.querySelectorAll('[data-automation-id^="formField-"]')];
    return fields.map(ff => {
      const aid  = ff.getAttribute('data-automation-id');
      // Question text: prefer richText div, fall back to label
      const qt   = ff.querySelector('[data-automation-id="richText"]')?.innerText?.trim()
                ?? ff.querySelector('label')?.textContent?.trim()
                ?? '';
      // Detect type
      const checkboxes = [...ff.querySelectorAll('input[type="checkbox"]')];
      const radios     = [...ff.querySelectorAll('input[type="radio"]')];
      const buttons    = [...ff.querySelectorAll('button[name]')];
      const dropdown   = ff.querySelector('button[aria-controls], button[aria-haspopup="listbox"]');
      const textInput  = ff.querySelector('input[type="text"], textarea');

      let type    = 'unknown';
      let options = [];

      if (checkboxes.length > 0) {
        type    = 'checkbox-group';
        options = checkboxes.map(cb => {
          const lbl = document.querySelector(`label[for="${cb.id}"]`)?.textContent?.trim()
                   ?? cb.closest('li, [role="row"]')?.querySelector('label')?.textContent?.trim()
                   ?? '';
          return { label: lbl, checked: cb.checked, id: cb.id };
        });
      } else if (buttons.length > 0 && !dropdown) {
        type    = 'button-group';
        options = buttons.map(b => ({ label: b.textContent.trim(), id: b.id, selected: b.getAttribute('aria-pressed') === 'true' || b.classList.contains('selected') }));
      } else if (dropdown) {
        type    = 'dropdown';
        options = [{ label: dropdown.textContent.trim(), id: dropdown.id }];
      } else if (textInput) {
        type    = 'text';
        options = [{ label: textInput.placeholder || '', id: textInput.id, value: textInput.value }];
      }

      return { aid, questionText: qt, type, options };
    });
  });
}

/**
 * Match a question text to an answer from profile.applicationQuestions.
 * Keys in applicationQuestions are substring patterns (case-insensitive).
 * Returns the answer string, or null if no match found.
 */
function matchAnswer(questionText, applicationQuestions) {
  if (!applicationQuestions || !questionText) return null;
  const lower = questionText.toLowerCase();
  for (const [key, answer] of Object.entries(applicationQuestions)) {
    if (lower.includes(key.toLowerCase())) return answer;
  }
  return null;
}

export async function fillStep3(page, profile) {
  console.log('\n── Step 3: Application Questions 1 of 3 ──');

  const aq = profile.applicationQuestions ?? {};
  const fields = await getFormFields(page);
  console.log(`  Found ${fields.length} form field(s)`);

  for (const field of fields) {
    const answer = matchAnswer(field.questionText, aq);
    const preview = field.questionText.slice(0, 50);

    if (!answer) {
      console.log(`  [no answer] "${preview}" (${field.type})`);
      continue;
    }

    console.log(`  "${preview}" → "${answer}" (${field.type})`);

    if (field.type === 'checkbox-group') {
      // Desired answers may be comma-separated for multi-select
      const desired = answer.split(',').map(s => s.trim().toLowerCase());

      // First uncheck everything that shouldn't be checked
      for (const opt of field.options) {
        const shouldBeChecked = desired.some(d => opt.label.toLowerCase().includes(d) || opt.label.toLowerCase() === d);
        if (opt.checked && !shouldBeChecked) {
          await attempt(() => page.evaluate(id => {
            const cb = document.getElementById(id);
            if (cb?.checked) cb.click();
            return cb ? 'unchecked' : 'NOT_FOUND';
          }, opt.id), `uncheck "${opt.label}"`);
          await wait(100);
        }
      }

      // Then check desired options
      for (const d of desired) {
        const opt = field.options.find(o => o.label.toLowerCase().includes(d) || o.label.toLowerCase() === d);
        if (!opt) {
          console.warn(`    Option "${d}" not found in [${field.options.map(o => o.label).join(', ')}]`);
          continue;
        }
        if (!opt.checked) {
          await attempt(() => page.evaluate(id => {
            const cb = document.getElementById(id);
            if (cb && !cb.checked) cb.click();
            return cb ? `checked` : 'NOT_FOUND';
          }, opt.id), `check "${opt.label}"`);
          await wait(100);
        }
      }

    } else if (field.type === 'button-group') {
      // Single-select button group (Workday radio-style)
      const lower = answer.toLowerCase();
      const btn   = field.options.find(o => o.label.toLowerCase() === lower)
                 ?? field.options.find(o => o.label.toLowerCase().includes(lower));
      if (btn) {
        await attempt(() => page.evaluate(id => {
          const el = document.getElementById(id);
          el?.scrollIntoView({ block: 'center' });
          el?.click();
          return el ? 'clicked' : 'NOT_FOUND';
        }, btn.id), `button "${btn.label}"`);
      } else {
        console.warn(`    Button "${answer}" not found in [${field.options.map(o => o.label).join(', ')}]`);
      }

    } else if (field.type === 'dropdown') {
      const btnId  = field.options[0]?.id;
      const btnSel = btnId ? `#${btnId}` : `[data-automation-id="${field.aid}"] button[aria-controls]`;
      await attempt(() => selectDropdown(page, btnSel, answer), `dropdown "${preview}"`);

    } else if (field.type === 'text') {
      const inputId = field.options[0]?.id;
      if (inputId) {
        await attempt(() => page.evaluate(({ id, val }) => {
          const el = document.getElementById(id);
          if (!el) return 'NOT_FOUND';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(el, val);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'OK';
        }, { id: inputId, val: answer }), `text "${preview}"`);
      }
    }
  }

  await wait(300);
  console.log('  → Next');
  await nextStep(page, 3000);
}
