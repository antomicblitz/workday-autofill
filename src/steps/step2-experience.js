/**
 * Step 2 — My Experience
 *
 * Generalized: uses dynamic panel ID detection, heading-proximity Add buttons,
 * and ID-based field filling. Works on any Workday portal.
 */
import { reactFill, reactFillById, reactFillDateById, selectDropdown, clickAddForSection } from '../react.js';
import { wait, nextStep, attempt, retry, getErrors } from '../browser.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for a new input[name=X] to appear (panel opened). */
async function waitForNewInput(page, name, expectedCount, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await page.evaluate(n =>
      document.querySelectorAll(`input[name="${n}"]`).length, name);
    if (count >= expectedCount) return true;
    await wait(300);
  }
  return false;
}

/** Delete all panels in a section except the first. */
async function deleteExtraPanels(page, schoolInputSelector = 'input[id*="--school"]') {
  const count = await page.evaluate(sel =>
    document.querySelectorAll(sel).length, schoolInputSelector);
  if (count <= 1) return count;

  // Collect delete buttons, find which belong to this section
  // We delete from last to first to avoid re-indexing
  await page.evaluate(sel => {
    const panels = [...document.querySelectorAll(sel)];
    // For each panel beyond the first, find and click its Delete button
    for (let i = panels.length - 1; i >= 1; i--) {
      let el = panels[i].parentElement;
      for (let j = 0; j < 10 && el; j++) {
        const del = [...el.querySelectorAll('button')]
          .find(b => b.textContent.trim() === 'Delete');
        if (del) { del.click(); break; }
        el = el.parentElement;
      }
    }
  }, schoolInputSelector);
  await wait(800);
  return count;
}

/** Get the base ID of the Nth work experience panel (0-indexed). */
async function getWorkPanelBase(page, index) {
  return page.evaluate(idx => {
    const inputs = document.querySelectorAll('input[name="jobTitle"]');
    return inputs[idx]?.id.replace('--jobTitle', '') ?? null;
  }, index);
}

/** Get the base ID of the first education panel. */
async function getEduPanelBase(page) {
  return page.evaluate(() => {
    const el = document.querySelector('input[id*="--school"]');
    return el?.id.replace('--school', '') ?? null;
  });
}

// ── Work Experience ───────────────────────────────────────────────────────────

