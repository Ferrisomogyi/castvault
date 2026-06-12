/* ============================================================
   CastVault v0.6.1
   v0.6.1: CSP-fix — inline onclick/oninput vervangen door gedelegeerde
   listeners (Sluiten-knoppen in alle modals werkten niet op de live site).
   Chat 6 (v0.6): Wikipedia-zoekfix (zoek-API-fallback, hoofdletter-
   ongevoelig) + anti-hallucinatie bio (waarschuwing in review-modal,
   geboortejaar-context naar Worker; prompt-verharding zit in worker.js).
   Chat 1 (v0.1): crypto, IndexedDB, vCard import, fuzzy search.
   Chat 2 (v0.2): detail-scherm + tabs, edit-modus per tab,
                  handmatig nieuw contact, tags + autocomplete,
                  filters (sheet + sidebar), red flags, a11y fix,
                  per-veld auditlog.
   Chat 3 (v0.3): Wikipedia bio-import (NL->EN, review vóór opslaan),
                  TV-programma's via Claude (Worker-proxy, alles
                  "AI — ongeverifieerd" tot menselijke check),
                  bio + tvProgrammas bewerkbaar, encrypted
                  export/import (.castvault), CSP-uitbreiding.
   Chat 5 (v0.5): bewaartermijn-signalering (AVG opslagbeperking, art. 5)
   — instelbare termijn (default 24 mnd), signaleringslijst + badge,
   expliciete bewaar-beoordeling met auditregel. Plus overdracht-gereed.
   Chat 4 (v0.4): AVG-laag — dossier-export per contact (inzagerecht),
                  globale auditlog-UI (filteren/zoeken/CSV-export),
                  vergeetrecht-flow (geanonimiseerde tombstone),
                  foto's (gecomprimeerd ±200KB, versleuteld, mee in
                  export), biometric unlock (WebAuthn PRF + fallback).
   ============================================================ */

const PBKDF2_ITERATIONS = 250000;
const SALT_LEN = 16;
const IV_LEN = 12;

/* AI-proxy: Cloudflare Worker (API-key staat ALLEEN daar, nooit in de client) */
const WORKER_URL = 'https://castvault.ferencsomogyi.workers.dev';

const enc = new TextEncoder();
const dec = new TextDecoder();

function randBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function encryptJSON(key, obj) {
  const iv = randBytes(IV_LEN);
  const plaintext = enc.encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: b64(iv), ct: b64(ciphertext) };
}
async function decryptJSON(key, blob) {
  const iv = unb64(blob.iv); const ct = unb64(blob.ct);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(plaintext));
}

const DB_NAME = 'castvault';
const DB_VERSION = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(store, k) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, k, v) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const out = [];
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else resolve(out); };
    req.onerror = () => reject(req.error);
  });
}
async function dbDelete(store, k) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const state = {
  key: null,
  contacts: new Map(),
  tagColors: {},          // tagName -> palette index 0..7
  deletions: [],          // v0.4: geanonimiseerde tombstones (vergeetrecht)
  settings: { bewaartermijnMaanden: 24 }, // v0.5: instellingen (versleuteld in meta)
  searchQuery: '',
  filters: emptyFilters(),
  currentId: null,
  activeTab: 'profiel',
  editing: false,
  autoLockTimer: null,
  AUTO_LOCK_MS: 5 * 60 * 1000,
};

function emptyFilters() {
  return { ageMin: null, ageMax: null, castingType: new Set(), sporten: new Set(), talenten: new Set(),
           strategischDenken: 0, socialeDynamiek: 0, cameraComfort: 0 };
}

/* ---------- option lists ---------- */
const GESLACHT = ['', 'Man', 'Vrouw', 'Non-binair', 'Anders'];
const POSTUUR = ['', 'Tenger', 'Slank', 'Atletisch', 'Gemiddeld', 'Stevig', 'Gespierd'];
const CASTING_TYPES = ['', 'Hoofdrol', 'Bijrol', 'Reality / spelshow', 'Presentatie', 'Figurant', 'Stem', 'Model', 'Expert / gast', 'Anders'];
const BESCHIKBAARHEID = ['', 'Direct', 'Binnen 1 maand', 'In overleg', 'Beperkt', 'Niet beschikbaar'];
const PALETTE_NAMES = ['Goud', 'Groen', 'Blauw', 'Paars', 'Oranje', 'Rood', 'Cyaan', 'Grijs'];

/* ---------- auth (v0.1) ---------- */
async function isFirstRun() { return !(await dbGet('meta', 'auth')); }

async function setupVault(password) {
  const salt = randBytes(SALT_LEN);
  const key = await deriveKey(password, salt);
  const verifier = await encryptJSON(key, { v: 'castvault-ok', ts: Date.now() });
  await dbPut('meta', 'auth', { salt: b64(salt), iter: PBKDF2_ITERATIONS, verifier, created: new Date().toISOString() });
  state.key = key;
}
async function unlockVault(password) {
  const meta = await dbGet('meta', 'auth');
  if (!meta) throw new Error('Geen vault gevonden');
  const key = await deriveKey(password, unb64(meta.salt));
  try { await decryptJSON(key, meta.verifier); state.key = key; return true; }
  catch (e) { return false; }
}
async function loadAllContacts() {
  const entries = await dbAll('contacts');
  state.contacts.clear();
  for (const { key, value } of entries) {
    try { state.contacts.set(key, await decryptJSON(state.key, value)); }
    catch (e) { console.warn('Decrypt failed for', key); }
  }
}
async function loadTagColors() {
  const blob = await dbGet('meta', 'tagcolors');
  if (!blob) { state.tagColors = {}; return; }
  try { state.tagColors = await decryptJSON(state.key, blob); }
  catch (e) { state.tagColors = {}; }
}
async function saveTagColors() {
  const blob = await encryptJSON(state.key, state.tagColors);
  await dbPut('meta', 'tagcolors', blob);
}
async function saveContact(contact) {
  if (!contact.id) contact.id = crypto.randomUUID();
  contact.updatedAt = new Date().toISOString();
  if (!contact.createdAt) contact.createdAt = contact.updatedAt;
  const blob = await encryptJSON(state.key, contact);
  await dbPut('contacts', contact.id, blob);
  state.contacts.set(contact.id, contact);
}
async function deleteContact(id) {
  await dbDelete('contacts', id);
  state.contacts.delete(id);
}

function lockVault() {
  state.key = null; state.contacts.clear(); state.tagColors = {}; state.deletions = [];
  state.settings = { ...DEFAULT_SETTINGS };
  clearTimeout(state.autoLockTimer);
  showScreen('lock');
  document.getElementById('lock-pw').value = '';
  document.getElementById('lock-msg').textContent = '';
  refreshBioUnlockBtn();
}
/* v0.4: verwijderlog (geanonimiseerde tombstones), versleuteld in meta */
async function loadDeletions() {
  const blob = await dbGet('meta', 'deletions');
  if (!blob) { state.deletions = []; return; }
  try { state.deletions = await decryptJSON(state.key, blob); }
  catch (e) { state.deletions = []; }
}
async function saveDeletions() {
  const blob = await encryptJSON(state.key, state.deletions);
  await dbPut('meta', 'deletions', blob);
}
/* v0.5: instellingen (bewaartermijn), versleuteld in meta */
const DEFAULT_SETTINGS = { bewaartermijnMaanden: 24 };
async function loadSettings() {
  state.settings = { ...DEFAULT_SETTINGS };
  const blob = await dbGet('meta', 'settings');
  if (!blob) return;
  try {
    const s = await decryptJSON(state.key, blob);
    if (s && typeof s.bewaartermijnMaanden === 'number' && s.bewaartermijnMaanden >= 6 && s.bewaartermijnMaanden <= 120) {
      state.settings.bewaartermijnMaanden = Math.round(s.bewaartermijnMaanden);
    }
  } catch (e) { /* corrupte settings -> defaults */ }
}
async function saveSettings() {
  const blob = await encryptJSON(state.key, state.settings);
  await dbPut('meta', 'settings', blob);
}
function resetAutoLock() {
  clearTimeout(state.autoLockTimer);
  if (state.key) state.autoLockTimer = setTimeout(lockVault, state.AUTO_LOCK_MS);
}

/* ---------- vCard (v0.1) ---------- */
function unfoldVCard(text) { return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, ''); }
function decodeQuotedPrintable(s) { return s.replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function parseVCardLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const header = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1);
  const parts = header.split(';');
  const field = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('=')) { const [k, v] = p.split('='); params[k.toUpperCase()] = v; }
    else { params.TYPE = (params.TYPE ? params.TYPE + ',' : '') + p; }
  }
  let decoded = value;
  if (params.ENCODING && params.ENCODING.toUpperCase() === 'QUOTED-PRINTABLE') decoded = decodeQuotedPrintable(value);
  decoded = decoded.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  return { field, params, value: decoded };
}
function normalizePhone(p) { return p.replace(/[^\d+]/g, ''); }
function blankContact() {
  return {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(),
    naam: '', voornaam: '', achternaam: '',
    telefoon: [], email: [], adres: {},
    geboortedatum: null, organisatie: '',
    lengte_cm: null, postuur: '', geslacht: '', castingType: '', beschikbaarheid: '',
    bio: '', bioBron: '', bioLaatstOpgehaald: null, tvProgrammas: [],
    foto: null, fotoToegevoegd: null,
    agent: {}, social: {}, volgers: {},
    sporten: [], hobbys: [], talenten: [], talen: [], rijbewijs: false, paspoort: false, reisbereid: false,
    strategischDenken: 0, socialeDynamiek: 0, cameraComfort: 0,
    realityErvaring: false, bekendenInDB: '', eerderGewonnen: false, feeIndicatie: '',
    allergieen: [], fobieen: [], medisch: '', dieet: '', noGos: [],
    redFlags: [], notities: [], tags: [], auditLog: [],
  };
}
function parseVCards(text) {
  const unfolded = unfoldVCard(text);
  const cards = [];
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const endIdx = block.search(/END:VCARD/i);
    const body = endIdx >= 0 ? block.substring(0, endIdx) : block;
    const lines = body.split(/\r?\n/).filter(l => l.trim());
    const contact = blankContact();
    contact.auditLog = [{ datum: new Date().toISOString(), actie: 'import', bron: 'vCard' }];
    for (const raw of lines) {
      const parsed = parseVCardLine(raw);
      if (!parsed) continue;
      const { field, params, value } = parsed;
      if (field === 'FN') contact.naam = value.trim();
      else if (field === 'N') { const np = value.split(';'); contact.achternaam = (np[0] || '').trim(); contact.voornaam = (np[1] || '').trim(); }
      else if (field === 'TEL') contact.telefoon.push({ label: params.TYPE || '', nummer: normalizePhone(value) });
      else if (field === 'EMAIL') contact.email.push({ label: params.TYPE || '', adres: value.trim() });
      else if (field === 'ADR') { const a = value.split(';'); contact.adres = { straat: (a[2] || '').trim(), postcode: (a[5] || '').trim(), woonplaats: (a[3] || '').trim(), land: (a[6] || '').trim() }; }
      else if (field === 'BDAY') contact.geboortedatum = value.trim();
      else if (field === 'ORG') contact.organisatie = value.replace(/;/g, ' - ').trim();
      else if (field === 'NOTE') { if (value.trim()) contact.notities.push({ datum: new Date().toISOString(), tekst: value.trim() }); }
    }
    if (!contact.naam) contact.naam = (contact.voornaam + ' ' + contact.achternaam).trim() || 'Onbekend';
    if (contact.naam !== 'Onbekend' || contact.telefoon.length || contact.email.length) cards.push(contact);
  }
  return cards;
}

