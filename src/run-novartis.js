/**
 * run-novartis.js — Orchestrator for the Novartis AI Specialist application.
 *
 * Design: the orchestrator inspects the live form page, then calls
 * primitive tools to fill it.  Every decision is made from the page state
 * returned by inspectPage() — no hard-coded field IDs in the logic below.
 *
 * Usage:
 *   node src/run-novartis.js [--from-step=N] [--submit]
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

const __dir  = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(readFileSync(resolve(__dir, '../profiles/antonio.json'), 'utf8'));

const args        = process.argv.slice(2);
const fromStepRaw = args.find(a => a.startsWith('--from-step='))?.split('=')[1];
const fromStep    = fromStepRaw !== undefined ? parseInt(fromStepRaw, 10) : 0;
const doSubmit    = args.includes('--submit');

const WORKDAY_URL = 'https://novartis.wd3.myworkdayjobs.com/en-US/Novartis_Careers/job/Basel-(City)/AI-Specialist-in-Biomedical-Research_REQ-10079623/apply/autofillWithResume';

const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find a field in the inspectPage snapshot by partial label match. */
function findField(fields, labelSnippet) {
  const l = labelSnippet.toLowerCase();
  return fields.find(f => f.label?.toLowerCase().includes(l));
}

/** Find all fields in a given panel (by panelId prefix). */
function panelFields(fields, panelAid) {
  return fields.filter(f => f.panelId === panelAid);
}

/** Wait for a specific step number OR step name fragment to be active. */
async function waitForStep(page, stepNum, nameHint = null, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snap = await inspectPage(page);
    const stepMatch  = snap.step === stepNum;
    const nameMatch  = nameHint && snap.stepName?.toLowerCase().includes(nameHint.toLowerCase());
    if (stepMatch || nameMatch) return snap;
    await wait(600);
  }
  const snap = await inspectPage(page);
  throw new Error(`Timeout waiting for step ${stepNum}${nameHint ? ` (${nameHint})` : ''}; currently on step ${snap.step} (${snap.stepName})`);
}

// ─── Step handlers ───────────────────────────────────────────────────────────

/** Step 0 — Autofill with Resume: upload CV, click Continue. */
async function handleStep0(page) {
  console.log('\n── Step 0: Autofill with Resume ──');
  const snap = await inspectPage(page);

  // Upload CV for autofill parsing (cover letter goes in step 2 attachments)
  const hasCV = snap.uploadAreas.some(u => u.files.length > 0);
  if (!hasCV) {
    console.log('  Uploading CV for autofill…');
    const r = await uploadFiles(page, [profile.resumePath]);
    console.log('  ', r.ok ? `Uploaded: ${r.files.join(', ')}` : r.error);
    await wait(2000);
  } else {
    console.log('  CV already present, skipping upload.');
  }

  // The Continue button on the autofill page is pageFooterNextButton
  const cont = await clickSelector(page,
    '[data-automation-id="pageFooterNextButton"]:not([disabled]),' +
    '[data-automation-id="bottom-navigation-next-button"]:not([disabled]),' +
    '[data-automation-id="autofillButton"]:not([disabled])'
  );
  if (cont.ok) {
    console.log('  Continue clicked — waiting for autofill to process…');
    await wait(5000); // autofill needs time to parse CV and fill fields
  } else {
    console.warn('  Continue button not found:', cont.error);
  }
}

