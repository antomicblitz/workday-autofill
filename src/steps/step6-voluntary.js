/**
 * Step 6 — Voluntary Disclosures
 * SpeedyApply hS function selectors.
 * Novartis only shows the T&C checkbox; ethnicity/gender/veteran are absent.
 */
import { selectDropdown, jsClick } from '../react.js';
import { wait, nextStep } from '../browser.js';

export async function fillStep6(page, profile) {
  console.log('\n── Step 6: Voluntary Disclosures ──');

  // Gender (if present)
  if (profile.gender) {
    await selectDropdown(page, '[data-automation-id="gender"], [name="gender"]', profile.gender)
      .catch(() => {});
  }

  // Hispanic/Latino (if present)
  await selectDropdown(page, '[data-automation-id="hispanicOrLatino"], [name="hispanicOrLatino"]', 'No')
    .catch(() => {});

  // Veteran status (if present)
  await selectDropdown(page, '[data-automation-id="veteranStatus"], [name="veteranStatus"]', 'I am not a veteran')
    .catch(() => {});

  // Terms & Conditions checkbox — SpeedyApply: j('[data-automation-id="agreementCheckbox"]')
  //  and j('[name="acceptTermsAndAgreements"]')
  const checked = await page.evaluate(() => {
    const selectors = [
      '[data-automation-id="agreementCheckbox"]',
      '[name="acceptTermsAndAgreements"]',
      '#termsAndConditions--acceptTermsAndAgreements',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { if (!el.checked) el.click(); return el.checked ? `CHECKED: ${sel}` : `FAILED: ${sel}`; }
    }
    return 'NOT_FOUND';
  });
  console.log(`  T&C checkbox: ${checked}`);

  await wait(300);
  console.log('  → Next');
  await nextStep(page, 3000);
}