/* ---------- helpers ---------- */
function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function set(obj, path, val) {
  const keys = path.split('.'); let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = val;
}
function initials(naam) {
  const parts = (naam || '').trim().split(/\s+/);
  if (!parts[0]) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
/* v0.4: foto-veilige avatar — alleen data:image/-URL's worden gerenderd (XSS-bescherming bij import van vreemde bestanden) */
function safePhotoSrc(c) { return (typeof c.foto === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(c.foto)) ? c.foto : null; }
function avatarInnerHtml(c) {
  const src = safePhotoSrc(c);
  return src ? `<img src="${src}" alt="">` : escapeHtml(initials(c.naam));
}
function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleDateString('nl-NL', { day:'2-digit', month:'short', year:'numeric' }); }
function fmtDateTime(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleString('nl-NL', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function todayISODate() { return new Date().toISOString().slice(0, 10); }

function computeAge(geboortedatum) {
  if (!geboortedatum) return null;
  let y, m, d;
  let s = String(geboortedatum).trim();
  let mt;
  if ((mt = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else return null;
  if (!y || y < 1900) return null;
  const today = new Date();
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}
function asArray(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
function csvToArray(s) { return s.split(',').map(x => x.trim()).filter(Boolean); }

/* ---------- tag colors ---------- */
function tagColorVar(name) {
  let idx = state.tagColors[name];
  if (idx == null) { // deterministic fallback
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    idx = h % 8;
  }
  return `var(--tag-${(idx % 8) + 1})`;
}
function allKnownTags() {
  const set2 = new Set();
  for (const c of state.contacts.values()) for (const t of c.tags || []) set2.add(t);
  return Array.from(set2).sort((a, b) => a.localeCompare(b, 'nl'));
}
function tagChipHtml(name, removable) {
  const col = tagColorVar(name);
  return `<span class="tag-chip" style="color:${col}" data-tag="${escapeHtml(name)}">${escapeHtml(name)}${removable ? '<span class="x" data-remove-tag="'+escapeHtml(name)+'">✕</span>' : ''}</span>`;
}

/* ---------- search + filter ---------- */
function searchContacts(query) {
  const q = query.trim().toLowerCase();
  let all = Array.from(state.contacts.values());
  all = all.filter(passesFilters);
  if (!q) return all.sort((a, b) => (a.naam || '').localeCompare(b.naam || '', 'nl'));
  const matches = [];
  for (const c of all) {
    let score = 0;
    const naam = (c.naam || '').toLowerCase();
    if (naam === q) score += 100; else if (naam.startsWith(q)) score += 50; else if (naam.includes(q)) score += 20;
    const qNum = q.replace(/[^\d+]/g, ''); // v0.5.3: lege nummer-query matchte ALLES (bug: ''.includes geeft altijd true)
    if (qNum.length >= 2) for (const t of c.telefoon || []) if (t.nummer.includes(qNum)) score += 15;
    for (const e of c.email || []) if ((e.adres || '').toLowerCase().includes(q)) score += 15;
    for (const tag of c.tags || []) if (tag.toLowerCase().includes(q)) score += 10;
    if ((c.bio || '').toLowerCase().includes(q)) score += 5;
    for (const p of c.tvProgrammas || []) if ((p.titel || '').toLowerCase().includes(q)) score += 8;
    if (score > 0) matches.push({ c, score });
  }
  return matches.sort((a, b) => b.score - a.score).map(m => m.c);
}
function passesFilters(c) {
  const f = state.filters;
  if (f.ageMin != null || f.ageMax != null) {
    const age = computeAge(c.geboortedatum);
    if (age == null) return false;
    if (f.ageMin != null && age < f.ageMin) return false;
    if (f.ageMax != null && age > f.ageMax) return false;
  }
  if (f.castingType.size && !f.castingType.has(c.castingType)) return false;
  if (f.sporten.size) { const s = new Set((c.sporten || []).map(x => x.toLowerCase())); for (const want of f.sporten) if (!s.has(want.toLowerCase())) return false; }
  if (f.talenten.size) { const s = new Set((c.talenten || []).map(x => x.toLowerCase())); for (const want of f.talenten) if (!s.has(want.toLowerCase())) return false; }
  for (const key of ['strategischDenken', 'socialeDynamiek', 'cameraComfort']) if (f[key] > 0 && (c[key] || 0) < f[key]) return false;
  return true;
}
function activeFilterCount() {
  const f = state.filters; let n = 0;
  if (f.ageMin != null || f.ageMax != null) n++;
  if (f.castingType.size) n++;
  if (f.sporten.size) n++;
  if (f.talenten.size) n++;
  for (const k of ['strategischDenken', 'socialeDynamiek', 'cameraComfort']) if (f[k] > 0) n++;
  return n;
}

/* ---------- UI plumbing ---------- */
function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  document.getElementById('screen-' + name).classList.add('active');
}
function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}
function openModal(id) {
  /* v0.5.1: nooit twee modals tegelijk — voorkomt 'sluiten doet niets'-verwarring */
  document.querySelectorAll('.modal-backdrop.active').forEach(b => { if (b.id !== id) b.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
window.openModal = openModal; window.closeModal = closeModal;

/* ---------- contact list ---------- */
function renderContacts() {
  refreshRetentieBadge(); // v0.5: signalering meebewegen met elke lijst-render
  const list = document.getElementById('contact-list');
  const results = searchContacts(state.searchQuery);
  const fcount = activeFilterCount();
  document.getElementById('stat-count').textContent = results.length;
  document.getElementById('stat-label').textContent = (fcount || state.searchQuery) ? ('van ' + state.contacts.size) : (state.contacts.size === 1 ? 'contact' : 'contacten');
  document.getElementById('clear-filters').style.display = fcount ? 'inline' : 'none';
  const badge = document.getElementById('filter-badge');
  badge.style.display = fcount ? 'flex' : 'none'; badge.textContent = fcount;

  if (state.contacts.size === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">∅</div>
        <div class="empty-state-title">Lege vault</div>
        <div class="empty-state-text">Importeer je iPhone-contacten om te beginnen.<br>Of voeg er één met de hand toe (+).</div>
        <button class="btn-primary" style="max-width:240px;margin:0 auto;" data-open-modal="modal-import">Importeer .vcf</button>
      </div>`;
    return;
  }
  if (results.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-text">Geen resultaten${fcount ? ' met deze filters' : ''}${state.searchQuery ? ' voor "'+escapeHtml(state.searchQuery)+'"' : ''}.</div></div>`;
    return;
  }
  list.innerHTML = results.map(c => {
    const sub = (c.telefoon?.[0]?.nummer) || (c.email?.[0]?.adres) || c.organisatie || '—';
    const hasRedFlag = (c.redFlags || []).some(r => r.kleur === 'rood');
    const tags = (c.tags || []).slice(0, 4).map(t => tagChipHtml(t, false)).join('');
    return `
      <div class="contact-card" data-id="${c.id}">
        <div class="avatar">${avatarInnerHtml(c)}</div>
        <div class="contact-meta">
          <div class="contact-name">${escapeHtml(c.naam)}</div>
          <div class="contact-sub">${escapeHtml(sub)}</div>
          ${tags ? `<div class="card-tags">${tags}</div>` : ''}
        </div>
        ${hasRedFlag ? '<div class="red-flag-dot" title="Red flag"></div>' : ''}
      </div>`;
  }).join('');
  for (const card of list.querySelectorAll('.contact-card')) {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  }
}

/* ============================================================
   DETAIL SCHERM
   ============================================================ */
const TABS = [
  { id: 'profiel', label: 'Profiel' },
  { id: 'carriere', label: 'Carrière' },
  { id: 'casting', label: 'Casting' },
  { id: 'bijzonderheden', label: 'Bijzonderheden' },
  { id: 'redflags', label: 'Red Flags' },
  { id: 'notities', label: 'Notities' },
  { id: 'audit', label: 'Audit' },
];

// scalar field schema per tab (composites handled separately)
const FIELDS = {
  profiel: [
    { p: 'voornaam', l: 'Voornaam', t: 'text' },
    { p: 'achternaam', l: 'Achternaam', t: 'text' },
    { p: 'geslacht', l: 'Geslacht', t: 'select', o: GESLACHT },
    { p: 'geboortedatum', l: 'Geboortedatum', t: 'date' },
    { p: 'lengte_cm', l: 'Lengte (cm)', t: 'number' },
    { p: 'postuur', l: 'Postuur', t: 'select', o: POSTUUR },
    { p: 'organisatie', l: 'Organisatie', t: 'text' },
    { p: 'talen', l: 'Talen', t: 'multistring' },
    { p: 'sporten', l: 'Sporten', t: 'multistring' },
    { p: 'hobbys', l: 'Hobby’s', t: 'multistring' },
    { p: 'talenten', l: 'Talenten', t: 'multistring' },
    { p: 'rijbewijs', l: 'Rijbewijs', t: 'bool' },
    { p: 'paspoort', l: 'Geldig paspoort', t: 'bool' },
    { p: 'reisbereid', l: 'Reisbereid', t: 'bool' },
  ],
  carriere: [
    { p: 'agent.naam', l: 'Agent — naam', t: 'text' },
    { p: 'agent.bureau', l: 'Agent — bureau', t: 'text' },
    { p: 'agent.telefoon', l: 'Agent — telefoon', t: 'text' },
    { p: 'agent.email', l: 'Agent — email', t: 'text' },
    { p: 'social.instagram', l: 'Instagram', t: 'text' },
    { p: 'social.tiktok', l: 'TikTok', t: 'text' },
    { p: 'social.youtube', l: 'YouTube', t: 'text' },
    { p: 'social.x', l: 'X / Twitter', t: 'text' },
    { p: 'social.linkedin', l: 'LinkedIn', t: 'text' },
    { p: 'volgers.instagram', l: 'Volgers Instagram', t: 'number' },
    { p: 'volgers.tiktok', l: 'Volgers TikTok', t: 'number' },
    { p: 'volgers.youtube', l: 'Volgers YouTube', t: 'number' },
  ],
  casting: [
    { p: 'castingType', l: 'Casting type', t: 'select', o: CASTING_TYPES },
    { p: 'beschikbaarheid', l: 'Beschikbaarheid', t: 'select', o: BESCHIKBAARHEID },
    { p: 'strategischDenken', l: 'Strategisch denken', t: 'slider' },
    { p: 'socialeDynamiek', l: 'Sociale dynamiek', t: 'slider' },
    { p: 'cameraComfort', l: 'Camera-comfort', t: 'slider' },
    { p: 'realityErvaring', l: 'Reality-ervaring', t: 'bool' },
    { p: 'eerderGewonnen', l: 'Eerder gewonnen', t: 'bool' },
    { p: 'bekendenInDB', l: 'Bekenden in DB', t: 'text' },
    { p: 'feeIndicatie', l: 'Fee-indicatie', t: 'text' },
  ],
  bijzonderheden: [
    { p: 'allergieen', l: 'Allergieën', t: 'multistring' },
    { p: 'fobieen', l: 'Fobieën', t: 'multistring' },
    { p: 'dieet', l: 'Dieet', t: 'text' },
    { p: 'noGos', l: 'No-go’s', t: 'multistring' },
    { p: 'medisch', l: 'Medisch / overig', t: 'textarea' },
  ],
};

function currentContact() { return state.contacts.get(state.currentId); }

function openDetail(id) {
  state.currentId = id; state.activeTab = 'profiel'; state.editing = false;
  showScreen('detail');
  renderDetailHero();
  renderTabbar();
  renderTab();
  document.getElementById('detail-body').scrollTop = 0;
}
function backToList() {
  state.currentId = null; state.editing = false;
  showScreen('main'); renderContacts();
}
function renderDetailHero() {
  const c = currentContact(); if (!c) return;
  const av = document.getElementById('detail-avatar');
  av.innerHTML = avatarInnerHtml(c) + `<button type="button" class="avatar-cam" id="btn-foto" title="${c.foto ? 'Foto bekijken / wijzigen' : 'Foto toevoegen'}" aria-label="Foto">+</button>`;
  document.getElementById('btn-foto').addEventListener('click', (e) => { e.stopPropagation(); openFotoModal(); });
  document.getElementById('detail-name').textContent = c.naam || 'Naamloos';
  const sub = [c.castingType, c.organisatie].filter(Boolean).join(' · ') || (c.telefoon?.[0]?.nummer || '');
  document.getElementById('detail-sub').textContent = sub;
  document.getElementById('detail-tags').innerHTML = (c.tags || []).map(t => tagChipHtml(t, false)).join('');
}
function renderTabbar() {
  const c = currentContact();
  const bar = document.getElementById('tabbar');
  bar.innerHTML = TABS.map(t => {
    let dot = '';
    if (t.id === 'redflags' && (c.redFlags || []).length) dot = '<span class="tab-dot" style="background:var(--' + (((c.redFlags||[]).some(r=>r.kleur==='rood'))?'danger':'warn') + ')"></span>';
    return `<button class="tab ${t.id === state.activeTab ? 'active' : ''}" data-tab="${t.id}">${t.label}${dot}</button>`;
  }).join('');
  for (const b of bar.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      if (state.editing) { if (!confirm('Je bewerkt nu. Wijzigingen kwijtraken?')) return; state.editing = false; }
      state.activeTab = b.dataset.tab; renderTabbar(); renderTab();
      document.getElementById('detail-body').scrollTop = 0;
    });
  }
}

function tabTitle(id) { return TABS.find(t => t.id === id).label; }

function renderTab() {
  const c = currentContact(); if (!c) return;
  const body = document.getElementById('detail-body');
  const tab = state.activeTab;
  const editable = !['audit'].includes(tab);
  let head = `<div class="tab-head"><h3>${tabTitle(tab)}</h3>`;
  if (editable && !state.editing) head += `<button class="edit-toggle" id="btn-edit"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>Bewerk</button>`;
  head += `</div>`;

  if (state.editing) { body.innerHTML = head + renderEdit(tab, c); wireEdit(tab); return; }

  let inner = '';
  if (tab === 'redflags') inner = renderRedflagsRead(c);
  else if (tab === 'notities') inner = renderNotitiesRead(c);
  else if (tab === 'audit') inner = renderAuditRead(c);
  else inner = renderRead(tab, c);
  body.innerHTML = head + inner;

  if (!state.editing && editable) document.getElementById('btn-edit').addEventListener('click', () => { state.editing = true; renderTab(); });
  if (tab === 'redflags') wireRedflagAdd();
  if (tab === 'notities') wireNotitieAdd();
  if (tab === 'carriere') wireCarriereRead();
}

/* ----- READ renderers ----- */
function valueHtml(f, c) {
  let v = get(c, f.p);
  if (f.t === 'bool') return v ? '<span style="color:var(--success)">Ja</span>' : '<span class="fr-value empty">—</span>';
  if (f.t === 'slider') { v = v || 0; return v ? `${'●'.repeat(v)}<span style="color:var(--text-dim)">${'○'.repeat(5-v)}</span> <span style="color:var(--text-dim)">${v}/5</span>` : '<span class="fr-value empty">—</span>'; }
  if (f.t === 'multistring') { const arr = asArray(v); return arr.length ? arr.map(x => `<span class="fr-pill">${escapeHtml(x)}</span>`).join('') : '<span class="fr-value empty">—</span>'; }
  if (f.t === 'date') return v ? `${escapeHtml(fmtDate(v.length<=10&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:v))}${computeAge(v)!=null?` · ${computeAge(v)} jr`:''}` : '<span class="fr-value empty">—</span>';
  if (f.t === 'number') return (v || v === 0) && v !== '' ? escapeHtml(String(v)) : '<span class="fr-value empty">—</span>';
  return v ? escapeHtml(v) : '<span class="fr-value empty">—</span>';
}
function rowHtml(label, valueHtmlStr) {
  return `<div class="field-row"><div class="fr-label">${escapeHtml(label)}</div><div class="fr-value">${valueHtmlStr}</div></div>`;
}
function renderRead(tab, c) {
  let html = '';
  if (tab === 'profiel') {
    html += rowHtml('Telefoon', (c.telefoon||[]).length ? c.telefoon.map(t => `<div>${escapeHtml(t.nummer)}${t.label?` <span style="color:var(--text-dim)">(${escapeHtml(t.label)})</span>`:''}</div>`).join('') : '<span class="fr-value empty">—</span>');
    html += rowHtml('Email', (c.email||[]).length ? c.email.map(e => `<div>${escapeHtml(e.adres)}${e.label?` <span style="color:var(--text-dim)">(${escapeHtml(e.label)})</span>`:''}</div>`).join('') : '<span class="fr-value empty">—</span>');
    const a = c.adres || {}; const addr = [a.straat, [a.postcode, a.woonplaats].filter(Boolean).join(' '), a.land].filter(Boolean).join(', ');
    html += rowHtml('Adres', addr ? escapeHtml(addr) : '<span class="fr-value empty">—</span>');
  }
  for (const f of FIELDS[tab]) html += rowHtml(f.l, valueHtml(f, c));
  if (tab === 'carriere') {
    html += `<div class="section-sub">Biografie</div>`;
    if (c.bio) {
      html += `<div class="bio-text">${escapeHtml(c.bio)}</div>`;
      const meta = [];
      if (c.bioBron) meta.push('Bron: ' + escapeHtml(c.bioBron));
      if (c.bioLaatstOpgehaald) meta.push('Opgehaald: ' + escapeHtml(fmtDateTime(c.bioLaatstOpgehaald)));
      if (meta.length) html += `<div class="bio-meta">${meta.join(' · ')}</div>`;
    } else {
      html += `<div class="empty-inline">Nog geen bio.</div>`;
    }
    html += `<button type="button" class="btn-inline" id="btn-fetch-bio">↓ Bio ophalen (Wikipedia)</button>`;
    html += `<div class="section-sub">TV-programma's</div>`;
    const tv = c.tvProgrammas || [];
    if (tv.length) {
      html += tv.map((p, i) => `
        <div class="tv-card">
          <div class="tv-main"><strong>${escapeHtml(p.titel)}</strong>${p.jaar ? ` <span class="tv-jaar">(${escapeHtml(String(p.jaar))})</span>` : ''}
            <div class="tv-sub">${[p.rol, p.zender].filter(Boolean).map(escapeHtml).join(' · ') || '—'}</div></div>
          ${p.geverifieerd
            ? '<span class="tv-badge ok">geverifieerd</span>'
            : `<span class="tv-badge unv">${escapeHtml(p.bron || 'ongeverifieerd')}</span><button type="button" class="tv-verify" data-verify-tv="${i}" title="Markeer als door jou gecontroleerd">✓ check</button>`}
        </div>`).join('');
    } else {
      html += `<div class="empty-inline">Nog geen programma's.</div>`;
    }
    html += `<button type="button" class="btn-inline" id="btn-fetch-tv">✦ TV-programma's zoeken (AI)</button>`;
  }
  return html;
}

/* ----- EDIT renderers ----- */
function efId(p) { return 'ef-' + p.replace(/\./g, '_'); }
function editScalar(f, c) {
  const id = efId(f.p); const v = get(c, f.p);
  if (f.t === 'bool') {
    return `<div class="toggle-field"><span>${escapeHtml(f.l)}</span>
      <label class="toggle"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}><span class="track"></span></label></div>`;
  }
  if (f.t === 'slider') {
    const val = v || 0;
    return `<div class="slider-field"><div class="slider-top"><label for="${id}">${escapeHtml(f.l)}</label><span class="slider-val" id="${id}-val">${val ? val + '/5' : '—'}</span></div>
      <input type="range" id="${id}" min="0" max="5" step="1" value="${val}" data-slider></div>`;
  }
  let field;
  if (f.t === 'select') field = `<select id="${id}">${f.o.map(o => `<option value="${escapeHtml(o)}" ${String(v||'')===o?'selected':''}>${o===''?'— kies —':escapeHtml(o)}</option>`).join('')}</select>`;
  else if (f.t === 'textarea') field = `<textarea id="${id}">${escapeHtml(v||'')}</textarea>`;
  else if (f.t === 'multistring') field = `<input type="text" id="${id}" value="${escapeHtml(asArray(v).join(', '))}"><div class="hint">Scheid met komma’s</div>`;
  else if (f.t === 'number') field = `<input type="number" id="${id}" value="${v==null||v===''?'':escapeHtml(String(v))}" inputmode="numeric">`;
  else if (f.t === 'date') field = `<input type="text" id="${id}" value="${escapeHtml(v||'')}" placeholder="JJJJ-MM-DD"><div class="hint">Formaat JJJJ-MM-DD</div>`;
  else field = `<input type="text" id="${id}" value="${escapeHtml(v||'')}">`;
  return `<div class="edit-field"><label for="${id}">${escapeHtml(f.l)}</label>${field}</div>`;
}
function renderMultiEntry(kind, c) {
  // kind: 'telefoon' (label,nummer) or 'email' (label,adres)
  const arr = c[kind] || [];
  const valKey = kind === 'telefoon' ? 'nummer' : 'adres';
  const rows = arr.map((item, i) => `
    <div class="multi-entry" data-kind="${kind}" data-i="${i}">
      <input class="lbl" type="text" placeholder="label" value="${escapeHtml(item.label||'')}" data-field="label">
      <input type="text" placeholder="${kind==='telefoon'?'+31...':'naam@mail.nl'}" value="${escapeHtml(item[valKey]||'')}" data-field="${valKey}">
      <button type="button" class="mini-btn" data-del-multi="${kind}:${i}">✕</button>
    </div>`).join('');
  return `<div class="edit-field"><label>${kind==='telefoon'?'Telefoon':'Email'}</label>
    <div id="multi-${kind}">${rows}</div>
    <button type="button" class="add-line" data-add-multi="${kind}">+ ${kind==='telefoon'?'Nummer':'Email'} toevoegen</button></div>`;
}
function renderEdit(tab, c) {
  let html = '';
  if (tab === 'profiel') {
    html += `<div class="edit-row-2">${editScalar(FIELDS.profiel[0], c)}${editScalar(FIELDS.profiel[1], c)}</div>`;
    html += `<div class="edit-row-2">${editScalar(FIELDS.profiel[2], c)}${editScalar(FIELDS.profiel[3], c)}</div>`;
    html += `<div class="edit-row-2">${editScalar(FIELDS.profiel[4], c)}${editScalar(FIELDS.profiel[5], c)}</div>`;
    html += editScalar(FIELDS.profiel[6], c); // organisatie
    html += renderMultiEntry('telefoon', c);
    html += renderMultiEntry('email', c);
    // adres
    const a = c.adres || {};
    html += `<div class="edit-field"><label>Adres</label>
      <div class="edit-field" style="margin-bottom:8px"><input type="text" id="ef-adres_straat" placeholder="Straat + nr" value="${escapeHtml(a.straat||'')}"></div>
      <div class="edit-row-2"><div class="edit-field" style="margin:0"><input type="text" id="ef-adres_postcode" placeholder="Postcode" value="${escapeHtml(a.postcode||'')}"></div>
      <div class="edit-field" style="margin:0"><input type="text" id="ef-adres_woonplaats" placeholder="Woonplaats" value="${escapeHtml(a.woonplaats||'')}"></div></div>
      <div class="edit-field" style="margin-top:8px;margin-bottom:0"><input type="text" id="ef-adres_land" placeholder="Land" value="${escapeHtml(a.land||'')}"></div></div>`;
    for (const f of FIELDS.profiel.slice(7, 11)) html += editScalar(f, c); // talen, sporten, hobbys, talenten
    html += `<div class="section-sub">Eigenschappen</div>`;
    for (const f of FIELDS.profiel.slice(11)) html += editScalar(f, c); // bools
    html += `<div class="section-sub">Tags</div>` + renderTagEditor(c);
  } else if (tab === 'carriere') {
    html += `<div class="section-sub">Agent</div>`;
    for (const f of FIELDS.carriere.slice(0, 4)) html += editScalar(f, c);
    html += `<div class="section-sub">Social</div>`;
    for (const f of FIELDS.carriere.slice(4, 9)) html += editScalar(f, c);
    html += `<div class="section-sub">Volgers</div><div class="edit-row-3">`;
    for (const f of FIELDS.carriere.slice(9)) html += editScalar(f, c);
    html += `</div>`;
    html += `<div class="section-sub">Biografie</div>
      <div class="edit-field"><label for="ef-bio">Bio</label><textarea id="ef-bio" style="min-height:120px">${escapeHtml(c.bio || '')}</textarea>
      <div class="hint">Handmatig wijzigen zet de bron op "Handmatig".</div></div>`;
    html += `<div class="section-sub">TV-programma's</div><div id="tv-rows">` +
      (c.tvProgrammas || []).map((p, i) => tvRowHtml(p, i)).join('') +
      `</div><button type="button" class="add-line" id="btn-add-tv">+ Programma toevoegen</button>
      <div class="hint" style="margin-top:5px">Titel · jaar · rol · zender. AI-items houden hun "ongeverifieerd"-label tot je ze afvinkt in de leesweergave.</div>`;
  } else if (tab === 'casting') {
    html += `<div class="edit-row-2">${editScalar(FIELDS.casting[0], c)}${editScalar(FIELDS.casting[1], c)}</div>`;
    html += `<div class="section-sub">Inschatting (0–5)</div>`;
    for (const f of FIELDS.casting.slice(2, 5)) html += editScalar(f, c);
    html += `<div class="section-sub">Overig</div>`;
    for (const f of FIELDS.casting.slice(5)) html += editScalar(f, c);
  } else if (tab === 'bijzonderheden') {
    for (const f of FIELDS.bijzonderheden) html += editScalar(f, c);
  }
  html += `<div class="edit-actions">
    <button class="btn-primary btn-secondary" id="btn-cancel" style="flex:1">Annuleer</button>
    <button class="btn-primary" id="btn-save" style="flex:1">Opslaan</button></div>`;
  return html;
}

/* ----- TV-PROGRAMMA'S EDITOR (v0.3) ----- */
function tvRowHtml(p, i) {
  return `<div class="tv-edit-row" data-tv-i="${i}">
    <input type="text" placeholder="Titel" value="${escapeHtml(p.titel || '')}" data-tvf="titel" aria-label="Titel">
    <input type="text" placeholder="Jaar" value="${escapeHtml(String(p.jaar || ''))}" data-tvf="jaar" aria-label="Jaar">
    <input type="text" placeholder="Rol" value="${escapeHtml(p.rol || '')}" data-tvf="rol" aria-label="Rol">
    <input type="text" placeholder="Zender" value="${escapeHtml(p.zender || '')}" data-tvf="zender" aria-label="Zender">
    <button type="button" class="mini-btn" data-del-tv="${i}" aria-label="Verwijder programma">✕</button>
  </div>`;
}
function collectTvInto(c, keepEmpty) {
  const cont = document.getElementById('tv-rows'); if (!cont) return;
  const arr = [];
  cont.querySelectorAll('.tv-edit-row').forEach(r => {
    const oud = (c.tvProgrammas || [])[+r.dataset.tvI] || {};
    const v = f => r.querySelector(`[data-tvf="${f}"]`).value.trim();
    const row = {
      titel: v('titel'), jaar: v('jaar'), rol: v('rol'), zender: v('zender'),
      bron: oud.bron || 'Handmatig',
      geverifieerd: oud.bron ? !!oud.geverifieerd : true,
      opgehaald: oud.opgehaald || null,
    };
    // tijdens het bewerken lege rijen bewaren (indexen blijven kloppen); pas bij opslaan droppen
    if (keepEmpty || row.titel || row.rol || row.zender) arr.push(row);
  });
  c.tvProgrammas = arr;
}

/* ----- TAG EDITOR ----- */
function renderTagEditor(c) {
  const chips = (c.tags || []).map(t => tagChipHtml(t, true)).join('');
  const swatches = PALETTE_NAMES.map((nm, i) => `<div class="swatch" data-color="${i}" title="${nm}" style="background:var(--tag-${i+1})"></div>`).join('');
  return `<div class="tag-editor" id="tag-editor">
    <div class="tag-input-wrap" id="tag-chips">${chips}<input type="text" id="tag-input" placeholder="Tag typen…" autocomplete="off"></div>
    <div class="autocomplete" id="tag-ac"></div>
    <div style="font-size:11px;color:var(--text-dim);margin-top:10px">Kleur voor nieuwe tag (klik ook een tag om die te herkleuren):</div>
    <div class="palette" id="tag-palette">${swatches}</div>
  </div>`;
}
const tagEdit = { activeColor: 0, selectedTag: null };
function wireTagEditor() {
  const c = currentContact();
  if (!c.tags) c.tags = [];
  const input = document.getElementById('tag-input');
  const ac = document.getElementById('tag-ac');
  const palette = document.getElementById('tag-palette');
  const chipsWrap = document.getElementById('tag-chips');
  if (!input) return;
  tagEdit.selectedTag = null;
  function refreshPaletteSel() {
    for (const sw of palette.querySelectorAll('.swatch')) sw.classList.toggle('sel', +sw.dataset.color === tagEdit.activeColor);
  }
  refreshPaletteSel();
  function redrawChips() {
    chipsWrap.querySelectorAll('.tag-chip').forEach(n => n.remove());
    const frag = document.createElement('div');
    frag.innerHTML = (c.tags || []).map(t => tagChipHtml(t, true)).join('');
    Array.from(frag.children).forEach(ch => {
      if (c.tags.includes(ch.dataset.tag) && tagEdit.selectedTag === ch.dataset.tag) ch.style.outline = '2px solid var(--text)';
      chipsWrap.insertBefore(ch, input);
    });
    renderDetailHero();
  }
  function addTag(name, colorIdx) {
    name = name.trim(); if (!name) return;
    if (!c.tags.includes(name)) c.tags.push(name);
    if (colorIdx != null) state.tagColors[name] = colorIdx;
    else if (state.tagColors[name] == null) state.tagColors[name] = tagEdit.activeColor;
    input.value = ''; ac.classList.remove('show'); redrawChips();
  }
  function showAC() {
    const q = input.value.trim().toLowerCase();
    const known = allKnownTags().filter(t => !c.tags.includes(t) && (!q || t.toLowerCase().includes(q)));
    let items = known.map(t => `<div class="ac-item" data-tag="${escapeHtml(t)}"><span class="color-dot" style="background:${tagColorVar(t)}"></span>${escapeHtml(t)}</div>`);
    if (q && !allKnownTags().some(t => t.toLowerCase() === q) && !c.tags.some(t => t.toLowerCase() === q))
      items.unshift(`<div class="ac-item" data-new="${escapeHtml(input.value.trim())}"><span class="color-dot" style="background:var(--tag-${tagEdit.activeColor+1})"></span>Nieuw: “${escapeHtml(input.value.trim())}”</div>`);
    if (!items.length) { ac.classList.remove('show'); return; }
    ac.innerHTML = items.join(''); ac.classList.add('show');
    for (const it of ac.querySelectorAll('.ac-item')) it.addEventListener('mousedown', e => {
      e.preventDefault();
      if (it.dataset.new != null) addTag(it.dataset.new, tagEdit.activeColor);
      else addTag(it.dataset.tag, null);
    });
  }
  input.addEventListener('input', showAC);
  input.addEventListener('focus', showAC);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.value.trim()) addTag(input.value.trim(), tagEdit.activeColor); }
    else if (e.key === 'Backspace' && !input.value && c.tags.length) { c.tags.pop(); redrawChips(); }
  });
  input.addEventListener('blur', () => setTimeout(() => ac.classList.remove('show'), 150));
  chipsWrap.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove-tag]');
    if (rm) { const n = rm.dataset.removeTag; c.tags = c.tags.filter(t => t !== n); if (tagEdit.selectedTag===n) tagEdit.selectedTag=null; redrawChips(); return; }
    const chip = e.target.closest('.tag-chip');
    if (chip) { tagEdit.selectedTag = (tagEdit.selectedTag === chip.dataset.tag) ? null : chip.dataset.tag; redrawChips(); }
  });
  palette.addEventListener('click', e => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    tagEdit.activeColor = +sw.dataset.color; refreshPaletteSel();
    if (tagEdit.selectedTag) { state.tagColors[tagEdit.selectedTag] = tagEdit.activeColor; redrawChips(); }
  });
}

