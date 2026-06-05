/**
 * run-workday.js — Generic Workday application runner.
 *
 * Works on any Workday tenant. No employer-specific values are hardcoded —
 * everything comes from the profile JSON.
 *
 * Usage:
 *   node src/run-workday.js --url=<apply-url> [--profile=<path>] [--from-step=N] [--submit]
 *
 * If --url is omitted, profile.applicationUrl is used as fallback.
 * Profile supports "_extends": "<base-profile.json>" to inherit personal info
 * and override only job-specific fields.
 *
 * Extra profile fields (beyond run-novartis.js):
 *   applicationUrl   — Workday apply URL (with or without /autofillWithResume)
 *   phoneCountry     — search term for the country phone code typeahead
 *                      (default: profile.country ?? "Switzerland")
 *   previousEmployee — boolean; handled gracefully when field is absent (default: false)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from '/tmp/opencode/Workday-Application-Automator/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

import {
  inspectPage, fillText, fillDate, pickListbox, typeaheadPick,
  typeAndEnter, clickById, clickSelector, uploadFiles, clickAdd, clickNext,
  getErrors, screenshot, dismissModals, deletePanel,
} from './tools.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const urlArg      = args.find(a => a.startsWith('--url='))?.split('=').slice(1).join('=');
const profileArg  = args.find(a => a.startsWith('--profile='))?.split('=')[1]
                 ?? 'profiles/antonio.json';
const fromStepRaw = args.find(a => a.startsWith('--from-step='))?.split('=')[1];
const fromStep    = fromStepRaw !== undefined ? parseInt(fromStepRaw, 10) : 0;
const doSubmit    = args.includes('--submit');

// ─── Profile loading (with _extends inheritance) ──────────────────────────────

function loadProfile(relPath) {
  const abs  = resolve(__dir, '..', relPath);
  const data = JSON.parse(readFileSync(abs, 'utf8'));
  if (data._extends) {
    const base = loadProfile(resolve(dirname(relPath), data._extends));
    // Job profile overrides base; applicationQuestions merged (job wins per key)
    return {
      ...base,
      ...data,
      applicationQuestions: { ...base.applicationQuestions, ...data.applicationQuestions },
    };
  }
  return data;
}

const profile = loadProfile(profileArg);

const rawUrl = urlArg ?? profile.applicationUrl;
if (!rawUrl) {
  console.error('No URL: pass --url=<workday-apply-url> or set profile.applicationUrl');
  process.exit(1);
}

// Normalise: always use /autofillWithResume if not already present
const WORKDAY_URL = rawUrl.includes('/autofillWithResume')
  ? rawUrl
  : rawUrl.replace(/\/$/, '') + '/autofillWithResume';

const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findField(fields, labelSnippet) {
  const l = labelSnippet.toLowerCase();
  return fields.find(f => f.label?.toLowerCase().includes(l));
}

function panelFields(fields, panelAid) {
  return fields.filter(f => f.panelId === panelAid);
}

async function waitForStep(page, stepNum, nameHint = null, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snap = await inspectPage(page);
    if (stepNum !== null && snap.step === stepNum) return snap;
    if (nameHint && snap.stepName?.toLowerCase().includes(nameHint.toLowerCase())) return snap;
    await wait(600);
  }
  const snap = await inspectPage(page);
  throw new Error(
    `Timeout waiting for step ${stepNum}${nameHint ? ` (${nameHint})` : ''}; ` +
    `currently on step ${snap.step} (${snap.stepName})`
  );
}

function getPanels(fields, prefix) {
  return [...new Set(fields.map(f => f.panelId).filter(p => p?.startsWith(prefix + '-')))];
}

function newestPanel(panels) {
  return panels.sort((a, b) => parseInt(b.split('-').pop()) - parseInt(a.split('-').pop()))[0];
}

// ─── Step handlers ───────────────────────────────────────────────────────────

async function handleStep0(page) {
  console.log('\n── Step 0: Autofill with Resume ──');
  const snap = await inspectPage(page);
  const hasCV = snap.uploadAreas.some(u => u.files.length > 0);
  if (!hasCV) {
    console.log('  Uploading CV for autofill…');
    const r = await uploadFiles(page, [profile.resumePath]);
    console.log(' ', r.ok ? `Uploaded: ${r.files.join(', ')}` : r.error);
    await wait(2000);
  } else {
    console.log('  CV already present, skipping upload.');
  }
  const cont = await clickSelector(page,
    '[data-automation-id="pageFooterNextButton"]:not([disabled]),' +
    '[data-automation-id="bottom-navigation-next-button"]:not([disabled]),' +
    '[data-automation-id="autofillButton"]:not([disabled])'
  );
  if (cont.ok) {
    console.log('  Continue clicked — waiting for autofill to process…');
    await wait(5000);
  } else {
    console.warn('  Continue button not found:', cont.error);
  }
}

async function handleStep1(page) {
  console.log('\n── Step 1: My Information ──');
  const snap = await inspectPage(page);

  // ── Source ("How Did You Hear About Us?") ────────────────────────────────
  // Supports flat lists (source only) and two-level hierarchies (sourceCategory → source).
  if (profile.source) {
    const sourceResult = await page.evaluate(async ({ target, category }) => {
      const container = document.getElementById('source--source')
        ?.closest('[data-automation-id="multiSelectContainer"]');
      const selected = [...(container?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
        .map(e => e.textContent.trim());
      if (selected.some(s => s.toLowerCase().includes(target.toLowerCase())))
        return 'already: ' + target;

      const input = document.getElementById('source--source');
      if (!input) return 'source field NOT_FOUND';
      input.scrollIntoView({ block: 'center' });
      input.click();
      await new Promise(r => setTimeout(r, 700));

      const allOpts = () => [...document.querySelectorAll('[data-automation-id="promptOption"]')];

      // If a category is provided, click it first to open the sub-menu
      if (category) {
        const catOpt = allOpts().find(o => o.textContent.trim().toLowerCase().includes(category.toLowerCase()));
        if (catOpt) {
          catOpt.closest('[role="option"]')?.click() ?? catOpt.click();
          await new Promise(r => setTimeout(r, 700));
        }
      }

      // Now click the target (either in the flat list or the sub-menu)
      const targetOpt = allOpts().find(o => o.textContent.trim().toLowerCase().includes(target.toLowerCase()));
      if (targetOpt) {
        targetOpt.closest('[role="option"]')?.click() ?? targetOpt.click();
        return target;
      }
      return 'NOT_FOUND: ' + target;
    }, { target: profile.source, category: profile.sourceCategory ?? null });
    console.log('  Source:', sourceResult);
  }

  // ── Previous employee ────────────────────────────────────────────────────
  const prevWorkerTarget = profile.previousEmployee === true ? 'true' : 'false';
  const prevResult = await page.evaluate((target) => {
    const field = document.querySelector('[data-automation-id="formField-candidateIsPreviousWorker"]');
    if (!field) return 'field not present';
    const radios = [...field.querySelectorAll('input[type="radio"]')];
    const radio = radios.find(r => r.value === target || r.getAttribute('data-value') === target);
    if (radio && !radio.checked) { radio.click(); return target === 'true' ? 'clicked Yes' : 'clicked No'; }
    if (radio?.checked) return target === 'true' ? 'already Yes' : 'already No';
    const noBtn = [...field.querySelectorAll('button')]
      .find(b => b.textContent.trim().toLowerCase() === (target === 'false' ? 'no' : 'yes'));
    if (noBtn) { noBtn.click(); return 'clicked (button)'; }
    return 'NOT_FOUND';
  }, prevWorkerTarget);
  if (prevResult !== 'field not present') console.log('  Previous employee:', prevResult);

  // ── Legal Name ───────────────────────────────────────────────────────────
  // Confirmed IDs: name--legalName--firstName / name--legalName--lastName
  // (both name sections share label "Given Name(s)"/"Family Name" — use IDs directly)
  const legalFirst = await page.evaluate(id => document.getElementById(id)?.value ?? null, 'name--legalName--firstName');
  const legalLast  = await page.evaluate(id => document.getElementById(id)?.value ?? null, 'name--legalName--lastName');
  if (legalFirst !== null && legalFirst !== profile.firstName) {
    const r = await fillText(page, 'name--legalName--firstName', profile.firstName);
    console.log('  Legal first name:', r.ok ? profile.firstName : r.error);
  } else if (legalFirst !== null) {
    console.log('  Legal first name: already:', legalFirst);
  }
  if (legalLast !== null && legalLast !== profile.lastName) {
    const r = await fillText(page, 'name--legalName--lastName', profile.lastName);
    console.log('  Legal last name:', r.ok ? profile.lastName : r.error);
  } else if (legalLast !== null) {
    console.log('  Legal last name: already:', legalLast);
  }

  // ── Preferred Name ───────────────────────────────────────────────────────
  if (profile.preferredFirstName) {
    const prefChecked = await page.evaluate(() => {
      const cb = document.getElementById('name--preferredCheck');
      if (!cb) return 'NOT_FOUND';
      if (!cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); return 'CHECKED'; }
      return 'ALREADY_CHECKED';
    });
    if (prefChecked !== 'NOT_FOUND') {
      console.log('  Preferred name checkbox:', prefChecked);
      if (prefChecked === 'CHECKED' || prefChecked === 'ALREADY_CHECKED') {
        await wait(600);
        const r1 = await fillText(page, 'name--preferredName--firstName', profile.preferredFirstName);
        console.log('  Preferred first name:', r1.ok ? profile.preferredFirstName : r1.error);
        const r2 = await fillText(page, 'name--preferredName--lastName', profile.preferredLastName ?? '');
        console.log('  Preferred last name:', r2.ok ? profile.preferredLastName : r2.error);
      }
    }
  }

  // ── Address ───────────────────────────────────────────────────────────────
  const streetField   = findField(snap.fields, 'street') ?? findField(snap.fields, 'address line 1');
  const cityField     = findField(snap.fields, 'city') ?? findField(snap.fields, 'municipality');
  const postcodeField = findField(snap.fields, 'postcode') ?? findField(snap.fields, 'postal');
  const regionField   = findField(snap.fields, 'canton') ?? findField(snap.fields, 'state')
                     ?? findField(snap.fields, 'province') ?? findField(snap.fields, 'region');

  if (streetField   && !streetField.value)   { await fillText(page, streetField.id,   profile.street);     console.log('  Street:', profile.street); }
  if (cityField     && !cityField.value)     { await fillText(page, cityField.id,     profile.city);       console.log('  City:', profile.city); }
  if (postcodeField && !postcodeField.value) { await fillText(page, postcodeField.id, profile.postalCode); console.log('  Postcode:', profile.postalCode); }
  if (regionField) {
    if (regionField.type === 'listbox') {
      const r = await pickListbox(page, regionField.id, profile.countryRegion);
      console.log('  Region/Canton:', r.ok ? r.picked : r.error);
    } else if (!regionField.value) {
      await fillText(page, regionField.id, profile.countryRegion);
      console.log('  Region/Canton:', profile.countryRegion);
    } else {
      console.log('  Region/Canton: already:', regionField.value);
    }
  }

  // ── Phone ─────────────────────────────────────────────────────────────────
  const phoneSearch = profile.phoneCountry ?? profile.country ?? 'Switzerland';
  const phoneCodeEmpty = await page.evaluate(() => {
    const container = document.getElementById('phoneNumber--countryPhoneCode')
      ?.closest('[data-automation-id="multiSelectContainer"]');
    return !(container?.querySelector('[data-automation-id="selectedItem"]'));
  });
  if (phoneCodeEmpty) {
    const r = await typeaheadPick(page, 'phoneNumber--countryPhoneCode', phoneSearch, phoneSearch);
    console.log('  Phone code:', r.ok ? r.picked : r.error);
  } else {
    console.log('  Phone code already set');
  }

  const phoneNumField = findField(snap.fields, 'phone number') ?? findField(snap.fields, 'telephone');
  if (phoneNumField && !phoneNumField.value) {
    await fillText(page, phoneNumField.id, profile.phoneNumber);
    console.log('  Phone number:', profile.phoneNumber);
  }

  await wait(300);
  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
  if (!nr.ok) {
    const remaining = await getErrors(page);
    if (remaining.length) console.warn('  Remaining errors:', remaining[0].slice(0, 200));
  }
}

async function handleStep2(page) {
  console.log('\n── Step 2: My Experience ──');
  await fillAttachments(page);
  await fillWorkExperience(page);
  await fillEducation(page);

  // Delete any certification panels — we don't fill them (Workday cert typeahead
  // rejects programmatic input). Remove to avoid validation errors.
  {
    const snap0 = await inspectPage(page);
    for (const panel of getPanels(snap0.fields, 'certification')) {
      const r = await deletePanel(page, panel);
      console.log(`    Delete cert ${panel}:`, r.ok ? 'OK' : r.error);
      await wait(400);
    }
  }

  await fillLanguages(page);

  await wait(500);
  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
  if (!nr.ok) {
    const errs = await getErrors(page);
    console.warn('  Validation errors:', errs);
  }
}

async function fillAttachments(page) {
  const snap     = await inspectPage(page);
  const existing = (snap.uploadAreas[0]?.files ?? []).map(f => f.toLowerCase());
  const cvName   = profile.resumePath.split('/').pop().toLowerCase();
  const clName   = profile.coverLetterPath?.split('/').pop().toLowerCase();

  const toUpload = [];
  if (!existing.some(f => f.includes('cv') || f.includes('resume') || f === cvName)) {
    toUpload.push(profile.resumePath);
  } else {
    console.log(`  CV already present (${existing.find(f => f.includes('cv') || f.includes('resume'))})`);
  }
  if (clName && !existing.some(f => f.includes('cover') || f === clName)) {
    toUpload.push(profile.coverLetterPath);
  } else if (clName) {
    console.log('  Cover letter already present');
  }

  if (toUpload.length) {
    console.log('  Uploading:', toUpload.map(p => p.split('/').pop()).join(' + '));
    const r = await uploadFiles(page, toUpload);
    console.log('  Upload result:', r.ok ? `✓ ${r.files.join(', ')}` : r.error);
  }
}

async function fillWorkExperience(page) {
  if (!profile.workExperiences?.length) return;
  console.log('  [Work Experience]');

  let snap = await inspectPage(page);
  for (const panel of getPanels(snap.fields, 'workExperience')) {
    const r = await deletePanel(page, panel);
    console.log(`    Delete ${panel}:`, r.ok ? 'OK' : r.error);
    await wait(400);
  }

  for (let i = 0; i < profile.workExperiences.length; i++) {
    const we = profile.workExperiences[i];
    console.log(`    WE ${i + 1}: ${we.jobTitle} @ ${we.company}`);

    snap = await inspectPage(page);
    const before = new Set(getPanels(snap.fields, 'workExperience'));
    const addR = await clickAdd(page, 'Work Experience');
    if (!addR.ok) { console.warn('    Could not add WE panel:', addR.error); continue; }

    let newPanel = null;
    for (let t = 0; t < 8 && !newPanel; t++) {
      await wait(400);
      snap = await inspectPage(page);
      newPanel = getPanels(snap.fields, 'workExperience').find(p => !before.has(p));
    }
    if (!newPanel) { console.warn('    Panel not detected after Add'); continue; }

    const pf = panelFields(snap.fields, newPanel);
    const tf = async (lbl, val) => {
      const f = pf.find(x => x.label?.toLowerCase().includes(lbl.toLowerCase()) && (x.type === 'text' || x.type === 'textarea'));
      if (f) await fillText(page, f.id, val);
    };

    await tf('job title', we.jobTitle);
    await tf('company',   we.company);
    await tf('location',  we.location);

    if (we.current) {
      await page.evaluate(prefix => {
        const cb = document.querySelector(`input[id="${prefix}--currentlyWorkHere"]`);
        if (cb && !cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); }
      }, newPanel);
    }

    const startDate = pf.find(f => f.type === 'date' && f.label?.toLowerCase().includes('from'));
    if (startDate) await fillDate(page, startDate.monthId, startDate.yearId, we.startMonth, we.startYear);
    if (!we.current && we.endMonth && we.endYear) {
      const endDate = pf.find(f => f.type === 'date' && f.label?.toLowerCase().includes('to'));
      if (endDate) await fillDate(page, endDate.monthId, endDate.yearId, we.endMonth, we.endYear);
    }

    const desc = pf.find(f => f.type === 'textarea');
    if (desc) await fillText(page, desc.id, we.description);
    await wait(300);
  }
}

async function fillEducation(page) {
  if (!profile.education?.length) return;
  console.log('  [Education]');

  let snap = await inspectPage(page);
  for (const panel of getPanels(snap.fields, 'education')) {
    const r = await deletePanel(page, panel);
    console.log(`    Delete ${panel}:`, r.ok ? 'OK' : r.error);
    await wait(400);
  }

  for (let i = 0; i < profile.education.length; i++) {
    const edu = profile.education[i];
    console.log(`    Edu ${i + 1}: ${edu.degree} @ ${edu.school}`);

    snap = await inspectPage(page);
    const before = new Set(getPanels(snap.fields, 'education'));
    const addR = await clickAdd(page, 'Education');
    if (!addR.ok) { console.warn('    Could not add Edu panel:', addR.error); continue; }

    let newPanel = null;
    for (let t = 0; t < 8 && !newPanel; t++) {
      await wait(400);
      snap = await inspectPage(page);
      newPanel = getPanels(snap.fields, 'education').find(p => !before.has(p));
    }
    if (!newPanel) { console.warn('    Education panel not detected'); continue; }

    const pf = panelFields(snap.fields, newPanel);

    const schoolField = pf.find(f => f.aid === 'formField-school'
      || f.label?.toLowerCase().includes('school')
      || f.label?.toLowerCase().includes('university')
      || f.label?.toLowerCase().includes('institution'));
    if (schoolField) {
      const r = await typeAndEnter(page, schoolField.id, edu.school);
      console.log(`    School: ${r.ok ? r.selected.join(', ') : `not committed (${r.selected})`}`);
    }

    const degreeField = pf.find(f => f.type === 'listbox');
    if (degreeField) {
      const r = await pickListbox(page, degreeField.id, edu.degree);
      console.log(`    Degree: ${r.ok ? r.picked : r.error}`);
    }

    const fosField = pf.find(f => f.aid === 'formField-fieldOfStudy'
      || f.label?.toLowerCase().includes('field of study')
      || f.label?.toLowerCase().includes('major'));
    if (fosField) {
      const r = fosField.type === 'typeahead'
        ? await typeaheadPick(page, fosField.id, edu.fieldOfStudy, edu.fieldOfStudy)
        : await fillText(page, fosField.id, edu.fieldOfStudy);
      console.log(`    Field of study: ${r.ok ? (r.picked ?? 'OK') : r.error}`);
    }

    const dateFlds = pf.filter(f => f.type === 'date');
    if (dateFlds[0]) await fillDate(page, dateFlds[0].monthId, dateFlds[0].yearId, null, edu.startYear);
    if (dateFlds[1]) await fillDate(page, dateFlds[1].monthId, dateFlds[1].yearId, null, edu.endYear);
    await wait(300);
  }
}

async function fillLanguages(page) {
  if (!profile.languages?.length) return;
  console.log('  [Languages]');

  let snap = await inspectPage(page);
  for (const panel of getPanels(snap.fields, 'language')) {
    const r = await deletePanel(page, panel);
    console.log(`    Delete ${panel}:`, r.ok ? 'OK' : r.error);
    await wait(400);
  }

  for (let i = 0; i < profile.languages.length; i++) {
    const lang = profile.languages[i];
    console.log(`    Lang ${i + 1}: ${lang.language}`);

    let snap = await inspectPage(page);
    const before = new Set(getPanels(snap.fields, 'language'));
    const addR = await clickAdd(page, 'Language');
    if (!addR.ok) { console.warn('    Could not add language panel:', addR.error); break; }

    let newPanel = null;
    for (let t = 0; t < 8 && !newPanel; t++) {
      await wait(400);
      snap = await inspectPage(page);
      newPanel = getPanels(snap.fields, 'language').find(p => !before.has(p));
    }
    if (!newPanel) { console.warn('    Language panel not detected'); continue; }

    const pf = panelFields(snap.fields, newPanel);
    const langField = pf.find(f => f.type === 'listbox');
    if (langField) {
      const r = await pickListbox(page, langField.id, lang.language);
      console.log(`    Language: ${r.ok ? r.picked : r.error}`);
    }
    const profField = pf.filter(f => f.type === 'listbox')[1];
    if (profField) {
      const r = await pickListbox(page, profField.id, lang.proficiency);
      console.log(`    Proficiency: ${r.ok ? r.picked : r.error}`);
    }
    await wait(300);
  }
}

async function handleQuestions(page, stepLabel) {
  console.log(`\n── ${stepLabel} ──`);

  // Wait up to 8 s for question fields to render after page transition
  let snap;
  for (let i = 0; i < 8; i++) {
    snap = await inspectPage(page);
    if (snap.fields.length > 0) break;
    await wait(1000);
  }

  const aq = profile.applicationQuestions ?? {};

  for (const field of snap.fields) {
    const lower = field.label?.toLowerCase() ?? '';
    let answer = null;
    for (const [key, val] of Object.entries(aq)) {
      if (lower.includes(key.toLowerCase())) { answer = val; break; }
    }
    if (!answer) { console.log(`  [no profile answer] "${field.label?.slice(0, 70)}"`); continue; }

    if (field.type === 'listbox' || field.type === 'dropdown') {
      const r = await pickListbox(page, field.id, answer);
      console.log(`  "${field.label?.slice(0, 50)}" → ${r.ok ? r.picked : r.error}`);

    } else if (field.type === 'button-group') {
      const opt = field.options?.find(o => o.label.toLowerCase() === answer.toLowerCase())
               ?? field.options?.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
      if (opt) {
        await clickById(page, opt.id);
        console.log(`  "${field.label?.slice(0, 50)}" → ${opt.label}`);
      } else {
        console.warn(`  No button match for "${answer}" in [${field.options?.map(o => o.label).join('|')}]`);
      }

    } else if (field.type === 'checkbox-group') {
      const opt = field.options?.find(o => (o.ariaLabel ?? '').toLowerCase().includes(answer.toLowerCase()));
      if (opt) {
        if (!opt.checked) {
          await clickById(page, opt.id);
          console.log(`  "${field.label?.slice(0, 50)}" → ${opt.ariaLabel}`);
        } else {
          console.log(`  "${field.label?.slice(0, 50)}" already: ${opt.ariaLabel}`);
        }
      } else {
        console.warn(`  No checkbox match for "${answer}"`);
      }
    }

    await wait(200);
  }

  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
}

async function handleDisclosure(page, stepName) {
  console.log(`\n── ${stepName} ──`);
  const accepted = await page.evaluate(() => {
    const cb = document.querySelector(
      '[name="acceptTermsAndAgreements"], ' +
      '[data-automation-id="acceptTermsCheckbox"] input, ' +
      'input[type="checkbox"][id*="Terms"], ' +
      'input[type="checkbox"][id*="terms"]'
    );
    if (!cb) return 'no T&C checkbox found';
    if (!cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); return 'CHECKED'; }
    return 'ALREADY_CHECKED';
  });
  console.log('  T&C:', accepted);
  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
}

async function handleReview(page) {
  console.log('\n── Review ──');
  const path = `/tmp/workday_review_${Date.now()}.png`;
  await screenshot(page, path);
  console.log(`  Screenshot saved → ${path}`);
  console.log('  Review before submitting. Run with --submit to proceed.');
  return path;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Connecting to browser…');
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const pages   = await browser.pages();
  let page      = pages.find(p => p.url().includes('workday'));

  if (!page) {
    console.log('No Workday tab — opening URL…');
    page = await browser.newPage();
    await page.goto(WORKDAY_URL, { waitUntil: 'networkidle2' });
    await wait(2000);
  } else if (fromStep === 0) {
    console.log('Navigating to:', WORKDAY_URL);
    await page.goto(WORKDAY_URL, { waitUntil: 'networkidle2' });
    await wait(3000);
  }

  page.on('dialog', async dialog => {
    console.log(`  [dialog] ${dialog.type()}: "${dialog.message().slice(0, 80)}" → accepting`);
    await dialog.accept();
  });

  await dismissModals(page);

  const initial = await inspectPage(page);
  console.log(`Profile: ${profileArg}`);
  console.log(`URL: ${WORKDAY_URL}`);
  console.log(`Current: step ${initial.step} (${initial.stepName})`);
  console.log(`Running from step ${fromStep}\n`);

  // ── Auth gate — Workday shows "Create Account/Sign In" when session expired ──
  if (initial.stepName?.toLowerCase().includes('sign in') ||
      initial.stepName?.toLowerCase().includes('create account')) {
    console.error(
      '\n⚠  Workday is asking you to sign in.\n' +
      '   1. In the browser, complete the Sign In (or Create Account) step.\n' +
      '   2. Re-run this script with --from-step=1 once you reach My Information.\n'
    );
    await browser.disconnect();
    process.exit(1);
  }

  const skip = n => fromStep > n;

  // ── Step 0: Autofill ──────────────────────────────────────────────────────
  const onAutofillPage = initial.step === 0 || initial.step === null
    || initial.stepName?.toLowerCase().includes('autofill');
  if (!skip(0)) {
    if (onAutofillPage) await handleStep0(page);
    else console.log('  [skip] Step 0: already past autofill step');
  }

  // ── Step 1: My Information ────────────────────────────────────────────────
  if (!skip(1)) {
    await waitForStep(page, null, 'my information');
    await handleStep1(page);
  }

  // ── Step 2: My Experience ─────────────────────────────────────────────────
  if (!skip(2)) {
    await waitForStep(page, null, 'my experience');
    await handleStep2(page);
  }

  // ── Question steps: dynamic — 0 to N pages, detected at runtime ──────────
  // waitForAnyStep: polls until stepName is NOT the excluded name (page has transitioned)
  // Returns null if no question step appears within the timeout.
  if (!skip(3)) {
    // First: wait until we've moved off "my experience" (page transition after step 2 Next)
    let prevStepName = 'my experience';
    for (let w = 0; w < 15; w++) {
      await wait(1000);
      const s = await inspectPage(page);
      if (!s.stepName?.toLowerCase().includes('my experience')) { prevStepName = ''; break; }
    }

    // Then handle any number of question steps
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(1000);
      const qSnap = await inspectPage(page);
      const name  = qSnap.stepName?.toLowerCase() ?? '';
      if (!name.includes('question')) break;
      if (name === prevStepName) {
        console.warn(`  Stuck on question step: ${qSnap.stepName} — check errors above`);
        break;
      }
      prevStepName = name;
      await handleQuestions(page, qSnap.stepName);
    }
  }

  // ── Voluntary Disclosures (optional step — not all employers include it) ──
  {
    await wait(1200);
    const dSnap = await inspectPage(page);
    const dName = dSnap.stepName?.toLowerCase() ?? '';
    if (dName.includes('disclos') || dName.includes('voluntary') || dName.includes('agreement')) {
      await handleDisclosure(page, dSnap.stepName);
    }
  }

  // ── Review ────────────────────────────────────────────────────────────────
  await waitForStep(page, null, 'review');
  const reviewPath = await handleReview(page);
  console.log(`\nReview screenshot: ${reviewPath}`);

  if (doSubmit) {
    console.log('\n--submit flag detected. Submitting in 5s — Ctrl-C to abort.');
    await wait(5000);
    await clickSelector(page, '[data-automation-id="bottom-navigation-next-button"]:not([disabled])');
    console.log('Submitted.');
  }

  await browser.disconnect();
  console.log('Done.');
})().catch(err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
