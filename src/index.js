/**
 * workday-autofill — main entry point
 *
 * Usage:
 *   node src/index.js [profile] [--from-step=N] [--submit]
 *
 * Requires Brave/Chrome with:  --remote-debugging-port=9222
 */
import { readFileSync }   from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }  from 'url';

import { connectToWorkday, dismissLegalNotice, currentStep, waitForStep, wait } from './browser.js';
import { fillStep0 }  from './steps/step0-autofill.js';
import { fillStep1 }  from './steps/step1-info.js';
import { fillStep2 }  from './steps/step2-experience.js';
import { fillStep3 }  from './steps/step3-questions1.js';
import { fillStep4 }  from './steps/step4-questions2.js';
import { fillStep5 }  from './steps/step5-questions3.js';
import { fillStep6 }  from './steps/step6-voluntary.js';
import { reviewStep7, submitApplication } from './steps/step7-review.js';

const __dir = dirname(fileURLToPath(import.meta.url));

const args        = process.argv.slice(2);
const profileArg  = args.find(a => !a.startsWith('--')) ?? 'antonio';
const fromStepRaw = args.find(a => a.startsWith('--from-step='))?.split('=')[1];
const fromStepArg = fromStepRaw !== undefined ? parseInt(fromStepRaw, 10) : null; // null = auto-detect
const doSubmit    = args.includes('--submit');

const profilePath = profileArg.endsWith('.json')
  ? profileArg
  : resolve(__dir, `../profiles/${profileArg}.json`);
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

console.log(`Profile:    ${profilePath}`);

(async () => {
  const { browser, page } = await connectToWorkday();
  await dismissLegalNotice(page);

  const { aid, step: detectedStep } = await currentStep(page);
  // fromStepArg=null → use detected step; explicit --from-step=N overrides
  const startStep = fromStepArg !== null ? fromStepArg : (detectedStep ?? 0);
  console.log(`Current:    step ${detectedStep} (${aid})`);
  console.log(`Running from step ${startStep}\n`);

  // Step runner with page-transition validation
  async function run(stepNum, label, fillFn) {
    if (startStep > stepNum) { console.log(`  [skip] Step ${stepNum}: ${label}`); return; }
    const { step } = await currentStep(page);
    if (step !== stepNum) {
      console.log(`  Waiting for step ${stepNum} (${label})…`);
      await waitForStep(page, stepNum).catch(() => {
        throw new Error(`Expected step ${stepNum} but got step ${step}`);
      });
    }
    await fillFn();
    console.log(`  ✓ Step ${stepNum} complete`);
  }

  await run(0, 'Autofill with Resume',         () => fillStep0(page, profile));
  await run(1, 'My Information',              () => fillStep1(page, profile));
  await run(2, 'My Experience',               () => fillStep2(page, profile));
  await run(3, 'Application Questions 1 of 3',() => fillStep3(page, profile));
  await run(4, 'Application Questions 2 of 3',() => fillStep4(page, profile));
  await run(5, 'Application Questions 3 of 3',() => fillStep5(page, profile));
  await run(6, 'Voluntary Disclosures',        () => fillStep6(page, profile));

  const reviewPath = `/tmp/workday_review_${Date.now()}.png`;
  await reviewStep7(page, reviewPath);
  console.log(`\nReview screenshot: ${reviewPath}`);

  if (doSubmit) {
    console.log('\n--submit flag detected. Submitting in 5s — Ctrl-C to abort.');
    await wait(5000);
    await submitApplication(page);
  }

  await browser.disconnect();
  console.log('Done.');
})().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