/* ----- WIRE EDIT (save/cancel + composites) ----- */
function wireEdit(tab) {
  const body = document.getElementById('detail-body');
  // multi-entry add/del
  body.querySelectorAll('[data-add-multi]').forEach(btn => btn.addEventListener('click', () => {
    const c = currentContact(); const kind = btn.dataset.addMulti;
    collectMultiInto(c); // preserve current typing
    (c[kind] = c[kind] || []).push(kind === 'telefoon' ? { label: '', nummer: '' } : { label: '', adres: '' });
    state.editing = true; renderTab();
  }));
  body.querySelectorAll('[data-del-multi]').forEach(btn => btn.addEventListener('click', () => {
    const c = currentContact(); const [kind, i] = btn.dataset.delMulti.split(':');
    collectMultiInto(c); c[kind].splice(+i, 1); renderTab();
  }));
  if (tab === 'profiel') wireTagEditor();
  // tv-programma rijen (carrière)
  body.querySelectorAll('[data-del-tv]').forEach(btn => btn.addEventListener('click', () => {
    const c = currentContact(); collectTvInto(c, true); c.tvProgrammas.splice(+btn.dataset.delTv, 1); renderTab();
  }));
  const addTv = document.getElementById('btn-add-tv');
  if (addTv) addTv.addEventListener('click', () => {
    const c = currentContact(); collectTvInto(c, true);
    (c.tvProgrammas = c.tvProgrammas || []).push({ titel: '', jaar: '', rol: '', zender: '', bron: 'Handmatig', geverifieerd: true, opgehaald: null });
    renderTab();
  });
  const cancel = document.getElementById('btn-cancel');
  const save = document.getElementById('btn-save');
  if (cancel) cancel.addEventListener('click', async () => { await loadAllContacts(); state.editing = false; renderTab(); renderDetailHero(); renderTabbar(); });
  if (save) save.addEventListener('click', () => saveTab(tab));
}
function collectMultiInto(c) {
  for (const kind of ['telefoon', 'email']) {
    const cont = document.getElementById('multi-' + kind); if (!cont) continue;
    const valKey = kind === 'telefoon' ? 'nummer' : 'adres';
    const rows = cont.querySelectorAll('.multi-entry');
    const arr = [];
    rows.forEach(r => {
      const label = r.querySelector('[data-field="label"]').value.trim();
      let val = r.querySelector('[data-field="' + valKey + '"]').value.trim();
      if (kind === 'telefoon' && val) val = normalizePhone(val);
      if (val || label) arr.push(kind === 'telefoon' ? { label, nummer: val } : { label, adres: val });
    });
    c[kind] = arr;
  }
}

