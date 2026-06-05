/**
 * Step 7 — Review
 *
 * Takes a screenshot for human review. Does NOT submit.
 * Call submit() explicitly after review.
 */
import { wait } from '../browser.js';
import path     from 'path';

export async function reviewStep7(page, screenshotPath) {
  console.log('\n── Step 7: Review ──');

  const outPath = screenshotPath ?? `/tmp/workday_review_${Date.now()}.png`;
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`  Screenshot saved → ${outPath}`);
  console.log('  ⚠️  Review the screenshot before submitting.');
  console.log('  Call submit() to proceed, or fix fields manually and rerun.');
}

/** Submit the application. Only call after manual review. */
export async function submitApplication(page) {
  console.log('\n── Submitting ──');
  await page.evaluate(() =>
    document.querySelector('[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]')?.click()
  );
  await wait(3000);
  console.log('  Submission click sent. Check browser for confirmation.');
}
