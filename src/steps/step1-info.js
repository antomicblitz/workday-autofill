/**
 * Step 1 — My Information
 *
 * Generalized: reads required fields dynamically, fills what's missing,
 * leaves pre-filled account data alone.
 *
 * Required fields on Novartis:
 *   - source--source         "How Did You Hear About Us?" (typeahead)
 *   - candidateIsPreviousWorker  Yes/No radio
 *   - phoneNumber--countryPhoneCode  country code typeahead
 *   - Name, address, phone   (usually pre-filled from Workday account)
 */
import { reactFill, selectDropdown, setCheckboxByLabel } from '../react.js';
import { wait, nextStep, attempt } from '../browser.js';

/**
 * Fill a Workday typeahead (including hierarchical menus like Social Media > LinkedIn).
 *
 * Strategy:
 * 1. Open the dropdown by clicking the input
 * 2. Look for the exact value in the current option list
 * 3. If not found, look for a parent category that contains the value, click it,
 *    then click the value in the resulting sub-menu
 * 4. If still not found, try typing a search term and pick the closest match
 */
async function fillTypeaheadById(page, inputId, desiredValues) {
  const values = Array.isArray(desiredValues) ? desiredValues : [desiredValues];

  for (const desired of values) {
    // Open the dropdown
    await page.evaluate(id => document.getElementById(id)?.scrollIntoView({ block: 'center' }), inputId);
    await page.click(`#${inputId}`).catch(() => {});
    await wait(1000);

    // Try to find and click the desired value directly
    const direct = await page.evaluate(target => {
      const lower  = target.toLowerCase();
      const opts   = [...document.querySelectorAll('[data-automation-id="promptOption"]')];
      const match  = opts.find(o => o.textContent.trim().toLowerCase() === lower)
                  ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
      if (match) { match.closest('[role="option"]')?.click() ?? match.click(); return match.textContent.trim(); }
      return null;
    }, desired);

    if (direct) {
      console.log(`  Typeahead #${inputId} "${desired}" → "${direct}" (direct)`);
      await wait(600);
      // Check if a sub-menu appeared (clicked a category, not the value itself)
      if (direct.toLowerCase() !== desired.toLowerCase()) {
        // We're in a sub-menu — look for the actual desired value
        const subPick = await page.evaluate(target => {
          const lower = target.toLowerCase();
          const opts  = [...document.querySelectorAll('[data-automation-id="promptOption"]')];
          const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
                     ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
          if (match) { match.closest('[role="option"]')?.click() ?? match.click(); return match.textContent.trim(); }
          return null;
        }, desired);
        if (subPick) {
          console.log(`  Sub-menu "${desired}" → "${subPick}"`);
          await wait(500);
          return subPick;
        }
      }
      // Verify something got selected
      const selected = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-automation-id="selectedItem"]')];
        return items.map(e => e.textContent.trim()).filter(Boolean);
      });
      if (selected.length) return selected[0];
      return direct;
    }

    // Not found directly — try typing to filter, then navigate hierarchically
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type(desired, { delay: 70 });
    await wait(1500);

    const filtered = await page.evaluate(target => {
      const lower = target.toLowerCase();
      const opts  = [...document.querySelectorAll('[data-automation-id="promptOption"]')];
      const match = opts.find(o => o.textContent.trim().toLowerCase() === lower)
                 ?? opts.find(o => o.textContent.trim().toLowerCase().includes(lower));
      if (match) { match.closest('[role="option"]')?.click() ?? match.click(); return match.textContent.trim(); }
      return null;
    }, desired);

    if (filtered) {
      console.log(`  Typeahead #${inputId} "${desired}" → "${filtered}" (filtered)`);
      await wait(500);
      return filtered;
    }

    console.warn(`  Typeahead #${inputId}: "${desired}" not found, trying next value…`);
    await page.keyboard.press('Escape');
    await wait(300);
  }
  return null;
}