async function saveTab(tab) {
  const c = currentContact();
  const before = JSON.parse(JSON.stringify(c));
  // collect scalar fields
  const fields = FIELDS[tab] || [];
  for (const f of fields) {
    const el = document.getElementById(efId(f.p)); if (!el) continue;
    let v;
    if (f.t === 'bool') v = el.checked;
    else if (f.t === 'slider') v = +el.value;
    else if (f.t === 'number') v = el.value === '' ? null : Number(el.value);
    else if (f.t === 'multistring') v = csvToArray(el.value);
    else v = el.value.trim();
    set(c, f.p, v);
  }
  if (tab === 'profiel') {
    collectMultiInto(c);
    c.adres = {
      straat: (document.getElementById('ef-adres_straat')||{}).value?.trim() || '',
      postcode: (document.getElementById('ef-adres_postcode')||{}).value?.trim() || '',
      woonplaats: (document.getElementById('ef-adres_woonplaats')||{}).value?.trim() || '',
      land: (document.getElementById('ef-adres_land')||{}).value?.trim() || '',
    };
    // rebuild display name if first/last changed and naam was empty/auto
    const full = [c.voornaam, c.achternaam].filter(Boolean).join(' ').trim();
    if (full && (!before.naam || before.naam === 'Onbekend' || before.naam === 'Nieuw contact' || before.naam === [before.voornaam, before.achternaam].filter(Boolean).join(' ').trim())) c.naam = full;
  }
  if (tab === 'carriere') {
    const bioEl = document.getElementById('ef-bio');
    if (bioEl) {
      const nieuweBio = bioEl.value.trim();
      if (nieuweBio !== (before.bio || '')) {
        c.bio = nieuweBio;
        c.bioBron = nieuweBio ? 'Handmatig' : '';
        c.bioLaatstOpgehaald = nieuweBio ? new Date().toISOString() : null;
      }
    }
    collectTvInto(c, false);
  }
  // diff -> auditlog
  const changes = diffContact(before, c, tab);
  if (changes.length) {
    c.auditLog = c.auditLog || [];
    for (const ch of changes) c.auditLog.push({ datum: new Date().toISOString(), actie: 'wijziging', veld: ch.veld, oude: ch.oude, nieuwe: ch.nieuwe });
  }
  try {
    await saveContact(c);
    if (tab === 'profiel') await saveTagColors();
    state.editing = false;
    renderDetailHero(); renderTabbar(); renderTab();
    toast(changes.length ? `${changes.length} veld(en) opgeslagen` : 'Geen wijzigingen', changes.length ? 'success' : '');
  } catch (e) { console.error(e); toast('Opslaan mislukt: ' + e.message, 'error'); }
}

function flat(label, v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map(x => typeof x === 'object' ? Object.values(x).filter(Boolean).join(' ') : x).join(', ');
  if (typeof v === 'object') return Object.values(v).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'ja' : 'nee';
  return String(v);
}
function diffContact(before, after, tab) {
  const keysByTab = {
    profiel: ['voornaam','achternaam','naam','geslacht','geboortedatum','lengte_cm','postuur','organisatie','telefoon','email','adres','talen','sporten','hobbys','talenten','rijbewijs','paspoort','reisbereid','tags'],
    carriere: ['agent','social','volgers','bio','tvProgrammas'],
    casting: ['castingType','beschikbaarheid','strategischDenken','socialeDynamiek','cameraComfort','realityErvaring','eerderGewonnen','bekendenInDB','feeIndicatie'],
    bijzonderheden: ['allergieen','fobieen','dieet','noGos','medisch'],
  };
  const labels = { lengte_cm:'lengte', noGos:'no-go’s' };
  const out = [];
  for (const k of (keysByTab[tab] || [])) {
    const a = flat(k, before[k]); const b = flat(k, after[k]);
    if (a !== b) out.push({ veld: labels[k] || k, oude: a, nieuwe: b });
  }
  return out;
}

/* ----- RED FLAGS ----- */
function renderRedflagsRead(c) {
  const flags = c.redFlags || [];
  let html = `<div class="placeholder-note" style="margin-bottom:18px">AVG: een red flag vereist altijd een <strong>motivatie</strong>, <strong>bron</strong> en <strong>datum</strong>. Geen losse oordelen — alleen onderbouwde notities.</div>`;
  if (flags.length) {
    html += flags.map((r, i) => `
      <div class="flag-card ${escapeHtml(r.kleur)}">
        <div class="flag-head"><span class="flag-badge ${escapeHtml(r.kleur)}">${escapeHtml(r.kleur)}</span>
          <span class="flag-del" data-del-flag="${i}">verwijderen</span></div>
        <div class="flag-motiv">${escapeHtml(r.motivatie)}</div>
        <div class="flag-meta"><span>Bron: ${escapeHtml(r.bron||'—')}</span><span>Datum: ${escapeHtml(r.datum||'—')}</span>${r.geregistreerdDoor?`<span>Door: ${escapeHtml(r.geregistreerdDoor)}</span>`:''}</div>
      </div>`).join('');
  } else html += `<div style="color:var(--text-dim);font-style:italic;margin-bottom:18px">Nog geen vlaggen.</div>`;
  html += `
    <div class="section-sub">Nieuwe vlag</div>
    <div class="flag-color-pick">
      <input type="radio" name="flagkleur" id="fk-rood" value="rood"><label for="fk-rood" class="fcp-rood">Rood</label>
      <input type="radio" name="flagkleur" id="fk-oranje" value="oranje" checked><label for="fk-oranje" class="fcp-oranje">Oranje</label>
      <input type="radio" name="flagkleur" id="fk-groen" value="groen"><label for="fk-groen" class="fcp-groen">Groen</label>
    </div>
    <div class="edit-field"><label for="flag-motiv">Motivatie *</label><textarea id="flag-motiv" placeholder="Wat is er gebeurd / waarom deze vlag?"></textarea></div>
    <div class="edit-row-2">
      <div class="edit-field"><label for="flag-bron">Bron *</label><input type="text" id="flag-bron" placeholder="Wie / waar vandaan?"></div>
      <div class="edit-field"><label for="flag-datum">Datum *</label><input type="text" id="flag-datum" value="${todayISODate()}"></div>
    </div>
    <div class="edit-field"><label for="flag-door">Geregistreerd door</label><input type="text" id="flag-door" placeholder="Jouw naam (optioneel)"></div>
    <button class="btn-primary" id="btn-add-flag">Vlag toevoegen</button>`;
  return html;
}
function wireRedflagAdd() {
  const body = document.getElementById('detail-body');
  body.querySelectorAll('[data-del-flag]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('Vlag verwijderen?')) return;
    const c = currentContact(); const i = +el.dataset.delFlag;
    const removed = c.redFlags[i];
    c.redFlags.splice(i, 1);
    c.auditLog.push({ datum: new Date().toISOString(), actie: 'red flag verwijderd', veld: 'redFlags', oude: removed.kleur + ': ' + removed.motivatie, nieuwe: '' });
    await saveContact(c); renderTabbar(); renderTab(); toast('Vlag verwijderd');
  }));
  const add = document.getElementById('btn-add-flag');
  if (add) add.addEventListener('click', async () => {
    const c = currentContact();
    const kleur = (body.querySelector('input[name="flagkleur"]:checked')||{}).value || 'oranje';
    const motivatie = document.getElementById('flag-motiv').value.trim();
    const bron = document.getElementById('flag-bron').value.trim();
    const datum = document.getElementById('flag-datum').value.trim();
    const door = document.getElementById('flag-door').value.trim();
    if (!motivatie || !bron || !datum) { toast('Motivatie, bron én datum zijn verplicht', 'error'); return; }
    c.redFlags = c.redFlags || [];
    c.redFlags.push({ kleur, datum, bron, motivatie, geregistreerdDoor: door });
    c.auditLog.push({ datum: new Date().toISOString(), actie: 'red flag toegevoegd', veld: 'redFlags', oude: '', nieuwe: kleur + ': ' + motivatie });
    await saveContact(c); renderDetailHero(); renderTabbar(); renderTab(); toast('Vlag toegevoegd', 'success');
  });
}

/* ----- NOTITIES ----- */
function renderNotitiesRead(c) {
  const notes = (c.notities || []).slice().reverse();
  let html = '';
  html += `<div class="edit-field"><label for="note-new">Nieuwe notitie</label><textarea id="note-new" placeholder="Vrije notitie…"></textarea></div>
    <button class="btn-primary" id="btn-add-note" style="margin-bottom:20px">Notitie toevoegen</button>`;
  if (notes.length) html += notes.map((n) => {
    const realIdx = c.notities.indexOf(n);
    return `<div class="note-card"><span class="note-del" data-del-note="${realIdx}">verwijderen</span><div class="note-date">${escapeHtml(fmtDateTime(n.datum))}</div><div class="note-text">${escapeHtml(n.tekst)}</div></div>`;
  }).join('');
  else html += `<div style="color:var(--text-dim);font-style:italic">Nog geen notities.</div>`;
  return html;
}
function wireNotitieAdd() {
  const body = document.getElementById('detail-body');
  const add = document.getElementById('btn-add-note');
  if (add) add.addEventListener('click', async () => {
    const c = currentContact();
    const txt = document.getElementById('note-new').value.trim();
    if (!txt) { toast('Lege notitie', 'error'); return; }
    c.notities = c.notities || [];
    c.notities.push({ datum: new Date().toISOString(), tekst: txt });
    c.auditLog.push({ datum: new Date().toISOString(), actie: 'notitie toegevoegd', veld: 'notities', oude: '', nieuwe: txt.slice(0, 40) });
    await saveContact(c); renderTab(); toast('Notitie toegevoegd', 'success');
  });
  body.querySelectorAll('[data-del-note]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('Notitie verwijderen?')) return;
    const c = currentContact(); c.notities.splice(+el.dataset.delNote, 1);
    await saveContact(c); renderTab(); toast('Notitie verwijderd');
  }));
}

/* ----- AUDIT ----- */
function renderAuditRead(c) {
  const log = (c.auditLog || []).slice().reverse();
  if (!log.length) return `<div style="color:var(--text-dim);font-style:italic">Nog geen audit-events.</div>`;
  let html = `<div class="placeholder-note" style="margin-bottom:16px">Volledig logboek van wijzigingen aan dít contact. Read-only. Voor het logboek over álle contacten (filteren, zoeken, CSV-export): klok-icoon in de werkbalk. Voor het volledige dossier van dit contact (inzagerecht): dossier-icoon bovenaan.</div>`;
  html += log.map(a => {
    let act = a.actie;
    if (a.veld && a.actie === 'wijziging') act = `<strong>${escapeHtml(a.veld)}</strong> gewijzigd${a.oude||a.nieuwe?`: <span style="color:var(--text-dim)">${escapeHtml((a.oude||'—'))} → ${escapeHtml((a.nieuwe||'—'))}</span>`:''}`;
    else if (a.actie === 'import') act = `Geïmporteerd${a.bron?` via ${escapeHtml(a.bron)}`:''}`;
    else act = `<strong>${escapeHtml(a.actie)}</strong>${a.nieuwe?`: <span style="color:var(--text-dim)">${escapeHtml(a.nieuwe)}</span>`:''}`;
    return `<div class="audit-row"><div class="ad-date">${escapeHtml(fmtDateTime(a.datum))}</div><div class="ad-act">${act}</div></div>`;
  }).join('');
  return html;
}

/* ============================================================
   FILTERS
   ============================================================ */
function uniqueValues(key) {
  const s = new Set();
  for (const c of state.contacts.values()) for (const v of asArray(c[key])) if (v) s.add(v);
  return Array.from(s).sort((a, b) => a.localeCompare(b, 'nl'));
}
function uniqueScalar(key) {
  const s = new Set();
  for (const c of state.contacts.values()) if (c[key]) s.add(c[key]);
  return Array.from(s).sort((a, b) => a.localeCompare(b, 'nl'));
}
function renderFilterPanel() {
  const f = state.filters;
  const sporten = uniqueValues('sporten');
  const talenten = uniqueValues('talenten');
  const ctypes = uniqueScalar('castingType');
  const chipSet = (arr, set2, attr) => arr.length ? arr.map(v => `<div class="chip-opt ${set2.has(v)?'sel':''}" data-${attr}="${escapeHtml(v)}">${escapeHtml(v)}</div>`).join('') : '<span style="color:var(--text-dim);font-size:13px">— nog geen data —</span>';
  const slider = (key, label) => `<div class="slider-field"><div class="slider-top"><span>${label}</span><span class="slider-val" id="flt-${key}-val">${f[key]?'≥ '+f[key]:'alle'}</span></div>
    <input type="range" min="0" max="5" step="1" value="${f[key]}" data-flt-slider="${key}"></div>`;
  return `
    <div class="filter-head"><h3>Filters</h3></div>
    <div class="filter-block"><div class="fb-label">Leeftijd</div>
      <div class="range-row"><input type="number" inputmode="numeric" id="flt-age-min" placeholder="min" value="${f.ageMin??''}"><span>tot</span><input type="number" inputmode="numeric" id="flt-age-max" placeholder="max" value="${f.ageMax??''}"><span>jaar</span></div>
    </div>
    <div class="filter-block"><div class="fb-label">Casting type</div><div class="chip-select">${chipSet(ctypes, f.castingType, 'ct')}</div></div>
    <div class="filter-block"><div class="fb-label">Sporten</div><div class="chip-select">${chipSet(sporten, f.sporten, 'sp')}</div></div>
    <div class="filter-block"><div class="fb-label">Talenten</div><div class="chip-select">${chipSet(talenten, f.talenten, 'tl')}</div></div>
    <div class="filter-block"><div class="fb-label">Ervaring (minimaal)</div>
      ${slider('strategischDenken','Strategisch denken')}
      ${slider('socialeDynamiek','Sociale dynamiek')}
      ${slider('cameraComfort','Camera-comfort')}
    </div>
    <div class="edit-actions" style="position:static;background:none;padding-top:8px">
      <button class="btn-primary btn-secondary" data-flt-action="clear" style="flex:1">Wissen</button>
      <button class="btn-primary" data-flt-action="apply" style="flex:1">Toon resultaten</button>
    </div>`;
}
function wireFilterPanel(root) {
  const f = state.filters;
  root.querySelectorAll('[data-ct]').forEach(el => el.addEventListener('click', () => { toggleSet(f.castingType, el.dataset.ct); el.classList.toggle('sel'); }));
  root.querySelectorAll('[data-sp]').forEach(el => el.addEventListener('click', () => { toggleSet(f.sporten, el.dataset.sp); el.classList.toggle('sel'); }));
  root.querySelectorAll('[data-tl]').forEach(el => el.addEventListener('click', () => { toggleSet(f.talenten, el.dataset.tl); el.classList.toggle('sel'); }));
  root.querySelectorAll('[data-flt-slider]').forEach(el => el.addEventListener('change', () => { f[el.dataset.fltSlider] = +el.value; }));
  const amin = root.querySelector('#flt-age-min'), amax = root.querySelector('#flt-age-max');
  if (amin) amin.addEventListener('input', () => { f.ageMin = amin.value === '' ? null : +amin.value; });
  if (amax) amax.addEventListener('input', () => { f.ageMax = amax.value === '' ? null : +amax.value; });
  root.querySelectorAll('[data-flt-action]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.fltAction === 'clear') { state.filters = emptyFilters(); refreshFilters(); }
    closeModal('modal-filter'); renderContacts();
  }));
}
function toggleSet(set2, val) { if (set2.has(val)) set2.delete(val); else set2.add(val); }
function refreshFilters() {
  // re-render both panels to reflect state
  const side = document.getElementById('filter-sidebar');
  side.innerHTML = `<div class="filter-panel">${renderFilterPanel()}</div>`;
  wireFilterPanel(side);
  renderContacts();
}
function openFilterSheet() {
  const sheet = document.getElementById('filter-sheet-body');
  sheet.innerHTML = `<div class="filter-panel">${renderFilterPanel()}</div>`;
  wireFilterPanel(sheet);
  openModal('modal-filter');
}

