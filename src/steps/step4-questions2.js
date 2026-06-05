/**
 * Steps 4 & 5 — Secondary / Supplementary Questionnaires
 *
 * Generalized: clicks every questionnaire button whose text matches a value
 * in profile.applicationQuestions (same label-matching as step 3).
 * Handles both applyFlowSecondaryQuestionsPage and applyFlowSupplementaryQuestionsPage.
 */
import { wait, nextStep, attempt } from '../browser.js';

async function fillQuestionnairePage(page, profile, stepLabel) {
  console.log(`\n── ${stepLabel} ──`);

  const aq = profile.applicationQuestions ?? {};

  // Get all questionnaire buttons with their question context
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll(
      'button[id*="questionnaire"], button[id*="Questionnaire"]'
    )].map(btn => {
      // Find the question text in the surrounding form field
      const ff  = btn.closest('[data-automation-id^="formField-"]');
      const qt  = ff?.querySelector('[data-automation-id="richText"]')?.innerText?.trim()
               ?? ff?.querySelector('label')?.textContent?.trim()
               ?? '';
      return { id: btn.id, label: btn.textContent.trim(), question: qt };
    });
  });

  if (!buttons.length) {
    console.log('  No questionnaire buttons found — skipping');
  }

  // Group by question text (each group = one question's options)
  const groups = {};
  for (const b of buttons) {
    const key = b.question || '_unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  }

  for (const [question, opts] of Object.entries(groups)) {
    // Find desired answer from profile
    let answer = null;
    const lower = question.toLowerCase();
    for (const [key, val] of Object.entries(aq)) {
      if (lower.includes(key.toLowerCase())) { answer = val; break; }
    }
    // Fallback: try to match directly by option label
    if (!answer) {
      for (const opt of opts) {
        for (const [key, val] of Object.entries(aq)) {
          if (opt.label.toLowerCase() === val.toLowerCase() || opt.label.toLowerCase().includes(val.toLowerCase())) {
            answer = val; break;
          }
        }
        if (answer) break;
      }
    }

    if (!answer) {
      console.log(`  [no answer] "${question.slice(0,50)}" opts=[${opts.map(o=>o.label).join('|')}]`);
      continue;
    }

    // Detect if this is a listbox SELECT (one button, label = "Select One" or current value)
    // vs a button-group (multiple option buttons)
    const isListbox = opts.length === 1 && await page.evaluate(id => {
      const el = document.getElementById(id);
      return el?.getAttribute('aria-haspopup') === 'listbox';
    }, opts[0].id);

    if (isListbox) {
      // Open the listbox, then pick the matching option
      await page.evaluate(id => { document.getElementById(id)?.click(); }, opts[0].id);
      await wait(600);
      const picked = await page.evaluate(target => {
        const lower = target.toLowerCase();
        const items = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li')];
        const match = items.find(o => o.textContent.trim().toLowerCase() === lower)
                   ?? items.find(o => o.textContent.trim().toLowerCase().includes(lower));
        if (match) { match.click(); return match.textContent.trim(); }
        return `NOT_FOUND in [${items.map(o=>o.textContent.trim()).join('|')}]`;
      }, answer);
      console.log(`  "${question.slice(0,40)}" → "${picked}" (listbox)`);
      await wait(300);
    } else {
      const match = opts.find(o => o.label.toLowerCase() === answer.toLowerCase())
                 ?? opts.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
      if (match) {
        await attempt(() => page.evaluate(id => {
          const el = document.getElementById(id);
          el?.scrollIntoView({ block: 'center' });
          el?.click();
          return el ? `clicked: ${el.textContent.trim()}` : 'NOT_FOUND';
        }, match.id), `"${question.slice(0,40)}" → "${match.label}"`);
        console.log(`  "${question.slice(0,40)}" → "${match.label}"`);
        await wait(200);
      } else {
        console.warn(`  No match for "${answer}" in [${opts.map(o=>o.label).join('|')}]`);
      }
    }
  }

  console.log('  → Next');
  await nextStep(page, 3000);
}

export async function fillStep4(page, profile) {
  return fillQuestionnairePage(page, profile, 'Step 4: Application Questions 2 of 3');
}

export async function fillStep5(page, profile) {
  return fillQuestionnairePage(page, profile, 'Step 5: Application Questions 3 of 3');
}
