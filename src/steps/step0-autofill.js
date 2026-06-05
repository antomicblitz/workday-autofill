/**
 * Step 0 — Autofill with Resume  (applyFlowAutoFillPage)
 *
 * This optional first step (only present on /autofillWithResume URLs) uploads
 * the CV and lets Workday parse it to pre-fill My Information and My Experience.
 * This is the preferred entry point — it auto-populates school, dates, and job
 * titles, reducing the manual fill needed in step 2.
 */
import { wait, nextStep } from '../browser.js';

export async function fillStep0(page, profile) {
  console.log('\n── Step 0: Autofill with Resume ──');

  const uploadEl = await page.$('input[data-automation-id="file-upload-input-ref"]');
  if (!uploadEl) {
    console.warn('  No upload input found — skipping autofill step');
    await nextStep(page, 4000);
    return;
  }

  console.log('  Uploading CV for autofill…');
  await uploadEl.uploadFile(profile.resumePath);
  await wait(3000);

  // Confirm upload succeeded
  const uploaded = await page.evaluate(() =>
    document.querySelector('[data-automation-id="file-upload-item"]')?.textContent?.trim()
  );
  console.log(`  Uploaded: ${uploaded ?? 'unknown'}`);

  console.log('  → Continue');
  await nextStep(page, 5000); // longer wait — Workday parses the CV
}