/* ============================================================
   v0.3 — BIO-IMPORT (Wikipedia + AI-fallback) & TV-IMPORT (AI)
   Principe: er wordt NOOIT iets opgeslagen zonder menselijke
   review. AI-output is altijd "AI — ongeverifieerd" tot Ferri
   of de eigenaar het afvinkt.
   ============================================================ */
function wireCarriereRead() {
  const body = document.getElementById('detail-body');
  const bioBtn = document.getElementById('btn-fetch-bio');
  if (bioBtn) bioBtn.addEventListener('click', startBioImport);
  const tvBtn = document.getElementById('btn-fetch-tv');
  if (tvBtn) tvBtn.addEventListener('click', startTvImport);
  body.querySelectorAll('[data-verify-tv]').forEach(el => el.addEventListener('click', async () => {
    const c = currentContact(); const i = +el.dataset.verifyTv;
    const p = (c.tvProgrammas || [])[i]; if (!p) return;
    if (!confirm(`"${p.titel}" markeren als door jou gecontroleerd?`)) return;
    p.geverifieerd = true;
    c.auditLog.push({ datum: new Date().toISOString(), actie: 'tv-programma geverifieerd', veld: 'tvProgrammas', oude: 'ongeverifieerd', nieuwe: p.titel });
    await saveContact(c); renderTab(); toast('Gemarkeerd als geverifieerd', 'success');
  }));
}

function importNaamCheck() {
  const c = currentContact(); if (!c) return null;
  const naam = (c.naam || '').trim();
  if (!naam || naam === 'Nieuw contact' || naam === 'Onbekend') { toast('Vul eerst een (echte) naam in', 'error'); return null; }
  return naam;
}

/* ----- Wikipedia ----- */
/* v0.6: summary-endpoint vereist een EXACTE paginatitel. "ferri somogyi"
   werd "Ferri_somogyi" (Wikipedia kapitaliseert alleen de 1e letter) en
   bestond dus niet, terwijl "Ferri Somogyi" wél bestaat. Fix: vind eerst
   de echte titel via de zoek-API (hoofdletter-ongevoelig), dan summary. */
async function wikiSummary(lang, titel) {
  const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titel.replace(/ /g, '_'))}`);
  if (!r.ok) return null;
  const j = await r.json();
  if (j.type === 'disambiguation') return null; // ambigu — geen gok doen
  if (!j.extract || !j.extract.trim()) return null;
  return {
    tekst: j.extract.trim(),
    bron: `Wikipedia (${lang.toUpperCase()}) — artikel "${j.title || titel}"`,
    url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || '',
  };
}
async function wikiZoekTitel(lang, naam) {
  /* Zoek-API is hoofdletter-ongevoelig en tikfout-tolerant. origin=* is
     nodig voor CORS; host valt binnen de bestaande CSP connect-src. */
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(naam)}&srlimit=5&srnamespace=0&format=json&origin=*`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  const hits = (j.query && j.query.search) || [];
  if (!hits.length) return null;
  /* Voorkeur: titel die (zonder hoofdletters) gelijk is aan de zoeknaam;
     anders de beste zoektreffer. De menselijke review blijft de poortwachter. */
  const naamLc = naam.toLowerCase();
  const exact = hits.find(h => (h.title || '').toLowerCase() === naamLc);
  return (exact || hits[0]).title || null;
}
async function fetchBioWikipedia(naam) {
  for (const lang of ['nl', 'en']) {
    try {
      const direct = await wikiSummary(lang, naam);
      if (direct) return direct;
      const titel = await wikiZoekTitel(lang, naam);
      /* Exacte (hoofdlettergevoelige) vergelijking: "ferri somogyi" vs
         gevonden titel "Ferri Somogyi" verschilt — en moet dus opnieuw
         worden opgehaald. Alleen 100% identiek = al geprobeerd. */
      if (titel && titel !== naam) {
        const viaZoek = await wikiSummary(lang, titel);
        if (viaZoek) return viaZoek;
      }
    } catch (e) { /* offline of geblokkeerd — probeer volgende taal */ }
  }
  return null;
}

async function startBioImport() {
  const naam = importNaamCheck(); if (!naam) return;
  toast('Wikipedia zoeken…');
  const res = await fetchBioWikipedia(naam);
  if (res) showBioReview(res);
  else showBioNotFound(naam);
}

function showBioReview(res) {
  const c = currentContact();
  let overwrite = c.bio ? `<div class="review-warn">Let op: opslaan overschrijft de huidige bio.</div>` : '';
  /* v0.6: AI-tekst kan feiten verzinnen of personen verwisselen — hard waarschuwen */
  if ((res.bron || '').startsWith('AI')) overwrite = `<div class="review-warn">⚠ AI-tekst: kan fouten bevatten of de verkeerde persoon beschrijven. Controleer élk feit vóór opslaan — of pas de tekst hieronder aan.</div>` + overwrite;
  document.getElementById('review-title').textContent = 'Bio — review vóór opslaan';
  document.getElementById('review-sub').textContent = res.bron + (res.url ? ' · ' + res.url : '');
  document.getElementById('review-body').innerHTML = `
    ${overwrite}
    <div class="edit-field"><label for="review-bio-text">Tekst (nog aanpasbaar)</label>
    <textarea id="review-bio-text" style="min-height:150px">${escapeHtml(res.tekst)}</textarea></div>
    <div class="edit-actions" style="position:static;background:none">
      <button class="btn-primary btn-secondary" data-close-modal="modal-review" style="flex:1">Annuleer</button>
      <button class="btn-primary" id="review-bio-save" style="flex:1">Opslaan</button>
    </div>`;
  document.getElementById('review-bio-save').addEventListener('click', async () => {
    const tekst = document.getElementById('review-bio-text').value.trim();
    if (!tekst) { toast('Lege bio — niets opgeslagen', 'error'); return; }
    const cc = currentContact();
    const oud = cc.bio || '';
    cc.bio = tekst;
    cc.bioBron = res.bron + (res.url ? ' — ' + res.url : '');
    cc.bioLaatstOpgehaald = new Date().toISOString();
    cc.auditLog.push({ datum: new Date().toISOString(), actie: 'bio-import', veld: 'bio', oude: oud.slice(0, 60), nieuwe: tekst.slice(0, 60) + '… [' + res.bron + ']' });
    await saveContact(cc); closeModal('modal-review'); renderTab();
    toast('Bio opgeslagen', 'success');
  });
  openModal('modal-review');
}

function showBioNotFound(naam) {
  document.getElementById('review-title').textContent = 'Geen Wikipedia-artikel';
  document.getElementById('review-sub').textContent = naam;
  document.getElementById('review-body').innerHTML = `
    <div class="placeholder-note">Geen (bruikbaar) Wikipedia-artikel gevonden voor "${escapeHtml(naam)}". Je kunt Claude een concept-bio laten schrijven via je eigen Worker. Die is dan <strong>AI-gegenereerd en ongeverifieerd</strong> — altijd zelf checken vóór gebruik.</div>
    <div class="edit-actions" style="position:static;background:none">
      <button class="btn-primary btn-secondary" data-close-modal="modal-review" style="flex:1">Annuleer</button>
      <button class="btn-primary" id="review-bio-ai" style="flex:1">Probeer AI-bio</button>
    </div>`;
  document.getElementById('review-bio-ai').addEventListener('click', async () => {
    document.getElementById('review-body').innerHTML = `<div class="empty-inline">Claude schrijft een concept-bio…</div>`;
    try {
      /* v0.6: geboortejaar mee als context — voorkomt verwisseling met naamgenoten */
      const cBio = currentContact();
      const j = await callWorker('bio', naam, { geboortejaar: ((cBio && cBio.geboortedatum) || '').slice(0, 4) || undefined });
      if (!j || j.onbekend || !j.bio) {
        document.getElementById('review-body').innerHTML = `<div class="placeholder-note">Claude kent deze persoon niet met genoeg zekerheid. Geen bio gegenereerd — beter géén data dan verzonnen data.</div>`;
        return;
      }
      showBioReview({ tekst: String(j.bio), bron: 'AI (Claude) — ongeverifieerd', url: '' });
    } catch (e) {
      document.getElementById('review-body').innerHTML = `<div class="placeholder-note">Worker niet bereikbaar (${escapeHtml(e.message)}). Staat de Cloudflare Worker al live? Zie werkdocument, hoofdstuk Worker.</div>`;
    }
  });
  openModal('modal-review');
}

/* ----- Worker-proxy (Claude API — key staat alleen in de Worker) ----- */
async function callWorker(task, naam, extra = {}) {
  const r = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, naam, ...extra }),
  });
  if (!r.ok) throw new Error('Worker antwoordt met status ' + r.status);
  return await r.json();
}

/* ----- TV-programma's via Claude ----- */
async function startTvImport() {
  const naam = importNaamCheck(); if (!naam) return;
  const c = currentContact();
  document.getElementById('review-title').textContent = 'TV-programma’s — AI-zoektocht';
  document.getElementById('review-sub').textContent = naam + ' · via Claude (Worker)';
  document.getElementById('review-body').innerHTML = `<div class="empty-inline">Claude zoekt programma's… (kan ±10 sec duren)</div>`;
  openModal('modal-review');
  let j;
  try {
    j = await callWorker('tv', naam, { geboortejaar: (c.geboortedatum || '').slice(0, 4) || undefined });
  } catch (e) {
    document.getElementById('review-body').innerHTML = `<div class="placeholder-note">Worker niet bereikbaar (${escapeHtml(e.message)}). Staat de Cloudflare Worker al live? Zie werkdocument, hoofdstuk Worker.</div>`;
    return;
  }
  const items = (j && Array.isArray(j.items)) ? j.items.filter(it => it && it.titel) : [];
  if (!items.length) {
    document.getElementById('review-body').innerHTML = `<div class="placeholder-note">Claude kent geen tv-werk van deze persoon met genoeg zekerheid${j && j.opmerking ? ' — "' + escapeHtml(j.opmerking) + '"' : ''}. Niets te reviewen: beter géén data dan verzonnen data.</div>`;
    return;
  }
  showTvReview(items, j.opmerking);
}

function showTvReview(items, opmerking) {
  const c = currentContact();
  const keyOf = it => ((it.titel || '') + '|' + (it.jaar || '')).toLowerCase();
  const bestaand = new Set((c.tvProgrammas || []).map(keyOf));
  const rows = items.map((it, i) => {
    const dup = bestaand.has(keyOf(it));
    return `<label class="review-item ${dup ? 'dup' : ''}">
      <input type="checkbox" data-rev-i="${i}" ${dup ? '' : 'checked'}>
      <span class="ri-main"><strong>${escapeHtml(it.titel || '?')}</strong>${it.jaar ? ` (${escapeHtml(String(it.jaar))})` : ''}
        <span class="ri-sub">${[it.rol, it.zender].filter(Boolean).map(escapeHtml).join(' · ') || '—'}</span></span>
      ${it.zeker === false ? '<span class="tv-badge unv">onzeker</span>' : ''}
      ${dup ? '<span class="tv-badge dup">al in lijst</span>' : ''}
    </label>`;
  }).join('');
  document.getElementById('review-body').innerHTML = `
    <div class="placeholder-note" style="margin-bottom:14px">Dit is <strong>AI-output — ongeverifieerd</strong>. Vink aan wat je wil bewaren. Elk item houdt het label "AI — ongeverifieerd" tot jij het in de carrière-tab afvinkt.${opmerking ? '<br><em>Claude: ' + escapeHtml(opmerking) + '</em>' : ''}</div>
    <div class="review-list">${rows}</div>
    <div class="edit-actions" style="position:static;background:none">
      <button class="btn-primary btn-secondary" data-close-modal="modal-review" style="flex:1">Annuleer</button>
      <button class="btn-primary" id="review-tv-save" style="flex:1">Geselecteerde opslaan</button>
    </div>`;
  document.getElementById('review-tv-save').addEventListener('click', async () => {
    const cc = currentContact();
    cc.tvProgrammas = cc.tvProgrammas || [];
    let added = 0;
    document.querySelectorAll('#review-body [data-rev-i]:checked').forEach(cb => {
      const it = items[+cb.dataset.revI];
      if (cc.tvProgrammas.some(p => keyOf(p) === keyOf(it))) return; // dedupe
      cc.tvProgrammas.push({
        titel: it.titel || '', jaar: it.jaar ? String(it.jaar) : '', rol: it.rol || '', zender: it.zender || '',
        bron: 'AI — ongeverifieerd', geverifieerd: false, opgehaald: new Date().toISOString(),
      });
      added++;
    });
    if (added) cc.auditLog.push({ datum: new Date().toISOString(), actie: 'tv-import (AI)', veld: 'tvProgrammas', oude: '', nieuwe: added + ' programma(’s) toegevoegd, ongeverifieerd' });
    await saveContact(cc); closeModal('modal-review'); renderTab();
    toast(added ? added + ' programma(’s) toegevoegd — nog te verifiëren' : 'Niets geselecteerd', added ? 'success' : '');
  });
}

/* ============================================================
   v0.3 — ENCRYPTED EXPORT / IMPORT (.castvault)
   Basis voor de overdracht naar de Mac van de eigenaar (chat 5).
   Eigen wachtwoord per bestand — hoeft niet je master te zijn.
   ============================================================ */
async function saveContactRaw(contact) { // bewust GEEN updatedAt-bump (import behoudt historie)
  const blob = await encryptJSON(state.key, contact);
  await dbPut('contacts', contact.id, blob);
  state.contacts.set(contact.id, contact);
}