async function fillWorkPanel(page, base, entry, index) {
  console.log(`  WE${index + 1} [${base}]: ${entry.jobTitle} @ ${entry.company}`);

  await attempt(() => reactFillById(page, `${base}--jobTitle`,    entry.jobTitle),   'jobTitle');
  await attempt(() => reactFillById(page, `${base}--companyName`, entry.company),    'company');
  await attempt(() => reactFillById(page, `${base}--location`,    entry.location),   'location');

  // Start date
  await attempt(() => reactFillDateById(page, `${base}--startDate-dateSectionYear-input`,  entry.startYear),  'startYear');
  await attempt(() => reactFillDateById(page, `${base}--startDate-dateSectionMonth-input`, entry.startMonth), 'startMonth');

  if (entry.current) {
    await page.evaluate(id => {
      const cb = document.getElementById(id);
      if (cb && !cb.checked) cb.click();
    }, `${base}--currentlyWorkHere`);
    await wait(200);
  } else {
    await attempt(() => reactFillDateById(page, `${base}--endDate-dateSectionYear-input`,  entry.endYear),  'endYear');
    await attempt(() => reactFillDateById(page, `${base}--endDate-dateSectionMonth-input`, entry.endMonth), 'endMonth');
  }

  // Description (textarea needs its own setter)
  if (entry.description) {
    await attempt(() => page.evaluate(({ id, val }) => {
      const el = document.getElementById(id);
      if (!el) return `NOT_FOUND: #${id}`;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(el, val) : (el.value = val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return `OK`;
    }, { id: `${base}--roleDescription`, val: entry.description }), 'description');
  }
}

// ── Education ─────────────────────────────────────────────────────────────────

// SpeedyApply degree keyword map — generalized
const DEGREE_MAP = {
  "Bachelor's": ['B.S', 'BS', 'Bachelors', 'Bachelor'],
  "Master's":   ['M.S', 'MS', 'Masters', 'Master', 'MSc'],
  'Master':     ['Masters', 'Master', 'MSc', 'M.S', 'MS'],
  'MBA':        ['MBA', 'Master'],
  'PhD':        ['PhD', 'Doctorate', 'Doctor'],
  'Other':      ['Other'],
};

async function fillEduPanel(page, base, edu) {
  console.log(`  EDU [${base}]: ${edu.school}`);

  const schoolId = `${base}--school`;

  // Check if school already selected (pill) — scope to school formField only
  const alreadySelected = await page.evaluate(id => {
    const input = document.getElementById(id);
    // Must find the formField-school or formField-schoolItem container specifically
    const container = input?.closest(
      '[data-automation-id="formField-school"], ' +
      '[data-automation-id="formField-schoolItem"]'
    );
    return !!container?.querySelector('[data-automation-id="selectedItem"]');
  }, schoolId);

  if (!alreadySelected) {
    // Use page.click() for real browser focus (evaluate focus doesn't work for keyboard.type)
    await page.evaluate(id => document.getElementById(id)?.scrollIntoView({ block: 'center' }), schoolId);
    await page.click(`#${schoolId}`).catch(() => {});
    await wait(200);

    // Try the profile school name first; fall back to "Others - {country}"
    const searchTerms = [edu.school, `Others - ${edu.country ?? 'Switzerland'}`];
    let picked = null;

    for (const term of searchTerms) {
      // Clear field
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await wait(100);

      await page.keyboard.type(term, { delay: 70 });
      await wait(2000);

      // Click first real option (exclude skills panel and "no results" messages)
      const NO_RESULT_PHRASES = ['no items', 'no matches', 'no results', '0 items'];
      picked = await page.evaluate(({ id, noResult }) => {
        const skillsPanel = document.querySelector('[data-automation-id="formField-skills"]');
        const schoolContainer = document.getElementById(id)?.closest(
          '[data-automation-id="formField-school"], [data-automation-id="formField-schoolItem"]'
        );
        const opts = [
          ...(schoolContainer?.querySelectorAll('[data-automation-id="promptOption"]') ?? []),
          ...[...document.querySelectorAll('[role="option"] [data-automation-id="promptOption"]')]
            .filter(el => !skillsPanel?.contains(el))
        ];
        const seen = new Set();
        const real = opts.filter(el => {
          const t = el.textContent.trim().toLowerCase();
          return t && !seen.has(t) && seen.add(t) &&
                 !noResult.some(p => t.includes(p));
        });
        if (!real.length) return null;
        real[0].closest('[role="option"]')?.click() ?? real[0].click();
        return real[0].textContent.trim();
      }, { id: schoolId, noResult: NO_RESULT_PHRASES });

      if (picked) {
        console.log(`    School "${term}" → "${picked}"`);
        break;
      }
      console.warn(`    No options for "${term}", trying next…`);
      await page.keyboard.press('Escape');
      await wait(300);
    } // end searchTerms loop

    if (!picked) {
      console.warn(`    All school searches failed — pressing ArrowDown+Enter on last term`);
      await page.keyboard.press('ArrowDown');
      await wait(150);
      await page.keyboard.press('Enter');
    }
    await wait(500);
  } else {
    console.log('    School already selected');
  }

  // Degree — try each keyword variant until one matches
  const degreeId  = `${base}--degree`;
  const keywords  = DEGREE_MAP[edu.degree] ?? [edu.degree];
  let degreeFilled = false;
  for (const kw of keywords) {
    const result = await page.evaluate(({ id, text }) => {
      const btn = document.getElementById(id);
      if (!btn) return `NOT_FOUND: #${id}`;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return new Promise(resolve => {
        setTimeout(() => {
          const ariaId  = btn.getAttribute('aria-controls');
          const listbox = ariaId
            ? document.getElementById(ariaId)
            : document.querySelector('ul[role="listbox"]');
          if (!listbox) { resolve('NO_LISTBOX'); return; }
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
            resolve(`NO_MATCH "${text}"`);
          }
        }, 500);
      });
    }, { id: degreeId, text: kw });
    console.log(`    Degree "${kw}" → ${result}`);
    if (result?.startsWith('OK')) { degreeFilled = true; break; }
    await wait(200);
  }
  if (!degreeFilled) console.warn(`    Could not set degree for "${edu.degree}"`);
  await wait(300);

  // Years (plain spinbutton — year only, no month)
  const startYrId = `${base}--firstYearAttended-dateSectionYear-input`;
  const endYrId   = `${base}--lastYearAttended-dateSectionYear-input`;
  await attempt(() => reactFillDateById(page, startYrId, edu.startYear), 'startYear');
  await attempt(() => reactFillDateById(page, endYrId,   edu.endYear),   'endYear');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function fillStep2(page, profile) {
  console.log('\n── Step 2: My Experience ──');

  // ── Clean up any stale data from previous runs ────────────────────────────
  // Delete extra education panels (keep at most one)
  const extraEdu = await deleteExtraPanels(page);
  if (extraEdu > 1) console.log(`  Cleaned ${extraEdu - 1} extra edu panel(s)`);

  // Delete all but the first CV upload
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-automation-id="delete-file"]')];
    btns.slice(1).forEach(b => b.click());
  });
  await wait(600);

  // ── CV upload (only if not already present from step 0 autofill) ──────────
  if (profile.resumePath) {
    const uploadCount = await page.evaluate(() =>
      document.querySelectorAll('[data-automation-id="file-upload-item"]').length
    );
    if (uploadCount === 0) {
      const uploadEl = await page.$('input[data-automation-id="file-upload-input-ref"]');
      if (uploadEl) {
        console.log('  Uploading CV…');
        await uploadEl.uploadFile(profile.resumePath);
        await wait(2500);
      }
    } else {
      console.log(`  CV already present (${uploadCount} file(s)), skipping upload`);
    }
  }

  // ── Work Experience ───────────────────────────────────────────────────────
  for (let i = 0; i < profile.workExperiences.length; i++) {
    const entry = profile.workExperiences[i];

    let base = await getWorkPanelBase(page, i);
    if (!base) {
      console.log(`  Adding WE panel ${i + 1}…`);
      const r = await attempt(() => clickAddForSection(page, 'Work Experience'), `add WE${i+1}`);
      console.log(`    Add result: ${r}`);
      const appeared = await waitForNewInput(page, 'jobTitle', i + 1);
      if (!appeared) { console.error(`  Panel ${i+1} never appeared`); continue; }
      base = await getWorkPanelBase(page, i);
    }
    if (!base) { console.error(`  Could not get base ID for WE${i+1}`); continue; }

    await retry(() => fillWorkPanel(page, base, entry, i), 2, 500, `fillWE${i+1}`);
  }

  // ── Education ─────────────────────────────────────────────────────────────
  if (profile.education) {
    let base = await getEduPanelBase(page);
    if (!base) {
      console.log('  Adding Education panel…');
      const r = await attempt(() => clickAddForSection(page, 'Education'), 'add Education');
      console.log(`    Add result: ${r}`);
      // Wait for school input to appear
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        base = await getEduPanelBase(page);
        if (base) break;
        await wait(400);
      }
    }
    if (base) {
      await retry(() => fillEduPanel(page, base, profile.education), 2, 500, 'fillEdu');
    } else {
      console.error('  Could not open education panel');
    }
  }

  // ── Website links ─────────────────────────────────────────────────────────
  if (profile.linkedIn) {
    await attempt(() => reactFill(page,
      "input[data-automation-id='linkedinQuestion'], input[name='linkedInAccount']",
      profile.linkedIn), 'linkedIn');
  }
  if (profile.github) {
    await attempt(() => reactFill(page,
      "input[data-automation-id='githubQuestion'], input[name='githubAccount']",
      profile.github), 'github');
  }

  // ── Validate before advancing ─────────────────────────────────────────────
  const errors = await getErrors(page);
  if (errors.length) console.warn('  Validation warnings:', errors);

  console.log('  → Next');
  await nextStep(page, 4000);
}