export async function fillStep1(page, profile) {
  console.log('\n── Step 1: My Information ──');

  // ── "How Did You Hear About Us?" (source) ─────────────────────────────────
  const sourceEmpty = await page.evaluate(() => {
    const el = document.getElementById('source--source');
    if (!el) return false;
    const container = el.closest('[data-automation-id]')?.closest('[data-automation-id]');
    return !container?.querySelector('[data-automation-id="selectedItem"]');
  });
  if (sourceEmpty) {
    // Try multiple common source values until one matches
    const sourceCandidates = (profile.source ? [profile.source] : [])
      .concat(['LinkedIn', 'Job Board', 'Internet/Online', 'Company Website', 'Indeed', 'Other']);
    await attempt(
      () => fillTypeaheadById(page, 'source--source', sourceCandidates),
      'source'
    );
  } else {
    console.log('  Source already selected');
  }

  // ── "Have you ever been employed by a Novartis Company?" ──────────────────
  const prevWorkerNeeded = await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[name="candidateIsPreviousWorker"]')];
    return radios.length > 0 && radios.every(r => !r.checked);
  });
  if (prevWorkerNeeded) {
    // Click "No"
    const clicked = await page.evaluate(() => {
      const no = document.querySelector(
        'input[name="candidateIsPreviousWorker"][value="false"], ' +
        'input[name="candidateIsPreviousWorker"][value="0"]'
      );
      if (no) { no.click(); return `clicked No (id=${no.id})`; }
      // Fallback: find radio whose label says "No"
      const radios = [...document.querySelectorAll('input[name="candidateIsPreviousWorker"]')];
      for (const r of radios) {
        const lbl = document.querySelector('label[for="' + r.id + '"]')?.textContent?.trim();
        if (lbl?.toLowerCase() === 'no') { r.click(); return `clicked label No (id=${r.id})`; }
      }
      return 'NOT_FOUND';
    });
    console.log('  Previous worker radio:', clicked);
    await wait(200);
  }

  // ── Country Phone Code ─────────────────────────────────────────────────────
  const phoneCodeEmpty = await page.evaluate(() => {
    const el = document.getElementById('phoneNumber--countryPhoneCode');
    if (!el) return false;
    const container = el.closest('[data-automation-id]')?.closest('[data-automation-id]');
    return !container?.querySelector('[data-automation-id="selectedItem"]') && !el.value;
  });
  if (phoneCodeEmpty) {
    const country = profile.country ?? 'Switzerland';
    await attempt(
      () => fillTypeaheadById(page, 'phoneNumber--countryPhoneCode', [country, '+41', 'Swiss']),
      'countryPhoneCode'
    );
  }

  // ── Name (fill only if empty) ─────────────────────────────────────────────
  await attempt(async () => {
    const firstEmpty = await page.evaluate(() =>
      !document.querySelector(
        'input[data-automation-id="legalNameSection_firstName"], #name--legalName--firstName'
      )?.value
    );
    if (!firstEmpty) { console.log('  Name pre-filled, skipping'); return 'SKIP'; }
    await reactFill(page,
      'input[data-automation-id="legalNameSection_firstName"], #name--legalName--firstName',
      profile.firstName);
    await reactFill(page,
      'input[data-automation-id="legalNameSection_lastName"], #name--legalName--lastName',
      profile.lastName);
    return 'OK';
  }, 'name');

  // ── Address (fill only if empty) ──────────────────────────────────────────
  await attempt(async () => {
    const addrEmpty = await page.evaluate(() =>
      !document.querySelector(
        'input[data-automation-id="addressSection_addressLine1"], #address--addressLine1'
      )?.value
    );
    if (!addrEmpty) { console.log('  Address pre-filled, skipping'); return 'SKIP'; }
    await reactFill(page, 'input[data-automation-id="addressSection_addressLine1"], #address--addressLine1', profile.street);
    await reactFill(page, 'input[data-automation-id="addressSection_city"], #address--city',                 profile.city);
    await reactFill(page, 'input[data-automation-id="addressSection_postalCode"], #address--postalCode',     profile.postalCode);
    return 'OK';
  }, 'address');

  // ── Phone number (fill only if empty) ────────────────────────────────────
  await attempt(async () => {
    const phoneEmpty = await page.evaluate(() =>
      !document.querySelector(
        'input[data-automation-id="phone-number"], #phoneNumber--phoneNumber'
      )?.value
    );
    if (!phoneEmpty) { console.log('  Phone pre-filled, skipping'); return 'SKIP'; }
    await selectDropdown(page,
      'button[data-automation-id="phone-device-type"]:not([disabled]), button[id="phoneNumber--phoneType"]:not([disabled])',
      profile.phoneType ?? 'Mobile'
    );
    await reactFill(page,
      'input[data-automation-id="phone-number"], #phoneNumber--phoneNumber',
      profile.phoneNumber);
    return 'OK';
  }, 'phone');

  console.log('  → Next');
  await nextStep(page, 3000);

  // Diagnostic: report any remaining errors
  const { step: stepAfter } = await (await import('../browser.js')).currentStep(page);
  if (stepAfter === 1) {
    const errs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-automation-id="errorBanner"] li')]
        .map(e => e.textContent.trim()).filter(Boolean)
    );
    console.warn('  Still on step 1. Errors:', errs.length ? errs : '(check browser)');
  }
}