async function exportVault(passphrase) {
  const salt = randBytes(SALT_LEN);
  const key = await deriveKey(passphrase, salt);
  const payload = {
    app: 'CastVault', exportedAt: new Date().toISOString(),
    contacts: Array.from(state.contacts.values()),
    tagColors: state.tagColors,
    deletions: state.deletions, // v0.4: verwijderlog reist mee (geanonimiseerd, dus AVG-veilig)
    settings: state.settings,   // v0.5: bewaartermijn-instelling reist mee
  };
  const blob = await encryptJSON(key, payload);
  return JSON.stringify({ format: 'castvault', version: 1, iter: PBKDF2_ITERATIONS, salt: b64(salt), iv: blob.iv, ct: blob.ct });
}

async function importVault(text, passphrase, mode) {
  let f;
  try { f = JSON.parse(text); } catch (e) { throw new Error('Geen geldig .castvault-bestand'); }
  if (!f || f.format !== 'castvault' || !f.salt || !f.iv || !f.ct) throw new Error('Geen geldig .castvault-bestand');
  const key = await deriveKey(passphrase, unb64(f.salt));
  let payload;
  try { payload = await decryptJSON(key, { iv: f.iv, ct: f.ct }); }
  catch (e) { throw new Error('Wachtwoord onjuist of bestand beschadigd'); }
  const incoming = Array.isArray(payload.contacts) ? payload.contacts : [];
  if (mode === 'replace') {
    for (const id of Array.from(state.contacts.keys())) await dbDelete('contacts', id);
    state.contacts.clear();
    state.tagColors = {};
  }
  let nieuw = 0, bijgewerkt = 0, overgeslagen = 0;
  for (const c of incoming) {
    if (!c || !c.id) continue;
    const ex = state.contacts.get(c.id);
    if (!ex) {
      c.auditLog = c.auditLog || [];
      c.auditLog.push({ datum: new Date().toISOString(), actie: 'import', bron: '.castvault-bestand' });
      await saveContactRaw(c); nieuw++;
    } else if ((c.updatedAt || '') > (ex.updatedAt || '')) {
      c.auditLog = c.auditLog || [];
      c.auditLog.push({ datum: new Date().toISOString(), actie: 'import (bijgewerkt — bestand was nieuwer)', bron: '.castvault-bestand' });
      await saveContactRaw(c); bijgewerkt++;
    } else overgeslagen++;
  }
  for (const [t, idx] of Object.entries(payload.tagColors || {})) {
    if (state.tagColors[t] == null) state.tagColors[t] = idx;
  }
  await saveTagColors();
  // v0.4: tombstones samenvoegen (dedupe op id)
  const haveTs = new Set(state.deletions.map(d => d.id));
  for (const d of (payload.deletions || [])) {
    if (d && d.id && !haveTs.has(d.id)) { state.deletions.push(d); haveTs.add(d.id); }
  }
  state.deletions.sort((a, b) => (a.datum || '').localeCompare(b.datum || ''));
  await saveDeletions();
  // v0.5: bewaartermijn-instelling uit het bestand — alleen bij 'vervangen' (merge respecteert de lokale keuze)
  if (mode === 'replace' && payload.settings && typeof payload.settings.bewaartermijnMaanden === 'number') {
    const m = Math.round(payload.settings.bewaartermijnMaanden);
    if (m >= 6 && m <= 120) { state.settings.bewaartermijnMaanden = m; await saveSettings(); }
  }
  return { nieuw, bijgewerkt, overgeslagen, totaal: incoming.length };
}

function wireSyncModal() {
  document.getElementById('btn-sync').addEventListener('click', () => {
    for (const id of ['exp-pw1', 'exp-pw2', 'imp-pw']) document.getElementById(id).value = '';
    document.getElementById('imp-file').value = '';
    document.getElementById('sync-msg').textContent = ''; document.getElementById('sync-msg').className = 'auth-msg';
    openModal('modal-sync');
  });
  const msg = (t, cls) => { const m = document.getElementById('sync-msg'); m.textContent = t; m.className = 'auth-msg ' + (cls || ''); };
  document.getElementById('btn-export').addEventListener('click', async () => {
    const pw1 = document.getElementById('exp-pw1').value, pw2 = document.getElementById('exp-pw2').value;
    if (pw1.length < 12) { msg('Bestandswachtwoord: minimaal 12 tekens.', 'error'); return; }
    if (pw1 !== pw2) { msg('Wachtwoorden komen niet overeen.', 'error'); return; }
    msg('Versleutelen…');
    try {
      const json = await exportVault(pw1);
      const blobF = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blobF);
      a.download = 'castvault-' + todayISODate() + '.castvault';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      msg(`Geëxporteerd: ${state.contacts.size} contacten.`, 'success');
      toast('Vault geëxporteerd', 'success');
    } catch (e) { msg('Export mislukt: ' + e.message, 'error'); }
  });
  document.getElementById('btn-import-cv').addEventListener('click', async () => {
    const file = document.getElementById('imp-file').files[0];
    const pw = document.getElementById('imp-pw').value;
    const mode = (document.querySelector('input[name="impmode"]:checked') || {}).value || 'merge';
    if (!file) { msg('Kies eerst een .castvault-bestand.', 'error'); return; }
    if (!pw) { msg('Voer het wachtwoord van het bestand in.', 'error'); return; }
    if (mode === 'replace' && !confirm('VERVANGEN wist al je huidige contacten en zet het bestand ervoor in de plaats. Weet je het zeker?')) return;
    msg('Ontsleutelen en importeren…');
    try {
      const res = await importVault(await file.text(), pw, mode);
      closeModal('modal-sync'); refreshFilters();
      toast(`Import: ${res.nieuw} nieuw, ${res.bijgewerkt} bijgewerkt, ${res.overgeslagen} overgeslagen`, 'success');
    } catch (e) { msg(e.message, 'error'); }
  });
}
wireSyncModal();

/* ============================================================
   AUTH UI (v0.1) + boot
   ============================================================ */
function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 12) score += 25; if (pw.length >= 16) score += 15;
  if (/[a-z]/.test(pw)) score += 10; if (/[A-Z]/.test(pw)) score += 15;
  if (/[0-9]/.test(pw)) score += 15; if (/[^a-zA-Z0-9]/.test(pw)) score += 20;
  return Math.min(score, 100);
}
function updateStrength(pw) {
  const bar = document.getElementById('strength-bar'); const label = document.getElementById('strength-label');
  const s = passwordStrength(pw); bar.style.width = s + '%';
  if (s < 40) { bar.style.background = 'var(--danger)'; label.textContent = 'Zwak'; }
  else if (s < 70) { bar.style.background = 'var(--warn)'; label.textContent = 'Redelijk'; }
  else { bar.style.background = 'var(--success)'; label.textContent = 'Sterk'; }
}
document.getElementById('setup-pw1').addEventListener('input', e => updateStrength(e.target.value));
document.getElementById('setup-btn').addEventListener('click', async () => {
  const pw1 = document.getElementById('setup-pw1').value, pw2 = document.getElementById('setup-pw2').value;
  const msg = document.getElementById('setup-msg');
  if (pw1.length < 12) { msg.textContent = 'Wachtwoord moet minimaal 12 tekens zijn.'; msg.className = 'auth-msg error'; return; }
  if (pw1 !== pw2) { msg.textContent = 'Wachtwoorden komen niet overeen.'; msg.className = 'auth-msg error'; return; }
  msg.textContent = 'Vault wordt aangemaakt…'; msg.className = 'auth-msg';
  try {
    await setupVault(pw1);
    document.getElementById('setup-pw1').value = ''; document.getElementById('setup-pw2').value = '';
    await loadTagColors(); await loadDeletions(); await loadSettings();
    showScreen('main'); refreshFilters(); resetAutoLock();
    toast('Vault aangemaakt. Welkom.', 'success');
  } catch (e) { msg.textContent = 'Fout: ' + e.message; msg.className = 'auth-msg error'; }
});
document.getElementById('lock-btn').addEventListener('click', async () => {
  const pw = document.getElementById('lock-pw').value;
  const msg = document.getElementById('lock-msg'); const input = document.getElementById('lock-pw');
  if (!pw) { msg.textContent = 'Voer wachtwoord in.'; msg.className = 'auth-msg error'; return; }
  msg.textContent = 'Ontgrendelen…'; msg.className = 'auth-msg';
  const ok = await unlockVault(pw);
  if (ok) {
    document.getElementById('lock-pw').value = ''; msg.textContent = '';
    await loadAllContacts(); await loadTagColors(); await loadDeletions(); await loadSettings();
    showScreen('main'); refreshFilters(); resetAutoLock();
  } else {
    msg.textContent = 'Wachtwoord onjuist.'; msg.className = 'auth-msg error';
    input.classList.add('error'); setTimeout(() => input.classList.remove('error'), 500);
  }
});
document.getElementById('lock-pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('lock-btn').click(); });
document.getElementById('setup-pw2').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('setup-btn').click(); });

document.getElementById('btn-lock').addEventListener('click', lockVault);
document.getElementById('btn-import').addEventListener('click', () => openModal('modal-import'));
document.getElementById('btn-filter').addEventListener('click', openFilterSheet);
document.getElementById('clear-filters').addEventListener('click', () => { state.filters = emptyFilters(); refreshFilters(); });

document.getElementById('detail-back').addEventListener('click', () => {
  if (state.editing && !confirm('Je bewerkt nu. Terug zonder opslaan?')) return;
  backToList();
});
/* v0.4: vergeetrecht-flow — nette delete met verplichte reden + geanonimiseerde tombstone */
document.getElementById('detail-delete').addEventListener('click', () => {
  const c = currentContact(); if (!c) return;
  openDeleteModal(c);
});

document.getElementById('btn-new').addEventListener('click', async () => {
  const c = blankContact();
  c.naam = 'Nieuw contact';
  c.auditLog = [{ datum: new Date().toISOString(), actie: 'handmatig aangemaakt' }];
  await saveContact(c);
  openDetail(c.id);
  state.editing = true; renderTab();
  toast('Vul de gegevens in en sla op', '');
});

document.getElementById('search').addEventListener('input', e => { state.searchQuery = e.target.value; renderContacts(); resetAutoLock(); });

const fileDrop = document.getElementById('file-drop');
const fileInput = document.getElementById('file-input');
fileDrop.addEventListener('click', () => fileInput.click());
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('dragover'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
fileDrop.addEventListener('drop', e => { e.preventDefault(); fileDrop.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleVCardFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleVCardFile(e.target.files[0]); });

async function handleVCardFile(file) {
  try {
    toast('Bestand lezen…');
    const text = await file.text();
    const cards = parseVCards(text);
    if (cards.length === 0) { toast('Geen vCards gevonden', 'error'); return; }
    toast(`${cards.length} contacten gevonden, versleutelen…`);
    let imported = 0, skipped = 0;
    const existingPhones = new Set(), existingEmails = new Set();
    for (const c of state.contacts.values()) {
      for (const t of c.telefoon || []) existingPhones.add(t.nummer);
      for (const e of c.email || []) existingEmails.add((e.adres||'').toLowerCase());
    }
    for (const card of cards) {
      const dup = card.telefoon.some(t => existingPhones.has(t.nummer)) || card.email.some(e => existingEmails.has(e.adres.toLowerCase()));
      if (dup) { skipped++; continue; }
      await saveContact(card); imported++;
    }
    closeModal('modal-import'); refreshFilters();
    toast(`${imported} geïmporteerd${skipped ? `, ${skipped} duplicaten overgeslagen` : ''}`, 'success');
  } catch (e) { console.error(e); toast('Fout bij importeren: ' + e.message, 'error'); }
}

['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (state.key) resetAutoLock(); }, { passive: true }));

/* ============================================================
   v0.4 — FOTO-OPSLAG
   Client-side gecomprimeerd (canvas, JPEG, max ±200KB), opgeslagen
   als data-URL-veld in het contact => automatisch versleuteld in
   IndexedDB en automatisch mee in de .castvault-export.
   ============================================================ */
const FOTO_MAX_CHARS = 273000; // ±200KB binair als base64-dataURL

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Bestand kan niet gelezen worden'));
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Geen geldige afbeelding'));
    img.src = src;
  });
}
async function compressPhoto(file) {
  if (!/^image\//.test(file.type)) throw new Error('Kies een afbeelding (JPG, PNG, HEIC werkt niet in elke browser)');
  const img = await loadImage(await readFileAsDataURL(file));
  // probeer combinaties van maat + kwaliteit tot het bestand klein genoeg is
  const attempts = [[900, 0.82], [900, 0.65], [720, 0.6], [600, 0.5], [480, 0.42]];
  let out = null;
  for (const [maxDim, q] of attempts) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    out = canvas.toDataURL('image/jpeg', q);
    if (out.length <= FOTO_MAX_CHARS) return out;
  }
  if (out && out.length <= FOTO_MAX_CHARS * 1.25) return out; // nèt erboven: accepteren
  throw new Error('Foto kan niet klein genoeg gemaakt worden');
}