/** Step 1 — My Information: fill all personal details + source. */
async function handleStep1(page) {
  console.log('\n── Step 1: My Information ──');
  const snap = await inspectPage(page);

  // ── Source ("How Did You Hear About Us?") — hierarchical two-step select ──
  // Top-level list: Agency, Company Website, ... Social Media, ...
  // Sub-menu under "Social Media": Facebook, Glassdoor, Google, LinkedIn, ...
  const sourceResult = await page.evaluate(async () => {
    const container = document.getElementById('source--source')
      ?.closest('[data-automation-id="multiSelectContainer"]');
    // Already selected?
    const selected = [...(container?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
      .map(e => e.textContent.trim());
    if (selected.some(s => s.toLowerCase().includes('linkedin'))) return 'already: LinkedIn';

    // Open the dropdown
    const input = document.getElementById('source--source');
    if (!input) return 'NOT_FOUND';
    input.scrollIntoView({ block: 'center' });
    input.click();
    await new Promise(r => setTimeout(r, 700));

    // Click "Social Media" in the top-level list
    const opts1 = [...document.querySelectorAll('[data-automation-id="promptOption"]')];
    const smOpt = opts1.find(o => o.textContent.trim() === 'Social Media');
    if (!smOpt) return 'Social Media NOT_FOUND in: ' + opts1.map(o=>o.textContent.trim()).join(', ');
    smOpt.closest('[role="option"]')?.click() ?? smOpt.click();
    await new Promise(r => setTimeout(r, 800));

    // Click "LinkedIn" in the sub-menu
    const opts2 = [...document.querySelectorAll('[data-automation-id="promptOption"]')];
    const liOpt = opts2.find(o => o.textContent.trim() === 'LinkedIn');
    if (!liOpt) return 'LinkedIn NOT_FOUND in sub-menu: ' + opts2.map(o=>o.textContent.trim()).join(', ');
    liOpt.closest('[role="option"]')?.click() ?? liOpt.click();
    return 'LinkedIn';
  });
  console.log('  Source:', sourceResult);

  // ── Previous Novartis employee — radio input (value="false" = No) ─────────
  const prevWorkerNo = await page.evaluate(() => {
    // Find radio inputs for candidateIsPreviousWorker and click value="false"
    const field = document.querySelector('[data-automation-id="formField-candidateIsPreviousWorker"]');
    if (!field) return 'NOT_FOUND';
    const radios = [...field.querySelectorAll('input[type="radio"]')];
    const noRadio = radios.find(r => r.value === 'false' || r.getAttribute('data-value') === 'false');
    if (noRadio && !noRadio.checked) { noRadio.click(); return 'clicked No'; }
    if (noRadio?.checked) return 'already No';
    // Fallback: button-group No option
    const noBtn = [...field.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === 'no');
    if (noBtn) { noBtn.click(); return 'clicked No (button)'; }
    return 'NOT_FOUND';
  });
  console.log('  Previous employee:', prevWorkerNo);

  // ── Legal Name ───────────────────────────────────────────────────────────
  // Confirmed input IDs: name--legalName--firstName / name--legalName--lastName
  // (Workday labels both sections "Given Name(s)" / "Family Name" so label search
  //  is ambiguous — use stable IDs directly.)
  const legalFirst = await page.evaluate(id => document.getElementById(id)?.value ?? null, 'name--legalName--firstName');
  const legalLast  = await page.evaluate(id => document.getElementById(id)?.value ?? null, 'name--legalName--lastName');
  if (legalFirst !== profile.firstName) {
    const r = await fillText(page, 'name--legalName--firstName', profile.firstName);
    console.log('  Legal first name:', r.ok ? profile.firstName : r.error);
  } else {
    console.log('  Legal first name: already:', legalFirst);
  }
  if (legalLast !== profile.lastName) {
    const r = await fillText(page, 'name--legalName--lastName', profile.lastName);
    console.log('  Legal last name:', r.ok ? profile.lastName : r.error);
  } else {
    console.log('  Legal last name: already:', legalLast);
  }

  // ── Preferred Name ───────────────────────────────────────────────────────
  // Confirmed IDs: name--preferredCheck (checkbox), name--preferredName--firstName/lastName
  if (profile.preferredFirstName) {
    const prefChecked = await page.evaluate(() => {
      const cb = document.getElementById('name--preferredCheck');
      if (!cb) return 'NOT_FOUND';
      if (!cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); return 'CHECKED'; }
      return 'ALREADY_CHECKED';
    });
    console.log('  Preferred name checkbox:', prefChecked);

    if (prefChecked === 'CHECKED' || prefChecked === 'ALREADY_CHECKED') {
      await wait(600); // wait for fields to render if newly expanded
      const r1 = await fillText(page, 'name--preferredName--firstName', profile.preferredFirstName);
      console.log('  Preferred first name:', r1.ok ? profile.preferredFirstName : r1.error);
      const r2 = await fillText(page, 'name--preferredName--lastName', profile.preferredLastName);
      console.log('  Preferred last name:', r2.ok ? profile.preferredLastName : r2.error);
    }
  }

  // ── Address ───────────────────────────────────────────────────────────────
  const streetField  = findField(snap.fields, 'street') ?? findField(snap.fields, 'address line 1');
  const cityField    = findField(snap.fields, 'city') ?? findField(snap.fields, 'municipality');
  const postcodeField = findField(snap.fields, 'postcode') ?? findField(snap.fields, 'postal');
  const cantonField  = findField(snap.fields, 'canton') ?? findField(snap.fields, 'state') ?? findField(snap.fields, 'region');

  if (streetField   && !streetField.value)   { await fillText(page, streetField.id,   profile.street);      console.log('  Street:', profile.street); }
  if (cityField     && !cityField.value)     { await fillText(page, cityField.id,     profile.city);        console.log('  City:', profile.city); }
  if (postcodeField && !postcodeField.value) { await fillText(page, postcodeField.id, profile.postalCode);  console.log('  Postcode:', profile.postalCode); }
  if (cantonField?.type === 'listbox') {
    const r = await pickListbox(page, cantonField.id, profile.countryRegion);
    console.log('  Canton:', r.ok ? r.picked : r.error);
  } else if (cantonField && !cantonField.value) {
    await fillText(page, cantonField.id, profile.countryRegion);
    console.log('  Canton:', profile.countryRegion);
  }

  // ── Phone ─────────────────────────────────────────────────────────────────
  // Phone code — multiselect typeahead (always use fixed ID)
  const phoneCodeEmpty = await page.evaluate(() => {
    const container = document.getElementById('phoneNumber--countryPhoneCode')
      ?.closest('[data-automation-id="multiSelectContainer"]');
    return !(container?.querySelector('[data-automation-id="selectedItem"]'));
  });
  if (phoneCodeEmpty) {
    const r = await typeaheadPick(page, 'phoneNumber--countryPhoneCode', 'Switzerland', 'Switzerland (+41)');
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

/** Step 2 — My Experience: WE, Education, Certifications, Languages, file uploads. */
async function handleStep2(page) {
  console.log('\n── Step 2: My Experience ──');

  // ── Upload CV + Cover Letter ────────────────────────────────────────────
  await fillAttachments(page);

  // ── Work Experience ─────────────────────────────────────────────────────
  await fillWorkExperience(page);

  // ── Education ───────────────────────────────────────────────────────────
  await fillEducation(page);

  // ── Certifications — delete any existing panels, do not add new ones ────
  {
    const snap0 = await inspectPage(page);
    for (const panel of getPanels(snap0.fields, 'certification')) {
      const r = await deletePanel(page, panel);
      console.log(`  Delete cert ${panel}:`, r.ok ? 'OK' : r.error);
      await wait(400);
    }
  }

  // ── Languages ───────────────────────────────────────────────────────────
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
  const snap = await inspectPage(page);
  const existing = (snap.uploadAreas[0]?.files ?? []).map(f => f.toLowerCase());

  const cvName   = profile.resumePath.split('/').pop().toLowerCase();
  const clName   = profile.coverLetterPath.split('/').pop().toLowerCase();

  const toUpload = [];
  if (!existing.some(f => f.includes('cv') || f.includes('resume') || f === cvName)) {
    toUpload.push(profile.resumePath);
  } else {
    console.log(`  CV already present (${existing.find(f => f.includes('cv') || f.includes('resume'))})`);
  }
  if (!existing.some(f => f.includes('cover') || f === clName)) {
    toUpload.push(profile.coverLetterPath);
  } else {
    console.log(`  Cover letter already present`);
  }

  if (toUpload.length) {
    console.log('  Uploading:', toUpload.map(p => p.split('/').pop()).join(' + '));
    const r = await uploadFiles(page, toUpload);
    console.log('  Upload result:', r.ok ? `✓ ${r.files.join(', ')}` : r.error);
  }
}

/** Return unique panel prefixes for a section (e.g. ["workExperience-4","workExperience-5"]). */
function getPanels(fields, prefix) {
  return [...new Set(fields.map(f => f.panelId).filter(p => p?.startsWith(prefix + '-')))];
}

/** Find newest panel (highest numeric ID) in a list of panel prefixes. */
function newestPanel(panels) {
  return panels.sort((a, b) => parseInt(b.split('-').pop()) - parseInt(a.split('-').pop()))[0];
}

async function fillWorkExperience(page) {
  console.log('  [Work Experience]');

  // Delete any autofill-prepopulated panels first so we start clean
  let snap = await inspectPage(page);
  for (const panel of getPanels(snap.fields, 'workExperience')) {
    const r = await deletePanel(page, panel);
    console.log(`    Delete ${panel}:`, r.ok ? 'OK' : r.error);
    await wait(400);
  }

  // Add and fill each work experience
  for (let i = 0; i < profile.workExperiences.length; i++) {
    const we = profile.workExperiences[i];
    console.log(`    WE ${i + 1}: ${we.jobTitle} @ ${we.company}`);

    // Snapshot before Add to detect the new panel
    snap = await inspectPage(page);
    const before = new Set(getPanels(snap.fields, 'workExperience'));

    const addR = await clickAdd(page, 'Work Experience');
    if (!addR.ok) { console.warn('    Could not add WE panel:', addR.error); continue; }

    // Poll until a new panel appears
    let newPanel = null;
    for (let t = 0; t < 8 && !newPanel; t++) {
      await wait(400);
      snap = await inspectPage(page);
      newPanel = getPanels(snap.fields, 'workExperience').find(p => !before.has(p));
    }
    if (!newPanel) { console.warn('    Panel not detected after Add'); continue; }

    const pf = panelFields(snap.fields, newPanel);

    // Fill text fields by label
    const tf = async (lbl, val) => {
      const f = pf.find(x => x.label?.toLowerCase().includes(lbl.toLowerCase()) && (x.type === 'text' || x.type === 'textarea'));
      if (!f) return;
      const r = await fillText(page, f.id, val);
      if (!r.ok) console.warn(`      fillText "${lbl}":`, r.error);
    };

    await tf('job title', we.jobTitle);
    await tf('company',   we.company);
    await tf('location',  we.location);

    // "I currently work here" checkbox — find by input ID pattern
    if (we.current) {
      await page.evaluate(prefix => {
        const cb = document.querySelector(`input[id="${prefix}--currentlyWorkHere"]`);
        if (cb && !cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); }
      }, newPanel);
    }

    // Start date
    const startDate = pf.find(f => f.type === 'date' && f.label?.toLowerCase().includes('from'));
    if (startDate) await fillDate(page, startDate.monthId, startDate.yearId, we.startMonth, we.startYear);

    // End date (only if not current)
    if (!we.current && we.endMonth && we.endYear) {
      const endDate = pf.find(f => f.type === 'date' && f.label?.toLowerCase().includes('to'));
      if (endDate) await fillDate(page, endDate.monthId, endDate.yearId, we.endMonth, we.endYear);
    }

    // Role description (textarea)
    const desc = pf.find(f => f.type === 'textarea');
    if (desc) await fillText(page, desc.id, we.description);

    await wait(300);
  }
}

async function fillEducation(page) {
  console.log('  [Education]');

  // Delete any autofill-added education panels
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

    // School — type German name + Enter to add as custom entry
    const schoolField = pf.find(f => f.aid === 'formField-school' || f.label?.toLowerCase().includes('school') || f.label?.toLowerCase().includes('university'));
    if (schoolField) {
      const r = await typeAndEnter(page, schoolField.id, edu.school);
      console.log(`    School: ${r.ok ? r.selected.join(', ') : `not committed (selected: ${r.selected})`}`);
    }

    // Degree — listbox
    const degreeField = pf.find(f => f.type === 'listbox');
    if (degreeField) {
      const r = await pickListbox(page, degreeField.id, edu.degree);
      console.log(`    Degree: ${r.ok ? r.picked : r.error}`);
    }

    // Field of study — text or second typeahead
    const fosField = pf.find(f => f.aid === 'formField-fieldOfStudy' || f.label?.toLowerCase().includes('field of study') || f.label?.toLowerCase().includes('major'));
    if (fosField) {
      let r;
      if (fosField.type === 'typeahead') {
        r = await typeaheadPick(page, fosField.id, edu.fieldOfStudy, edu.fieldOfStudy);
      } else {
        r = await fillText(page, fosField.id, edu.fieldOfStudy);
      }
      console.log(`    Field of study: ${r.ok ? (r.picked ?? 'OK') : r.error}`);
    }

    // Years (education uses year-only spinbuttons — no month)
    const dateFlds = pf.filter(f => f.type === 'date');
    if (dateFlds[0]) await fillDate(page, dateFlds[0].monthId, dateFlds[0].yearId, null, edu.startYear);
    if (dateFlds[1]) await fillDate(page, dateFlds[1].monthId, dateFlds[1].yearId, null, edu.endYear);

    await wait(300);
  }
}

async function fillCertifications(page) {
  if (!profile.certifications?.length) return;
  console.log('  [Certifications]');

  // Delete any existing cert panels first
  let snap0 = await inspectPage(page);
  for (const panel of getPanels(snap0.fields, 'certification')) {
    const r = await deletePanel(page, panel);
    console.log(`    Delete ${panel}:`, r.ok ? 'OK' : r.error);
    await wait(400);
  }

  for (let i = 0; i < profile.certifications.length; i++) {
    const cert = profile.certifications[i];
    console.log(`    Cert ${i + 1}: ${cert.certName}`);

    let snap = await inspectPage(page);
    const before = new Set(getPanels(snap.fields, 'certification'));

    const addR = await clickAdd(page, 'Certification');
    if (!addR.ok) { console.warn('    Could not add cert panel:', addR.error); break; }

    let newPanel = null;
    for (let t = 0; t < 8 && !newPanel; t++) {
      await wait(400);
      snap = await inspectPage(page);
      newPanel = getPanels(snap.fields, 'certification').find(p => !before.has(p));
    }
    if (!newPanel) { console.warn('    Cert panel not detected'); continue; }

    const pf = panelFields(snap.fields, newPanel);

    // "Certification*" — plain type + Tab (blur); field stores free text in input.value
    const certField = pf.find(f => f.aid === 'formField-certification');
    if (certField) {
      await page.focus(`#${certField.id}`);
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.type(cert.certName, { delay: 30 });
      await page.keyboard.press('Tab'); // blur — commits the value without clearing
      await wait(200);
      const val = await page.evaluate(id => document.getElementById(id)?.value ?? '', certField.id);
      console.log(`    Cert name: ${val || '(empty — may need manual entry)'}`);
    }

    // Issued Date — use January as default month when field has a month spinbutton
    const dateField = pf.find(f => f.type === 'date' && f.label?.toLowerCase().includes('issued'));
    if (dateField) await fillDate(page, dateField.monthId, dateField.yearId, dateField.monthId ? '1' : null, cert.year);

    await wait(300);
  }
}

async function fillLanguages(page) {
  if (!profile.languages?.length) return;
  console.log('  [Languages]');

  // Delete any existing language panels first
  let snap0 = await inspectPage(page);
  for (const panel of getPanels(snap0.fields, 'language')) {
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

    // Language — usually the only listbox in the panel
    const langField = pf.find(f => f.type === 'listbox');
    if (langField) {
      const r = await pickListbox(page, langField.id, lang.language);
      console.log(`    Language: ${r.ok ? r.picked : r.error}`);
    }

    // Proficiency — second listbox
    const profField = pf.filter(f => f.type === 'listbox')[1];
    if (profField) {
      const r = await pickListbox(page, profField.id, lang.proficiency);
      console.log(`    Proficiency: ${r.ok ? r.picked : r.error}`);
    }

    await wait(300);
  }
}

/** Steps 3-5 — Application Questions: handle button-groups and listboxes. */
async function handleQuestions(page, stepLabel) {
  console.log(`\n── ${stepLabel} ──`);

  // Wait up to 8s for at least one question field to be visible
  let snap;
  for (let i = 0; i < 8; i++) {
    snap = await inspectPage(page);
    if (snap.fields.length > 0) break;
    await wait(1000);
  }
  const aq = profile.applicationQuestions ?? {};

  for (const field of snap.fields) {
    const lower = field.label?.toLowerCase() ?? '';

    // Find answer from profile
    let answer = null;
    for (const [key, val] of Object.entries(aq)) {
      if (lower.includes(key.toLowerCase())) { answer = val; break; }
    }
    if (!answer) { console.log(`  [no profile answer] "${field.label?.slice(0,60)}"`); continue; }

    if (field.type === 'listbox') {
      const r = await pickListbox(page, field.id, answer);
      console.log(`  "${field.label?.slice(0,50)}" → ${r.ok ? r.picked : r.error}`);

    } else if (field.type === 'button-group') {
      const opt = field.options?.find(o => o.label.toLowerCase() === answer.toLowerCase())
               ?? field.options?.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
      if (opt) {
        await clickById(page, opt.id);
        console.log(`  "${field.label?.slice(0,50)}" → ${opt.label}`);
      } else {
        console.warn(`  No button match for "${answer}" in [${field.options?.map(o=>o.label).join('|')}]`);
      }

    } else if (field.type === 'checkbox-group') {
      const opt = field.options?.find(o => (o.ariaLabel ?? '').toLowerCase().includes(answer.toLowerCase()));
      if (opt) {
        if (!opt.checked) {
          await clickById(page, opt.id);
          console.log(`  "${field.label?.slice(0,50)}" → ${opt.ariaLabel}`);
        } else {
          console.log(`  "${field.label?.slice(0,50)}" already: ${opt.ariaLabel}`);
        }
      } else {
        console.warn(`  No checkbox match for "${answer}"`);
      }

    } else if (field.type === 'dropdown') {
      const r = await pickListbox(page, field.id, answer);
      console.log(`  "${field.label?.slice(0,50)}" → ${r.ok ? r.picked : r.error}`);
    }

    await wait(200);
  }

  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
}

/** Step 6 — Voluntary Disclosures: accept T&C. */
async function handleStep6(page) {
  console.log('\n── Step 6: Voluntary Disclosures ──');

  // Accept terms checkbox
  const accepted = await page.evaluate(() => {
    const cb = document.querySelector('[name="acceptTermsAndAgreements"], [data-automation-id="acceptTermsCheckbox"] input');
    if (!cb) return 'NOT_FOUND';
    if (!cb.checked) { cb.scrollIntoView({ block: 'center' }); cb.click(); return 'CHECKED'; }
    return 'ALREADY_CHECKED';
  });
  console.log('  T&C:', accepted);

  const nr = await clickNext(page);
  console.log('  → Next:', nr.ok ? 'OK' : `ERRORS: ${nr.errors.join('; ')}`);
}

/** Step 7 — Review. */
async function handleStep7(page) {
  console.log('\n── Step 7: Review ──');
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
    // Fresh start — navigate to autofillWithResume
    console.log('Navigating to autofillWithResume for fresh start…');
    await page.goto(WORKDAY_URL, { waitUntil: 'networkidle2' });
    await wait(3000);
  }

  // Accept any browser-native confirm/alert dialogs (e.g. "delete?" confirmations)
  page.on('dialog', async dialog => {
    console.log(`  [dialog] ${dialog.type()}: "${dialog.message().slice(0, 80)}" → accepting`);
    await dialog.accept();
  });

  await dismissModals(page);

  const initial = await inspectPage(page);
  console.log(`Current: step ${initial.step} (${initial.stepName})`);
  console.log(`Running from step ${fromStep}\n`);

  // Helper: skip if before fromStep
  const skip = n => fromStep > n;

  // ── Step 0: Autofill ──
  // Detect autofill page by step number OR by stepName containing "autofill"
  const onAutofillPage = initial.step === 0 || initial.step === null
    || initial.stepName?.toLowerCase().includes('autofill');

  if (!skip(0)) {
    if (onAutofillPage) {
      await handleStep0(page);
    } else {
      console.log('  [skip] Step 0: already past autofill step');
    }
  }

  // Use step-name matching exclusively — step numbers shift when autofill is present
  if (!skip(1)) {
    await waitForStep(page, null, 'my information');
    await handleStep1(page);
  }
  if (!skip(2)) {
    await waitForStep(page, null, 'my experience');
    await handleStep2(page);
  }
  if (!skip(3)) {
    await waitForStep(page, null, 'questions 1');
    await handleQuestions(page, 'Application Questions 1 of 3');
  }
  if (!skip(4)) {
    await waitForStep(page, null, 'questions 2');
    await handleQuestions(page, 'Application Questions 2 of 3');
  }
  if (!skip(5)) {
    await waitForStep(page, null, 'questions 3');
    await handleQuestions(page, 'Application Questions 3 of 3');
  }
  if (!skip(6)) {
    await waitForStep(page, null, 'disclosure');
    await handleStep6(page);
  }
  await waitForStep(page, null, 'review');
  const reviewPath = await handleStep7(page);
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
