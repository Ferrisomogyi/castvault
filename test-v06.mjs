/* CastVault v0.6 — headless testharness (jsdom + fake-indexeddb + node webcrypto)
   Draait: node test-v06.mjs */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

const html = fs.readFileSync('./index.html', 'utf8');
const appJs = fs.readFileSync('./app.js', 'utf8');
const swJs = fs.readFileSync('./sw.js', 'utf8');
const workerJs = fs.readFileSync('./worker.js', 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } };
const section = s => console.log('\n— ' + s);

/* ========== 1. STATISCHE CHECKS ========== */
section('Statische checks');
t('app.js header zegt v0.6', /CastVault v0\.6/.test(appJs));
t('sw.js cache-bump naar v0.6', /castvault-v0\.6/.test(swJs));
t('geen API-key in client (app.js/index.html/sw.js)', !/sk-ant-/.test(appJs + html + swJs));
t('CSP aanwezig en onveranderd streng (geen nieuwe origins nodig voor v0.5)',
  html.includes("connect-src 'self' https://nl.wikipedia.org https://en.wikipedia.org https://castvault.ferencsomogyi.workers.dev"));
t('CSP img-src staat data: toe (nodig voor foto’s)', /img-src 'self' data:/.test(html));
t('worker.js: API-key via secret', /ANTHROPIC_API_KEY/.test(workerJs));
t('v0.6: Wikipedia zoek-API-fallback aanwezig (case-insensitive titel-resolve)', appJs.includes('list=search') && appJs.includes('origin=*') && /wikiZoekTitel/.test(appJs));
t('v0.6: zoek-fallback vergelijkt titels hoofdlettergevoelig (anders mist hij de fix-case)', appJs.includes('titel !== naam'));
t('v0.6: AI-bio waarschuwing in review-modal', appJs.includes("startsWith('AI')"));
t('v0.6: bio-call stuurt geboortejaar mee', /callWorker\('bio', naam, \{ geboortejaar/.test(appJs));
t('v0.6: worker bio-prompt verhard (verzin-nooit-regels)', workerJs.includes('Verzin NOOIT') && workerJs.includes('onbekend'));
t('v0.6: worker temperature 0', /temperature: 0/.test(workerJs));
t('v0.6: worker bioPrompt accepteert geboortejaar', /bioPrompt\(naam, geboortejaar\)/.test(workerJs));
const ids = ['modal-foto','foto-preview','foto-input','btn-foto-pick','btn-foto-del',
  'modal-dossier','btn-dossier-html','btn-dossier-json','detail-dossier',
  'modal-auditlog','btn-auditlog','al-contact','al-actie','al-van','al-tot','al-zoek','al-rows','al-count','al-csv','al-wis',
  'modal-delete','del-naam','del-reden','del-bevestig','btn-del-def','del-msg',
  'modal-bio','btn-bio','bio-status','bio-pw','btn-bio-aan','btn-bio-uit','bio-msg','bio-unlock-btn'];
t('alle 34 nieuwe DOM-ids aanwezig in index.html', ids.every(id => html.includes(`id="${id}"`)));
t('audit-tab verwijst niet meer naar "komt in chat 4"', !appJs.includes('komt in chat 4'));
const idsV05 = ['btn-retentie','retentie-badge','modal-retentie','ret-maanden','ret-rows','ret-count'];
t('alle 6 nieuwe v0.5 DOM-ids aanwezig in index.html', idsV05.every(id => html.includes(`id="${id}"`)));
t('retentie-module aanwezig in app.js', /staleContacts|lastTouched|markRetentieKeep/.test(appJs));
t('v0.5.1: backdrop-klik + Escape sluiten aanwezig', appJs.includes("e.key === 'Escape'") && appJs.includes('e.target === bd'));

/* ========== 2. DOM-OMGEVING OPZETTEN ========== */
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://ferrisomogyi.github.io/castvault/', pretendToBeVisual: true });
const w = dom.window;
w.indexedDB = globalThis.indexedDB;
Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
w.confirm = () => true;
w.fetch = async () => { throw new Error('netwerk uit in tests'); };
w.URL.createObjectURL = () => 'blob:test';
w.URL.revokeObjectURL = () => {};
if (!('serviceWorker' in w.navigator)) { /* jsdom heeft geen SW — init() vangt dat af */ }
/* const/let in indirecte eval blijven niet globaal — daarom een directe-eval-brug in dezelfde scope */
w.eval(appJs + '\n;window.__expose = function(expr) { return eval(expr); };');
const E = expr => w.__expose(expr);
const Easync = expr => w.__expose(`(async () => (${expr}))()`);
await new Promise(r => setTimeout(r, 50)); // init() laten landen

/* ========== 3. VAULT SETUP / UNLOCK ========== */
section('Vault setup & unlock');
await Easync(`setupVault('test-wachtwoord-123!')`);
t('vault opgezet, key in state', E(`!!state.key`));
E(`state.key = null`);
t('fout wachtwoord geweigerd', (await Easync(`unlockVault('verkeerd-wachtwoord-1')`)) === false);
t('goed wachtwoord geaccepteerd', (await Easync(`unlockVault('test-wachtwoord-123!')`)) === true);
await Easync(`loadDeletions()`);
t('verwijderlog initieel leeg', E(`state.deletions.length`) === 0);

/* ========== 4. FOTO-VELD (opslag, veiligheid, roundtrip) ========== */
section('Foto');
const fotoPx = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ=='; // mini-jpeg-dataURL (structuur telt, niet inhoud)
await Easync(`(async () => { const c = blankContact(); c.naam = 'Foto Test'; c.foto = ${JSON.stringify(fotoPx)}; c.fotoToegevoegd = new Date().toISOString(); c.auditLog.push({ datum: new Date().toISOString(), actie: 'foto toegevoegd', veld: 'foto', oude: '', nieuwe: '[foto]' }); await saveContact(c); globalThis.__fotoId = c.id; })()`);
await Easync(`loadAllContacts()`);
t('foto overleeft save + reload (versleuteld in IndexedDB)', E(`state.contacts.get(globalThis.__fotoId).foto`) === fotoPx);
t('foto staat NIET als plaintext in IndexedDB', await (async () => {
  const raw = await new Promise((res, rej) => { const rq = indexedDB.open('castvault', 1); rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('contacts'); const g = tx.objectStore('contacts').getAll(); g.onsuccess = () => { res(JSON.stringify(g.result)); db.close(); }; }; rq.onerror = () => rej(rq.error); });
  return !raw.includes('data:image');
})());
t('avatarInnerHtml rendert <img> bij geldige foto', E(`avatarInnerHtml(state.contacts.get(globalThis.__fotoId))`).startsWith('<img'));
t('XSS-guard: javascript:-URL als foto → initialen, geen <img>', E(`avatarInnerHtml({ naam: 'X Y', foto: 'javascript:alert(1)' })`) === 'XY');
t('XSS-guard: data:text/html geweigerd', E(`avatarInnerHtml({ naam: 'A B', foto: 'data:text/html;base64,PHNjcmlwdD4=' })`) === 'AB');
t('FOTO_MAX_CHARS ≈ 200KB binair', E(`FOTO_MAX_CHARS`) === 273000);

/* ========== 5. DOSSIER-EXPORT (inzagerecht) ========== */
section('Dossier-export');
await Easync(`(async () => { const c = state.contacts.get(globalThis.__fotoId); c.bio = 'Testbio over <iemand>'; c.bioBron = 'Wikipedia (NL) — https://nl.wikipedia.org/x'; c.redFlags = [{ kleur: 'rood', motivatie: 'Kwam <niet> opdagen', bron: 'collega', datum: '2026-06-01' }]; c.notities = [{ datum: new Date().toISOString(), tekst: 'notitie & test' }]; c.tvProgrammas = [{ titel: 'Wie is de Mol?', jaar: '2024', rol: 'kandidaat', zender: 'AVROTROS', bron: 'AI — ongeverifieerd', geverifieerd: false }]; await saveContact(c); })()`);
const dossier = E(`dossierHtml(state.contacts.get(globalThis.__fotoId))`);
t('dossier bevat naam', dossier.includes('Foto Test'));
t('dossier bevat bio + bronvermelding', dossier.includes('Testbio over') && dossier.includes('Wikipedia (NL)'));
t('dossier bevat red flag met motivatie/bron/datum', dossier.includes('Kwam') && dossier.includes('collega') && dossier.includes('2026-06-01'));
t('dossier bevat tv-programma met ongeverifieerd-status', dossier.includes('Wie is de Mol?') && dossier.includes('ongeverifieerd'));
t('dossier bevat auditlog-tabel', dossier.includes('Auditlog'));
t('dossier bevat foto', dossier.includes('class="foto"'));
t('dossier bevat AVG-verantwoording (art. 15)', dossier.includes('art. 15'));
t('dossier escapet HTML (geen rauwe <iemand>)', !dossier.includes('<iemand>') && dossier.includes('&lt;iemand&gt;'));
t('dossier is volledig zelfstandig HTML-document', dossier.startsWith('<!DOCTYPE html>') && dossier.includes('</html>'));
// export-knop schrijft auditregel
E(`state.currentId = globalThis.__fotoId`);
E(`exportDossier('html')`);
await new Promise(r => setTimeout(r, 30));
t('dossier-export schrijft auditlog-regel', E(`state.contacts.get(globalThis.__fotoId).auditLog.some(l => l.actie === 'dossier geëxporteerd')`));

/* ========== 6. VERGEETRECHT-FLOW ========== */
section('Vergeetrecht');
await Easync(`(async () => { const c = blankContact(); c.naam = 'Te Verwijderen Persoon'; c.auditLog = [{ datum: new Date().toISOString(), actie: 'handmatig aangemaakt' }]; await saveContact(c); globalThis.__delId = c.id; })()`);
E(`state.currentId = globalThis.__delId`);
E(`openDeleteModal(state.contacts.get(globalThis.__delId))`);
t('delete-modal toont naam', w.document.getElementById('del-naam').textContent === 'Te Verwijderen Persoon');
t('delete-modal heeft 5 redenen', w.document.getElementById('del-reden').options.length === 5);
// verkeerde naam → weigeren
w.document.getElementById('del-bevestig').value = 'Verkeerde Naam';
w.document.getElementById('btn-del-def').click();
await new Promise(r => setTimeout(r, 30));
t('verkeerde naam getypt → niet verwijderd + foutmelding', E(`state.contacts.has(globalThis.__delId)`) && w.document.getElementById('del-msg').textContent.includes('exact'));
// goede naam → verwijderd + tombstone
w.document.getElementById('del-bevestig').value = 'Te Verwijderen Persoon';
w.document.getElementById('del-reden').value = 'Verzoek van betrokkene (AVG art. 17)';
w.document.getElementById('btn-del-def').click();
await new Promise(r => setTimeout(r, 60));
t('contact definitief weg uit state', !E(`state.contacts.has(globalThis.__delId)`));
t('contact definitief weg uit IndexedDB', await (async () => {
  const keys = await new Promise((res) => { const rq = indexedDB.open('castvault', 1); rq.onsuccess = () => { const db = rq.result; const g = db.transaction('contacts').objectStore('contacts').getAllKeys(); g.onsuccess = () => { res(g.result); db.close(); }; }; });
  return !keys.includes(E(`globalThis.__delId`));
})());
t('tombstone aangemaakt met datum + reden', E(`state.deletions.length`) === 1 && E(`state.deletions[0].reden`).includes('art. 17') && !!E(`state.deletions[0].datum`));
t('tombstone is geanonimiseerd (geen naam, geen oud contact-id)', (() => { const ts = JSON.stringify(E(`state.deletions[0]`)); return !ts.includes('Te Verwijderen') && !ts.includes(E(`globalThis.__delId`)); })());
t('tombstone versleuteld opgeslagen in meta', await (async () => {
  const raw = await new Promise((res) => { const rq = indexedDB.open('castvault', 1); rq.onsuccess = () => { const db = rq.result; const g = db.transaction('meta').objectStore('meta').get('deletions'); g.onsuccess = () => { res(JSON.stringify(g.result)); db.close(); }; }; });
  return raw.includes('"iv"') && raw.includes('"ct"') && !raw.includes('art. 17');
})());
await Easync(`loadDeletions()`);
t('verwijderlog overleeft reload', E(`state.deletions.length`) === 1);

/* ========== 7. GLOBALE AUDITLOG-UI ========== */
section('Auditlog-UI');
const entries = E(`JSON.stringify(collectAuditEntries())`);
const parsed = JSON.parse(entries);
t('verzamelt regels over contacten heen', parsed.some(r => r.contact === 'Foto Test'));
t('tombstone zichtbaar als [verwijderd contact] zonder naam', parsed.some(r => r.contact === '[verwijderd contact]' && r.actie.includes('vergeetrecht')) && !entries.includes('Te Verwijderen'));
t('gesorteerd nieuwste eerst', parsed.length < 2 || parsed[0].datum >= parsed[parsed.length - 1].datum);
E(`auditUI.zoek = 'dossier'`);
t('zoekfilter werkt', E(`filteredAuditEntries().every(r => (r.contact + r.actie + r.veld + r.oude + r.nieuwe).toLowerCase().includes('dossier'))`) && E(`filteredAuditEntries().length`) > 0);
E(`auditUI.zoek = ''; auditUI.actie = 'foto'`);
t('actiefilter werkt', E(`filteredAuditEntries().length`) > 0 && E(`filteredAuditEntries().every(r => r.actie.includes('foto'))`));
E(`auditUI.actie = ''; auditUI.van = '2099-01-01'`);
t('datumfilter werkt (toekomst → 0 regels)', E(`filteredAuditEntries().length`) === 0);
E(`auditUI.van = ''`);
E(`renderAuditlogModal()`);
t('contact-dropdown gevuld', w.document.getElementById('al-contact').options.length >= 2);
t('log-regels gerenderd', w.document.querySelectorAll('#al-rows .audit-row').length > 0);
t('CSV-escaping correct', E(`csvCell('met;puntkomma')`) === '"met;puntkomma"' && E(`csvCell('met "quote"')`) === '"met ""quote"""' && E(`csvCell('gewoon')`) === 'gewoon');

/* ========== 7b. v0.5: BEWAARTERMIJN-SIGNALERING ========== */
section('Bewaartermijn (v0.5)');
t('default bewaartermijn is 24 maanden', E(`state.settings.bewaartermijnMaanden`) === 24);
// settings roundtrip (versleuteld in meta)
E(`state.settings.bewaartermijnMaanden = 36`);
await Easync(`saveSettings()`);
E(`state.settings.bewaartermijnMaanden = 24`);
await Easync(`loadSettings()`);
t('settings overleven save + reload (36 mnd)', E(`state.settings.bewaartermijnMaanden`) === 36);
t('settings versleuteld opgeslagen in meta', await (async () => {
  const raw = await new Promise((res) => { const rq = indexedDB.open('castvault', 1); rq.onsuccess = () => { const db = rq.result; const g = db.transaction('meta').objectStore('meta').get('settings'); g.onsuccess = () => { res(JSON.stringify(g.result)); db.close(); }; }; });
  return raw.includes('"iv"') && raw.includes('"ct"') && !raw.includes('bewaartermijn');
})());
// oud contact aanmaken (saveContactRaw: geen updatedAt-bump)
await Easync(`(async () => { const c = blankContact(); c.naam = 'Oud Contact'; c.createdAt = '2020-01-15T10:00:00.000Z'; c.updatedAt = '2020-03-01T10:00:00.000Z'; c.auditLog = [{ datum: '2020-03-01T10:00:00.000Z', actie: 'import', bron: 'vCard' }]; await saveContactRaw(c); globalThis.__oudId = c.id; })()`);
t('lastTouched pakt de nieuwste datum (updatedAt vs auditlog)', E(`lastTouched(state.contacts.get(globalThis.__oudId))`) === '2020-03-01T10:00:00.000Z');
t('oud contact gesignaleerd als over de bewaartermijn', E(`staleContacts().some(x => x.c.id === globalThis.__oudId)`));
t('recent contact NIET gesignaleerd', !E(`staleContacts().some(x => x.c.id === globalThis.__fotoId)`));
E(`refreshRetentieBadge()`);
t('badge toont aantal gesignaleerde contacten', w.document.getElementById('retentie-badge').textContent === '1' && w.document.getElementById('retentie-badge').style.display !== 'none');
E(`renderRetentieRows()`);
t('signaleringslijst rendert naam + Open/Bewaren-knoppen', (() => { const r = w.document.querySelector('#ret-rows .ret-row'); return r && r.textContent.includes('Oud Contact') && !!r.querySelector('[data-ret-open]') && !!r.querySelector('[data-ret-keep]'); })());
await Easync(`markRetentieKeep(globalThis.__oudId)`);
t('bewaar-beoordeling schrijft retentie-check auditregel', E(`state.contacts.get(globalThis.__oudId).auditLog.some(l => l.actie === 'retentie-check')`));
t('bewaar-beoordeling zet retentieBeoordeeld-timestamp', !!E(`state.contacts.get(globalThis.__oudId).retentieBeoordeeld`));
t('na beoordeling geen signalering meer + badge weg', !E(`staleContacts().some(x => x.c.id === globalThis.__oudId)`) && w.document.getElementById('retentie-badge').style.display === 'none');
t('beoordeling bumpt updatedAt NIET (geen inhoudelijke wijziging)', E(`state.contacts.get(globalThis.__oudId).updatedAt`) === '2020-03-01T10:00:00.000Z');
t("AUDIT_ACTIES bevat 'retentie-check' (filterbaar in auditlog-UI)", E(`AUDIT_ACTIES.includes('retentie-check')`));

/* ========== 7c. v0.5.1: MODAL-SLUITGEDRAG ========== */
section('Modal sluiten (v0.5.1)');
E(`openModal('modal-auditlog')`);
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
t('Escape sluit een open modal', !w.document.getElementById('modal-auditlog').classList.contains('active'));
E(`openModal('modal-auditlog')`);
w.document.getElementById('modal-auditlog').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
t('klik op backdrop sluit de modal', !w.document.getElementById('modal-auditlog').classList.contains('active'));
E(`openModal('modal-auditlog')`);
w.document.querySelector('#modal-auditlog .modal-title').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
t('klik BINNEN de modal sluit hem niet', w.document.getElementById('modal-auditlog').classList.contains('active'));
E(`openModal('modal-retentie')`);
E(`openModal('modal-auditlog')`);
t('openModal sluit een al openstaande andere modal (geen stapeling)', !w.document.getElementById('modal-retentie').classList.contains('active') && w.document.getElementById('modal-auditlog').classList.contains('active'));
E(`closeModal('modal-auditlog')`);

/* ========== 8. EXPORT / IMPORT ROUNDTRIP (met foto + verwijderlog) ========== */
section('Export/import .castvault');
const exported = await Easync(`exportVault('bestandswachtwoord-456!')`);
t('export-envelope heeft juist formaat', (() => { const f = JSON.parse(exported); return f.format === 'castvault' && f.version === 1 && f.salt && f.iv && f.ct; })());
t('export bevat geen plaintext (naam/foto/reden)', !exported.includes('Foto Test') && !exported.includes('data:image') && !exported.includes('art. 17'));
let badPw = false;
try { await Easync(`importVault(${JSON.stringify(exported)}, 'fout-wachtwoord-789!', 'merge')`); } catch (e) { badPw = true; }
t('fout bestandswachtwoord → nette fout', badPw);
// wipe + replace-import
await Easync(`(async () => { for (const id of Array.from(state.contacts.keys())) await dbDelete('contacts', id); state.contacts.clear(); state.deletions = []; await saveDeletions(); state.settings = { ...DEFAULT_SETTINGS }; await saveSettings(); })()`);
const res = await Easync(`importVault(${JSON.stringify(exported)}, 'bestandswachtwoord-456!', 'replace')`);
t('import herstelt contacten', res.nieuw >= 1 && E(`state.contacts.size`) >= 1);
t('foto overleeft export/import-roundtrip', E(`Array.from(state.contacts.values()).some(c => c.foto === ${JSON.stringify(fotoPx)})`));
t('verwijderlog overleeft export/import-roundtrip', E(`state.deletions.length`) === 1 && E(`state.deletions[0].reden`).includes('art. 17'));
const res2 = await Easync(`importVault(${JSON.stringify(exported)}, 'bestandswachtwoord-456!', 'merge')`);
t('tombstones gededupliceerd bij merge', res2 && E(`state.deletions.length`) === 1);
t('bewaartermijn-instelling overleeft export + replace-import (36 mnd)', (() => { return E(`state.settings.bewaartermijnMaanden`) === 36; })());
t('retentieBeoordeeld overleeft export/import-roundtrip', E(`Array.from(state.contacts.values()).some(c => !!c.retentieBeoordeeld)`));

/* ========== 9. BIOMETRIC UNLOCK — crypto-primitieven ========== */
section('Biometrie (crypto-laag — WebAuthn zelf vereist echte browser)');
t('deriveKeyBits == deriveKey (zelfde sleutel uit zelfde wachtwoord)', await (async () => {
  return await Easync(`(async () => {
    const meta = await dbGet('meta', 'auth');
    const bits = await deriveKeyBits('test-wachtwoord-123!', unb64(meta.salt));
    const key = await importAesKey(bits);
    try { await decryptJSON(key, meta.verifier); return true; } catch (e) { return false; }
  })()`);
})());
t('PRF-pad: HKDF deterministisch — wrap & unwrap geeft werkende sleutel', await (async () => {
  return await Easync(`(async () => {
    const meta = await dbGet('meta', 'auth');
    const bits = await deriveKeyBits('test-wachtwoord-123!', unb64(meta.salt));
    const prfOut = randBytes(32); // gesimuleerde PRF-output van de authenticator
    const kek1 = await hkdfAesKey(prfOut);
    const wrapped = await encryptJSON(kek1, { k: b64(bits) });
    const kek2 = await hkdfAesKey(prfOut); // tweede afleiding, zelfde output
    const { k } = await decryptJSON(kek2, wrapped);
    const key = await importAesKey(unb64(k));
    try { await decryptJSON(key, meta.verifier); return true; } catch (e) { return false; }
  })()`);
})());
t('PRF-pad: andere PRF-output → ontsleutelen faalt', await (async () => {
  return await Easync(`(async () => {
    const meta = await dbGet('meta', 'auth');
    const bits = await deriveKeyBits('test-wachtwoord-123!', unb64(meta.salt));
    const kek1 = await hkdfAesKey(randBytes(32));
    const wrapped = await encryptJSON(kek1, { k: b64(bits) });
    const kekFout = await hkdfAesKey(randBytes(32));
    try { await decryptJSON(kekFout, wrapped); return false; } catch (e) { return true; }
  })()`);
})());
t('poort-pad: gate-key wrap & unwrap werkt', await (async () => {
  return await Easync(`(async () => {
    const meta = await dbGet('meta', 'auth');
    const bits = await deriveKeyBits('test-wachtwoord-123!', unb64(meta.salt));
    const gateBytes = randBytes(32);
    const wrapped = await encryptJSON(await importAesKey(gateBytes), { k: b64(bits) });
    const { k } = await decryptJSON(await importAesKey(gateBytes), wrapped);
    const key = await importAesKey(unb64(k));
    try { await decryptJSON(key, meta.verifier); return true; } catch (e) { return false; }
  })()`);
})());
t('bioApiAvailable() detecteert ontbreken van WebAuthn netjes (jsdom)', E(`bioApiAvailable()`) === false);
E(`refreshBioUnlockBtn()`);
await new Promise(r => setTimeout(r, 30));
t('bio-unlock-knop verborgen zonder ingestelde biometrie', w.document.getElementById('bio-unlock-btn').style.display === 'none');

/* ========== 10. UI-REGRESSIE ========== */
section('Regressie');
t('detail-hero toont foto + camera-knop', (() => { E(`state.currentId = Array.from(state.contacts.keys())[0]`); E(`renderDetailHero()`); return !!w.document.getElementById('btn-foto') && w.document.getElementById('detail-avatar').innerHTML.includes('<img'); })());
E(`openFotoModal()`);
t('foto-modal toont preview bij bestaande foto', w.document.getElementById('foto-preview').innerHTML.includes('<img'));
t('zoeken werkt nog (v0.1-regressie)', E(`searchContacts('Foto').length`) === 1);
t('v0.5.3: tekstzoekopdracht matcht NIET meer iedereen met een telefoonnummer', (() => { E(`(() => { const c = blankContact(); c.naam = 'Telefoon Test'; c.telefoon = [{label:'mobiel', nummer:'0612345678'}]; state.contacts.set(c.id, c); globalThis.__telId = c.id; })()`); return E(`searchContacts('herman').length`) === 0; })());
t('v0.5.3: zoeken op (deel van) nummer werkt nog wel', E(`searchContacts('0612345').length`) === 1 && (() => { E(`state.contacts.delete(globalThis.__telId)`); return true; })());
t('blankContact heeft v0.4-velden', E(`'foto' in blankContact() && 'fotoToegevoegd' in blankContact()`));
t('vergrendelen wist ook verwijderlog uit geheugen', (() => { E(`lockVault()`); return E(`state.deletions.length`) === 0 && E(`state.key`) === null; })());
t('vergrendelen reset settings naar default', E(`state.settings.bewaartermijnMaanden`) === 24);

console.log(`\n========================================\nRESULTAAT: ${pass}/${pass + fail} groen${fail ? ` — ${fail} GEFAALD` : ' — alles groen ✓'}\n========================================`);
process.exit(fail ? 1 : 0);