function openFotoModal() {
  const c = currentContact(); if (!c) return;
  const src = safePhotoSrc(c);
  document.getElementById('foto-preview').innerHTML = src
    ? `<img src="${src}" alt="Foto van ${escapeHtml(c.naam)}">`
    : `<div class="foto-empty">Nog geen foto.<br><span style="font-size:12px">Wordt gecomprimeerd tot ±200KB en versleuteld opgeslagen — gaat ook mee in de export.</span></div>`;
  document.getElementById('btn-foto-del').style.display = src ? '' : 'none';
  openModal('modal-foto');
}
function wireFotoModal() {
  const input = document.getElementById('foto-input');
  document.getElementById('btn-foto-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0]; input.value = '';
    if (!file) return;
    const c = currentContact(); if (!c) return;
    try {
      toast('Foto comprimeren…');
      const dataUrl = await compressPhoto(file);
      const had = !!c.foto;
      c.foto = dataUrl;
      c.fotoToegevoegd = new Date().toISOString();
      c.auditLog.push({ datum: new Date().toISOString(), actie: had ? 'foto vervangen' : 'foto toegevoegd', veld: 'foto', oude: had ? '[foto]' : '', nieuwe: `[foto, ±${Math.round(dataUrl.length * 0.75 / 1024)}KB]` });
      await saveContact(c);
      renderDetailHero(); openFotoModal(); renderContacts();
      toast('Foto opgeslagen (versleuteld)', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('btn-foto-del').addEventListener('click', async () => {
    const c = currentContact(); if (!c || !c.foto) return;
    if (!confirm('Foto verwijderen?')) return;
    c.foto = null; c.fotoToegevoegd = null;
    c.auditLog.push({ datum: new Date().toISOString(), actie: 'foto verwijderd', veld: 'foto', oude: '[foto]', nieuwe: '' });
    await saveContact(c);
    renderDetailHero(); openFotoModal(); renderContacts();
    toast('Foto verwijderd');
  });
}
wireFotoModal();

/* ============================================================
   v0.4 — AVG: DOSSIER-EXPORT PER CONTACT (inzagerecht, art. 15)
   Eén zelfstandig HTML-bestand (print = PDF) of JSON met álles
   wat over deze persoon is vastgelegd, incl. bronnen en auditlog.
   ============================================================ */
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function slugify(s) { return (s || 'contact').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'contact'; }

function dossierFieldRows(c) {
  const e = escapeHtml, rows = [];
  const push = (l, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push([l, v]); };
  push('Naam', e(c.naam));
  push('Voornaam', e(c.voornaam)); push('Achternaam', e(c.achternaam));
  push('Geslacht', e(c.geslacht));
  push('Geboortedatum', e(c.geboortedatum) + (computeAge(c.geboortedatum) != null ? ` (${computeAge(c.geboortedatum)} jaar)` : ''));
  push('Lengte', c.lengte_cm ? e(String(c.lengte_cm)) + ' cm' : '');
  push('Postuur', e(c.postuur));
  push('Organisatie', e(c.organisatie));
  push('Telefoon', (c.telefoon || []).map(t => e(t.nummer) + (t.label ? ` (${e(t.label)})` : '')).join('<br>'));
  push('Email', (c.email || []).map(m => e(m.adres) + (m.label ? ` (${e(m.label)})` : '')).join('<br>'));
  const a = c.adres || {};
  push('Adres', e([a.straat, [a.postcode, a.woonplaats].filter(Boolean).join(' '), a.land].filter(Boolean).join(', ')));
  push('Talen', (c.talen || []).map(e).join(', '));
  push('Sporten', (c.sporten || []).map(e).join(', '));
  push('Hobby’s', (c.hobbys || []).map(e).join(', '));
  push('Talenten', (c.talenten || []).map(e).join(', '));
  push('Rijbewijs', c.rijbewijs ? 'Ja' : ''); push('Paspoort', c.paspoort ? 'Ja' : ''); push('Reisbereid', c.reisbereid ? 'Ja' : '');
  push('Tags', (c.tags || []).map(e).join(', '));
  push('Agent', e([c.agent?.naam, c.agent?.bureau, c.agent?.telefoon, c.agent?.email].filter(Boolean).join(' · ')));
  push('Social', e(Object.entries(c.social || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')));
  push('Volgers', e(Object.entries(c.volgers || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')));
  push('Casting type', e(c.castingType)); push('Beschikbaarheid', e(c.beschikbaarheid));
  push('Strategisch denken', c.strategischDenken ? c.strategischDenken + '/5' : '');
  push('Sociale dynamiek', c.socialeDynamiek ? c.socialeDynamiek + '/5' : '');
  push('Camera-comfort', c.cameraComfort ? c.cameraComfort + '/5' : '');
  push('Reality-ervaring', c.realityErvaring ? 'Ja' : ''); push('Eerder gewonnen', c.eerderGewonnen ? 'Ja' : '');
  push('Bekenden in DB', e(c.bekendenInDB)); push('Fee-indicatie', e(c.feeIndicatie));
  push('Allergieën', (c.allergieen || []).map(e).join(', '));
  push('Fobieën', (c.fobieen || []).map(e).join(', '));
  push('Dieet', e(c.dieet)); push('No-go’s', (c.noGos || []).map(e).join(', '));
  push('Medisch / overig', e(c.medisch));
  return rows;
}

function dossierHtml(c) {
  const e = escapeHtml;
  const now = new Date();
  const fotoSrc = safePhotoSrc(c);
  const rows = dossierFieldRows(c).map(([l, v]) => `<tr><th>${l}</th><td>${v}</td></tr>`).join('');
  const tv = (c.tvProgrammas || []).map(p =>
    `<tr><td>${e(p.titel)}</td><td>${e(String(p.jaar || ''))}</td><td>${e(p.rol || '')}</td><td>${e(p.zender || '')}</td><td>${e(p.bron || '')}${p.geverifieerd ? ' · geverifieerd' : ' · ongeverifieerd'}</td></tr>`).join('');
  const flags = (c.redFlags || []).map(r =>
    `<div class="flag ${e(r.kleur)}"><strong>${e(r.kleur).toUpperCase()}</strong> — ${e(r.motivatie)}<br><small>Bron: ${e(r.bron || '—')} · Datum: ${e(r.datum || '—')}${r.geregistreerdDoor ? ' · Door: ' + e(r.geregistreerdDoor) : ''}</small></div>`).join('');
  const notes = (c.notities || []).map(n => `<div class="note"><small>${e(fmtDateTime(n.datum))}</small><br>${e(n.tekst)}</div>`).join('');
  const audit = (c.auditLog || []).map(l =>
    `<tr><td>${e(fmtDateTime(l.datum))}</td><td>${e(l.actie || '')}</td><td>${e(l.veld || l.bron || '')}</td><td>${e(l.oude || '')}</td><td>${e(l.nieuwe || '')}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="nl"><head><meta charset="UTF-8"><title>Dossier — ${e(c.naam)}</title>
<style>
  body{font-family:Georgia,serif;color:#1a1a1a;max-width:760px;margin:32px auto;padding:0 24px;line-height:1.55;font-size:14px}
  h1{font-size:26px;margin-bottom:2px} h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #c9a961;padding-bottom:4px}
  .meta{color:#666;font-size:12px;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e0d5;vertical-align:top}
  th{width:170px;color:#666;font-weight:600}
  .foto{float:right;width:120px;height:120px;object-fit:cover;border-radius:8px;margin:0 0 12px 16px;border:1px solid #ccc}
  .flag{border-left:4px solid #999;padding:8px 12px;margin:8px 0;background:#faf8f3}
  .flag.rood{border-color:#c0392b}.flag.oranje{border-color:#d4a14e}.flag.groen{border-color:#27ae60}
  .note{padding:8px 12px;margin:8px 0;background:#faf8f3;border-radius:6px}
  .avg{margin-top:32px;padding:12px 16px;background:#f3efe6;border-radius:8px;font-size:12px;color:#555}
  small{color:#666}
  @media print{ body{margin:8mm auto} .avg{page-break-inside:avoid} }
</style></head><body>
${fotoSrc ? `<img class="foto" src="${fotoSrc}" alt="Foto">` : ''}
<h1>Dossier — ${e(c.naam)}</h1>
<div class="meta">Gegenereerd: ${e(fmtDateTime(now.toISOString()))} · CastVault · Aangemaakt: ${e(fmtDate(c.createdAt))} · Laatst gewijzigd: ${e(fmtDate(c.updatedAt))}</div>
<h2>Gegevens</h2><table>${rows || '<tr><td>—</td></tr>'}</table>
<h2>Biografie</h2><p>${c.bio ? e(c.bio) : '—'}</p>${c.bioBron ? `<small>Bron: ${e(c.bioBron)}${c.bioLaatstOpgehaald ? ' · Opgehaald: ' + e(fmtDateTime(c.bioLaatstOpgehaald)) : ''}</small>` : ''}
<h2>TV-programma's</h2>${tv ? `<table><tr><th style="width:auto">Titel</th><th>Jaar</th><th>Rol</th><th>Zender</th><th>Bron / status</th></tr>${tv}</table>` : '<p>—</p>'}
<h2>Red flags</h2>${flags || '<p>—</p>'}
<h2>Notities</h2>${notes || '<p>—</p>'}
<h2>Auditlog (volledige wijzigingshistorie)</h2>${audit ? `<table><tr><th style="width:auto">Datum</th><th>Actie</th><th>Veld</th><th>Oud</th><th>Nieuw</th></tr>${audit}</table>` : '<p>—</p>'}
<div class="avg"><strong>AVG / inzagerecht (art. 15).</strong> Dit dossier bevat alle persoonsgegevens die over deze persoon zijn vastgelegd in CastVault, inclusief herkomst (bronvermelding) en volledige wijzigingshistorie. Items met label "AI — ongeverifieerd" zijn machinaal gegenereerd en niet door een mens bevestigd. Print dit bestand naar PDF om het te delen (Cmd/Ctrl+P).</div>
</body></html>`;
}

function exportDossier(format) {
  const c = currentContact(); if (!c) return;
  const naamSlug = slugify(c.naam);
  if (format === 'json') {
    downloadFile(`dossier-${naamSlug}-${todayISODate()}.json`, JSON.stringify(c, null, 2), 'application/json');
  } else {
    downloadFile(`dossier-${naamSlug}-${todayISODate()}.html`, dossierHtml(c), 'text/html');
  }
  c.auditLog.push({ datum: new Date().toISOString(), actie: 'dossier geëxporteerd', veld: 'dossier', oude: '', nieuwe: format.toUpperCase() });
  saveContact(c).then(() => { if (state.activeTab === 'audit') renderTab(); });
  closeModal('modal-dossier');
  toast('Dossier geëxporteerd (' + format.toUpperCase() + ')', 'success');
}
document.getElementById('detail-dossier').addEventListener('click', () => { if (currentContact()) openModal('modal-dossier'); });
document.getElementById('btn-dossier-html').addEventListener('click', () => exportDossier('html'));
document.getElementById('btn-dossier-json').addEventListener('click', () => exportDossier('json'));

/* ============================================================
   v0.5 — AVG: BEWAARTERMIJN-SIGNALERING (opslagbeperking, art. 5)
   "Aangeraakt" = laatste gedocumenteerde activiteit: een wijziging,
   import, dossier-export (auditregel) of expliciete bewaar-
   beoordeling. Een contact alleen bekijken telt bewust NIET —
   anders reset kijken de teller en is de signalering waardeloos.
   ============================================================ */
function lastTouched(c) {
  let max = c.updatedAt || c.createdAt || '';
  if ((c.retentieBeoordeeld || '') > max) max = c.retentieBeoordeeld;
  for (const l of c.auditLog || []) { if ((l.datum || '') > max) max = l.datum; }
  return max;
}
const MS_PER_MAAND = 30.44 * 24 * 3600 * 1000;
function monthsSince(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso);
  if (isNaN(d)) return Infinity;
  return (Date.now() - d.getTime()) / MS_PER_MAAND;
}
function staleContacts() {
  const lim = state.settings.bewaartermijnMaanden;
  return Array.from(state.contacts.values())
    .map(c => ({ c, touched: lastTouched(c), maanden: monthsSince(lastTouched(c)) }))
    .filter(x => x.maanden >= lim)
    .sort((a, b) => (a.touched || '').localeCompare(b.touched || ''));
}
function refreshRetentieBadge() {
  const badge = document.getElementById('retentie-badge');
  if (!badge) return;
  const n = state.key ? staleContacts().length : 0;
  badge.style.display = n ? 'flex' : 'none';
  badge.textContent = n;
}
function renderRetentieRows() {
  const rows = staleContacts();
  const body = document.getElementById('ret-rows');
  const lim = state.settings.bewaartermijnMaanden;
  document.getElementById('ret-count').textContent = rows.length
    ? `${rows.length} contact${rows.length === 1 ? '' : 'en'} langer dan ${lim} maanden zonder activiteit`
    : '';
  if (!rows.length) {
    body.innerHTML = '<div class="empty-inline" style="padding:14px 0">Geen contacten over de bewaartermijn. Goed bezig.</div>';
    return;
  }
  body.innerHTML = rows.map(({ c, touched, maanden }) => `
    <div class="ret-row" data-id="${c.id}">
      <div class="avatar">${avatarInnerHtml(c)}</div>
      <div class="ret-meta">
        <div class="ret-naam">${escapeHtml(c.naam)}</div>
        <div class="ret-sub">Laatste activiteit: ${escapeHtml(fmtDate(touched) || 'onbekend')} — ${isFinite(maanden) ? Math.floor(maanden) + ' mnd geleden' : 'nooit'}</div>
      </div>
      <button class="btn-mini" data-ret-open="${c.id}">Open</button>
      <button class="btn-mini" data-ret-keep="${c.id}">Bewaren ✓</button>
    </div>`).join('');
}
async function markRetentieKeep(id) {
  const c = state.contacts.get(id); if (!c) return;
  const now = new Date().toISOString();
  c.retentieBeoordeeld = now;
  c.auditLog = c.auditLog || [];
  c.auditLog.push({ datum: now, actie: 'retentie-check', veld: 'bewaartermijn', oude: '', nieuwe: 'beoordeeld: bewaren' });
  await saveContactRaw(c); // bewust geen updatedAt-bump: beoordeling is geen inhoudelijke wijziging
  renderRetentieRows(); refreshRetentieBadge();
  toast('Bewaar-beoordeling vastgelegd in de auditlog', 'success');
}
function wireRetentieModal() {
  document.getElementById('btn-retentie').addEventListener('click', () => {
    document.getElementById('ret-maanden').value = state.settings.bewaartermijnMaanden;
    renderRetentieRows();
    openModal('modal-retentie');
  });
  document.getElementById('ret-maanden').addEventListener('change', async (e) => {
    let m = Math.round(Number(e.target.value));
    if (!isFinite(m)) m = DEFAULT_SETTINGS.bewaartermijnMaanden;
    m = Math.min(120, Math.max(6, m));
    e.target.value = m;
    state.settings.bewaartermijnMaanden = m;
    await saveSettings();
    renderRetentieRows(); refreshRetentieBadge();
  });
  document.getElementById('ret-rows').addEventListener('click', async (e) => {
    const openBtn = e.target.closest('[data-ret-open]');
    if (openBtn) { closeModal('modal-retentie'); openDetail(openBtn.dataset.retOpen); return; }
    const keepBtn = e.target.closest('[data-ret-keep]');
    if (keepBtn) await markRetentieKeep(keepBtn.dataset.retKeep);
  });
}
wireRetentieModal();

/* ============================================================
   v0.4 — AVG: GLOBALE AUDITLOG-UI
   Alle log-regels van alle contacten + het verwijderlog, met
   filteren (contact, actie, periode), zoeken en CSV-export.
   ============================================================ */
function collectAuditEntries() {
  const out = [];
  for (const c of state.contacts.values()) {
    for (const l of c.auditLog || []) {
      out.push({ datum: l.datum || '', contact: c.naam || '—', contactId: c.id, actie: l.actie || '', veld: l.veld || l.bron || '', oude: l.oude || '', nieuwe: l.nieuwe || '' });
    }
  }
  for (const d of state.deletions) {
    out.push({ datum: d.datum || '', contact: '[verwijderd contact]', contactId: null, actie: 'contact verwijderd (vergeetrecht)', veld: 'reden: ' + (d.reden || '—'), oude: '', nieuwe: 'tombstone ' + (d.id || '').slice(0, 8) });
  }
  return out.sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
}
const auditUI = { contact: '', actie: '', van: '', tot: '', zoek: '' };
function filteredAuditEntries() {
  const q = auditUI.zoek.trim().toLowerCase();
  return collectAuditEntries().filter(r => {
    if (auditUI.contact && r.contactId !== auditUI.contact) return false;
    if (auditUI.actie && !r.actie.toLowerCase().includes(auditUI.actie.toLowerCase())) return false;
    if (auditUI.van && (r.datum || '').slice(0, 10) < auditUI.van) return false;
    if (auditUI.tot && (r.datum || '').slice(0, 10) > auditUI.tot) return false;
    if (q && !(r.contact + ' ' + r.actie + ' ' + r.veld + ' ' + r.oude + ' ' + r.nieuwe).toLowerCase().includes(q)) return false;
    return true;
  });
}
const AUDIT_ACTIES = ['', 'wijziging', 'import', 'bio-import', 'tv-import', 'geverifieerd', 'red flag', 'notitie', 'foto', 'dossier', 'verwijderd', 'aangemaakt', 'retentie-check'];
function renderAuditlogModal() {
  const sel = document.getElementById('al-contact');
  const namen = Array.from(state.contacts.values()).sort((a, b) => (a.naam || '').localeCompare(b.naam || '', 'nl'));
  sel.innerHTML = `<option value="">Alle contacten</option>` + namen.map(c => `<option value="${c.id}" ${auditUI.contact === c.id ? 'selected' : ''}>${escapeHtml(c.naam)}</option>`).join('');
  const selA = document.getElementById('al-actie');
  selA.innerHTML = AUDIT_ACTIES.map(a => `<option value="${a}" ${auditUI.actie === a ? 'selected' : ''}>${a || 'Alle acties'}</option>`).join('');
  renderAuditlogRows();
}
function renderAuditlogRows() {
  const rows = filteredAuditEntries();
  const MAX = 400;
  const body = document.getElementById('al-rows');
  document.getElementById('al-count').textContent = rows.length + ' regel' + (rows.length === 1 ? '' : 's') + (rows.length > MAX ? ` (eerste ${MAX} getoond — exporteer CSV voor alles)` : '');
  if (!rows.length) { body.innerHTML = '<div class="empty-inline" style="padding:14px 0">Geen log-regels met deze filters.</div>'; return; }
  body.innerHTML = rows.slice(0, MAX).map(r => {
    const isDel = r.actie.includes('vergeetrecht');
    return `<div class="audit-row">
      <div class="ad-date">${escapeHtml(fmtDateTime(r.datum))}</div>
      <div class="ad-act"><strong style="${isDel ? 'color:var(--danger)' : ''}">${escapeHtml(r.contact)}</strong> — ${escapeHtml(r.actie)}${r.veld ? ` · <em>${escapeHtml(r.veld)}</em>` : ''}${(r.oude || r.nieuwe) ? `<br><span style="color:var(--text-dim)">${escapeHtml(r.oude || '—')} → ${escapeHtml(r.nieuwe || '—')}</span>` : ''}</div>
    </div>`;
  }).join('');
}
function csvCell(s) { s = String(s == null ? '' : s); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportAuditCsv() {
  const rows = filteredAuditEntries();
  const csv = ['datum;contact;actie;veld;oud;nieuw',
    ...rows.map(r => [r.datum, r.contact, r.actie, r.veld, r.oude, r.nieuwe].map(csvCell).join(';'))].join('\n');
  downloadFile(`castvault-auditlog-${todayISODate()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
  toast(`Auditlog geëxporteerd (${rows.length} regels)`, 'success');
}
function wireAuditlogModal() {
  document.getElementById('btn-auditlog').addEventListener('click', () => { renderAuditlogModal(); openModal('modal-auditlog'); });
  document.getElementById('al-contact').addEventListener('change', e => { auditUI.contact = e.target.value; renderAuditlogRows(); });
  document.getElementById('al-actie').addEventListener('change', e => { auditUI.actie = e.target.value; renderAuditlogRows(); });
  document.getElementById('al-van').addEventListener('change', e => { auditUI.van = e.target.value; renderAuditlogRows(); });
  document.getElementById('al-tot').addEventListener('change', e => { auditUI.tot = e.target.value; renderAuditlogRows(); });
  document.getElementById('al-zoek').addEventListener('input', e => { auditUI.zoek = e.target.value; renderAuditlogRows(); });
  document.getElementById('al-csv').addEventListener('click', exportAuditCsv);
  document.getElementById('al-wis').addEventListener('click', () => {
    auditUI.contact = auditUI.actie = auditUI.van = auditUI.tot = auditUI.zoek = '';
    document.getElementById('al-van').value = ''; document.getElementById('al-tot').value = ''; document.getElementById('al-zoek').value = '';
    renderAuditlogModal();
  });
}
wireAuditlogModal();

/* ============================================================
   v0.4 — AVG: VERGEETRECHT-FLOW (art. 17)
   Verwijderen = écht alles weg (contact, foto, logs). Wat blijft:
   een geanonimiseerde tombstone (datum + reden + willekeurig id),
   zodat aantoonbaar is dát en wanneer er iets is verwijderd —
   zonder dat er persoonsgegevens achterblijven.
   ============================================================ */
const DELETE_REDENEN = ['Verzoek van betrokkene (AVG art. 17)', 'Niet meer relevant voor casting', 'Dubbel contact', 'Foutief aangemaakt', 'Anders'];
function openDeleteModal(c) {
  document.getElementById('del-naam').textContent = c.naam || 'Naamloos';
  document.getElementById('del-reden').innerHTML = DELETE_REDENEN.map(r => `<option>${r}</option>`).join('');
  document.getElementById('del-bevestig').value = '';
  document.getElementById('del-msg').textContent = '';
  document.getElementById('del-msg').className = 'auth-msg';
  openModal('modal-delete');
}
function wireDeleteModal() {
  document.getElementById('btn-del-def').addEventListener('click', async () => {
    const c = currentContact(); if (!c) return;
    const msg = document.getElementById('del-msg');
    const typed = document.getElementById('del-bevestig').value.trim();
    if (typed !== (c.naam || '').trim()) {
      msg.textContent = 'Typ de naam exact over om te bevestigen.'; msg.className = 'auth-msg error'; return;
    }
    const reden = document.getElementById('del-reden').value;
    // 1. geanonimiseerde tombstone (géén naam, géén oud id — niets herleidbaars)
    state.deletions.push({ id: crypto.randomUUID(), datum: new Date().toISOString(), reden });
    await saveDeletions();
    // 2. contact + foto + logs definitief weg
    await deleteContact(c.id);
    closeModal('modal-delete');
    toast('Contact volledig verwijderd — geanonimiseerde log-regel bewaard', 'success');
    backToList();
  });
}
wireDeleteModal();

/* ============================================================
   v0.4 — BIOMETRIC UNLOCK (Face ID / Touch ID via WebAuthn)
   Twee niveaus, automatisch gekozen:
   • PRF-modus (recente Safari/Chrome): de sleutel die de vault-
     sleutel beschermt wordt ÉCHT afgeleid uit de biometrie
     (PRF-extensie + HKDF). Zonder vinger/gezicht geen sleutel.
   • Poort-modus (fallback): de vault-sleutel ligt versleuteld op
     het apparaat; biometrie opent het poortje. Handig, maar
     zwakker dan het master-wachtwoord — dat melden we eerlijk.
   Master-wachtwoord blijft ALTIJD werken.
   ============================================================ */
const BIO_PRF_INFO = 'castvault-bio-v1';

async function deriveKeyBits(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, baseKey, 256);
  return new Uint8Array(bits);
}
async function importAesKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function hkdfAesKey(secretBytes) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('castvault-hkdf-salt'), info: enc.encode(BIO_PRF_INFO) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
function bioApiAvailable() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext;
}
async function bioPlatformAvailable() {
  if (!bioApiAvailable()) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; }
}
async function getBioRecord() { return (await dbGet('meta', 'bio')) || null; }

/* Inschakelen: wachtwoord verifiëren -> sleutelbits afleiden -> wrappen met PRF- of poort-sleutel */
async function enableBiometric(password) {
  const meta = await dbGet('meta', 'auth');
  if (!meta) throw new Error('Geen vault gevonden');
  const bits = await deriveKeyBits(password, unb64(meta.salt));
  const testKey = await importAesKey(bits);
  try { await decryptJSON(testKey, meta.verifier); } catch (e) { throw new Error('Master-wachtwoord onjuist'); }

  const cred = await navigator.credentials.create({ publicKey: {
    challenge: randBytes(32),
    rp: { name: 'CastVault', id: location.hostname || undefined },
    user: { id: randBytes(16), name: 'castvault-eigenaar', displayName: 'CastVault' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000,
    extensions: { prf: {} },
  } });
  const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
  const prfSupported = !!(ext.prf && ext.prf.enabled);
  const record = { credId: b64(new Uint8Array(cred.rawId)), aangemaakt: new Date().toISOString() };

  if (prfSupported) {
    // assertion nodig om de PRF-output te krijgen
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: randBytes(32),
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: enc.encode(BIO_PRF_INFO) } } },
    } });
    const aext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const prfOut = aext.prf && aext.prf.results && aext.prf.results.first;
    if (prfOut) {
      const kek = await hkdfAesKey(new Uint8Array(prfOut));
      record.mode = 'prf';
      record.wrapped = await encryptJSON(kek, { k: b64(bits) });
    }
  }
  if (!record.mode) {
    // fallback-poortje: willekeurige sleutel op het apparaat, biometrie als poort
    const gateBytes = randBytes(32);
    const kek = await importAesKey(gateBytes);
    record.mode = 'gate';
    record.gateKey = b64(gateBytes);
    record.wrapped = await encryptJSON(kek, { k: b64(bits) });
  }
  await dbPut('meta', 'bio', record);
  return record.mode;
}
async function disableBiometric() { await dbDelete('meta', 'bio'); }

async function biometricUnlock() {
  const rec = await getBioRecord();
  if (!rec) throw new Error('Biometrie niet ingesteld');
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: randBytes(32),
    allowCredentials: [{ type: 'public-key', id: unb64(rec.credId) }],
    userVerification: 'required', timeout: 60000,
    extensions: rec.mode === 'prf' ? { prf: { eval: { first: enc.encode(BIO_PRF_INFO) } } } : undefined,
  } });
  let kek;
  if (rec.mode === 'prf') {
    const aext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const prfOut = aext.prf && aext.prf.results && aext.prf.results.first;
    if (!prfOut) throw new Error('PRF-output ontbreekt — gebruik je wachtwoord');
    kek = await hkdfAesKey(new Uint8Array(prfOut));
  } else {
    kek = await importAesKey(unb64(rec.gateKey));
  }
  const { k } = await decryptJSON(kek, rec.wrapped);
  const key = await importAesKey(unb64(k));
  const meta = await dbGet('meta', 'auth');
  await decryptJSON(key, meta.verifier); // gooit bij corruptie
  state.key = key;
}

async function refreshBioUnlockBtn() {
  const btn = document.getElementById('bio-unlock-btn');
  if (!btn) return;
  try {
    const rec = bioApiAvailable() ? await getBioRecord() : null;
    btn.style.display = rec ? '' : 'none';
  } catch (e) { btn.style.display = 'none'; }
}
async function handleBioUnlockClick() {
  const msg = document.getElementById('lock-msg');
  msg.textContent = 'Wacht op Touch ID / Face ID…'; msg.className = 'auth-msg';
  try {
    await biometricUnlock();
    msg.textContent = '';
    await loadAllContacts(); await loadTagColors(); await loadDeletions(); await loadSettings();
    showScreen('main'); refreshFilters(); resetAutoLock();
  } catch (e) {
    msg.textContent = 'Biometrie mislukt of geannuleerd — gebruik je wachtwoord.'; msg.className = 'auth-msg error';
  }
}
document.getElementById('bio-unlock-btn').addEventListener('click', handleBioUnlockClick);

/* Instellingen-modal (vingerafdruk-icoon in werkbalk) */
async function openBioModal() {
  const status = document.getElementById('bio-status');
  const enableBlock = document.getElementById('bio-enable-block');
  const disableBtn = document.getElementById('btn-bio-uit');
  document.getElementById('bio-pw').value = '';
  document.getElementById('bio-msg').textContent = ''; document.getElementById('bio-msg').className = 'auth-msg';
  const platformOk = await bioPlatformAvailable();
  const rec = bioApiAvailable() ? await getBioRecord() : null;
  if (!bioApiAvailable() || !platformOk) {
    status.innerHTML = `<span style="color:var(--warn)">Niet beschikbaar op dit apparaat/deze browser.</span> Face ID / Touch ID vereist een recente browser, HTTPS en een apparaat met biometrie. Het master-wachtwoord blijft gewoon werken.`;
    enableBlock.style.display = 'none'; disableBtn.style.display = 'none';
  } else if (rec) {
    status.innerHTML = rec.mode === 'prf'
      ? `<span style="color:var(--success)">Actief — volledige beveiliging (PRF).</span> De beschermsleutel wordt afgeleid uit je biometrie zelf; zonder vinger/gezicht is er geen sleutel.`
      : `<span style="color:var(--warn)">Actief — basisniveau (poort-modus).</span> Deze browser ondersteunt de PRF-extensie niet. Biometrie werkt als poortje; je master-wachtwoord blijft de sterkste beveiliging.`;
    enableBlock.style.display = 'none'; disableBtn.style.display = '';
  } else {
    status.innerHTML = `Nog niet ingesteld. Na inschakelen kun je de vault openen met Face ID / Touch ID; het master-wachtwoord blijft altijd werken. Op browsers met PRF-ondersteuning is dit volwaardig veilig; anders valt de app terug op een eerlijk gelabeld basisniveau.`;
    enableBlock.style.display = ''; disableBtn.style.display = 'none';
  }
  openModal('modal-bio');
}
function wireBioModal() {
  document.getElementById('btn-bio').addEventListener('click', openBioModal);
  document.getElementById('btn-bio-aan').addEventListener('click', async () => {
    const msg = document.getElementById('bio-msg');
    const pw = document.getElementById('bio-pw').value;
    if (!pw) { msg.textContent = 'Voer je master-wachtwoord in.'; msg.className = 'auth-msg error'; return; }
    msg.textContent = 'Instellen… volg de prompt van je apparaat.'; msg.className = 'auth-msg';
    try {
      const mode = await enableBiometric(pw);
      document.getElementById('bio-pw').value = '';
      toast(mode === 'prf' ? 'Biometrie actief (volledige beveiliging)' : 'Biometrie actief (basisniveau)', 'success');
      openBioModal();
    } catch (e) { msg.textContent = e.message || 'Instellen mislukt of geannuleerd.'; msg.className = 'auth-msg error'; }
  });
  document.getElementById('btn-bio-uit').addEventListener('click', async () => {
    if (!confirm('Biometrische ontgrendeling uitschakelen?')) return;
    await disableBiometric();
    toast('Biometrie uitgeschakeld');
    openBioModal();
  });
}
wireBioModal();

/* v0.6.1: CSP blokkeert inline handlers (onclick/oninput) — daarom waren de
   Sluiten/Annuleer-knoppen dood op de live site (jsdom-tests dwingen geen CSP
   af, dus headless bleef alles groen). Fix: data-attributen + gedelegeerde
   listeners. Geen inline JS meer in de hele app. */
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close-modal]');
  if (c) { closeModal(c.dataset.closeModal); return; }
  const o = e.target.closest('[data-open-modal]');
  if (o) openModal(o.dataset.openModal);
});
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('input[type="range"][data-slider]')) {
    const lbl = document.getElementById(e.target.id + '-val');
    if (lbl) lbl.textContent = e.target.value === '0' ? '—' : e.target.value + '/5';
  }
  if (e.target.matches && e.target.matches('input[type="range"][data-flt-slider]')) {
    const lbl = document.getElementById('flt-' + e.target.dataset.fltSlider + '-val');
    if (lbl) lbl.textContent = e.target.value === '0' ? 'alle' : '≥ ' + e.target.value;
  }
});

/* v0.5.1: modals sluiten via backdrop-klik en Escape (UX-fix uit live test) */
document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => { if (e.target === bd) bd.classList.remove('active'); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const open = Array.from(document.querySelectorAll('.modal-backdrop.active')).pop();
    if (open) open.classList.remove('active');
  }
});

(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    const firstRun = await isFirstRun();
    showScreen(firstRun ? 'setup' : 'lock');
    if (!firstRun) refreshBioUnlockBtn();
  } catch (e) { console.error('Init failed:', e); toast('Database kan niet openen', 'error'); }
})();
