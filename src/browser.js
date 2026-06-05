/**
 * Browser connection, page utilities, and resilience helpers.
 */
import puppeteer from 'puppeteer-core';

const CDP_URL = 'http://localhost:9222';

export const wait = ms => new Promise(r => setTimeout(r, ms));

// ── Connection ────────────────────────────────────────────────────────────────

export async function connectToWorkday() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages   = await browser.pages();
  const page    = pages.find(p => p.url().includes('workday')) ?? pages[pages.length - 1];
  page.setDefaultTimeout(20000);
  await page.bringToFront();
  console.log(`Connected → ${page.url()}`);
  return { browser, page };
}

export async function dismissLegalNotice(page) {
  const el = await page.$('[data-automation-id="legalNoticeAcceptButton"]');
  if (el) {
    await page.evaluate(() =>
      document.querySelector('[data-automation-id="legalNoticeAcceptButton"]')?.click()
    );
    await wait(800);
    console.log('Legal notice dismissed.');
  }
}

// ── Step detection ────────────────────────────────────────────────────────────

const PAGE_AIDS = {
  // New-style Workday (applyFlowAutoFillPage = step 0, precedes My Information)
  applyFlowAutoFillPage:               0,
  quickApplyPage:                      0,
  applyFlowMyInfoPage:                 1,
  applyFlowMyExpPage:                  2,
  applyFlowPrimaryQuestionsPage:       3,
  applyFlowSecondaryQuestionsPage:     4,
  applyFlowSupplementaryQuestionsPage: 5,
  applyFlowVoluntaryDisclosuresPage:   6,
  applyFlowReviewPage:                 7,
  reviewJobApplicationPage:            7,
  // Old-style Workday aliases
  contactInformationPage:              1,
  myExperiencePage:                    2,
  primaryQuestionnairePage:            3,
  secondaryQuestionnairePage:          4,
  voluntaryDisclosuresPage:            6,
};

export async function currentStep(page) {
  const aid = await page.evaluate(() =>
    [...document.querySelectorAll('[data-automation-id]')]
      .map(e => e.getAttribute('data-automation-id'))
      .find(id =>
        id && id !== 'applyFlowPage' && !id.includes('Button') &&
        (id.startsWith('applyFlow') || id.includes('Page') || id.includes('page'))
      ) ?? null
  );
  const step = aid ? (PAGE_AIDS[aid] ?? null) : null;
  return { aid, step };
}

export async function waitForStep(page, stepNum, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await dismissModals(page);
    const { aid, step } = await currentStep(page);
    if (step === stepNum) return { aid, step };
    await wait(400);
  }
  const { aid, step } = await currentStep(page);
  // Log errors present before throwing
  const errs = await getErrors(page).catch(() => []);
  if (errs.length) console.warn('  Errors on page:', errs);
  throw new Error(`Timeout waiting for step ${stepNum}; currently on step ${step} (${aid})`);
}

// ── Navigation ────────────────────────────────────────────────────────────────

export async function nextStep(page, msWait = 2500) {
  await page.evaluate(() =>
    document.querySelector(
      '[data-automation-id="pageFooterNextButton"], ' +
      '[data-automation-id="bottom-navigation-next-button"]'
    )?.click()
  );
  await wait(msWait);
}

// ── Resilience ────────────────────────────────────────────────────────────────

/**
 * Retry an async fn up to `attempts` times, waiting `delayMs` between tries.
 * Returns the result of the first successful attempt.
 * Logs each failure but only throws on the final attempt.
 */
export async function retry(fn, attempts = 3, delayMs = 800, label = 'operation') {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`  [retry ${i}/${attempts}] ${label}: ${err.message}`);
      if (i === attempts) throw err;
      await wait(delayMs);
    }
  }
}

/**
 * Try a fn; if it throws or returns a falsy/NOT_FOUND result, log a warning
 * and continue. Never throws.
 */
export async function attempt(fn, label = 'operation') {
  try {
    const r = await fn();
    if (typeof r === 'string' && (r.startsWith('NOT_FOUND') || r.startsWith('NO_'))) {
      console.warn(`  [skip] ${label}: ${r}`);
    }
    return r;
  } catch (err) {
    console.warn(`  [skip] ${label}: ${err.message}`);
    return null;
  }
}

/**
 * Dismiss any open "Discard Application?" or error modal before proceeding.
 */
export async function dismissModals(page) {
  await page.evaluate(() => {
    // "Continue" on Discard modal
    const cont = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Continue');
    if (cont) { cont.click(); return; }
    // Close error banner
    const err = document.querySelector('[data-automation-id="errorBanner"] button');
    if (err) err.click();
  });
}

/**
 * Collect all visible validation errors on the current page.
 */
export async function getErrors(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(
      '[data-automation-id="errorBanner"], ' +
      '[data-automation-id="inputError"], ' +
      'p[data-automation-id="errorMessage"]'
    )].map(e => e.textContent.trim()).filter(Boolean)
  );
}
