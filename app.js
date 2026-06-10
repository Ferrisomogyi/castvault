/* ============================================================
   CastVault v0.1
   - AES-256-GCM encryption with PBKDF2 (250k iter)
   - IndexedDB storage
   - vCard 3.0/4.0 parser
   - In-memory fuzzy search
   ============================================================ */

// ============ CRYPTO ============
const PBKDF2_ITERATIONS = 250000;
const SALT_LEN = 16;
const IV_LEN = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function randBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptJSON(key, obj) {
  const iv = randBytes(IV_LEN);
  const plaintext = enc.encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: b64(iv), ct: b64(ciphertext) };
}

async function decryptJSON(key, blob) {
  const iv = unb64(blob.iv);
  const ct = unb64(blob.ct);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(plaintext));
}

// ============ INDEXEDDB ============
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
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); }
      else resolve(out);
    };
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

// ============ APP STATE ============
const state = {
  key: null,            // in-memory CryptoKey (gone on lock)
  contacts: new Map(),  // id -> decrypted contact
  searchQuery: '',
  autoLockTimer: null,
  AUTO_LOCK_MS: 5 * 60 * 1000, // 5 minutes
};

// ============ AUTH FLOW ============
async function isFirstRun() {
  const meta = await dbGet('meta', 'auth');
  return !meta;
}

async function setupVault(password) {
  const salt = randBytes(SALT_LEN);
  const key = await deriveKey(password, salt);
  // Verification token: encrypt a known string
  const verifier = await encryptJSON(key, { v: 'castvault-ok', ts: Date.now() });
  await dbPut('meta', 'auth', {
    salt: b64(salt),
    iter: PBKDF2_ITERATIONS,
    verifier,
    created: new Date().toISOString(),
  });
  state.key = key;
}

async function unlockVault(password) {
  const meta = await dbGet('meta', 'auth');
  if (!meta) throw new Error('Geen vault gevonden');
  const salt = unb64(meta.salt);
  const key = await deriveKey(password, salt);
  try {
    await decryptJSON(key, meta.verifier);
    state.key = key;
    return true;
  } catch (e) {
    return false;
  }
}

async function loadAllContacts() {
  const entries = await dbAll('contacts');
  state.contacts.clear();
  for (const { key, value } of entries) {
    try {
      const c = await decryptJSON(state.key, value);
      state.contacts.set(key, c);
    } catch (e) {
      console.warn('Decrypt failed for', key);
    }
  }
}

async function saveContact(contact) {
  if (!contact.id) contact.id = crypto.randomUUID();
  contact.updatedAt = new Date().toISOString();
  if (!contact.createdAt) contact.createdAt = contact.updatedAt;
  const blob = await encryptJSON(state.key, contact);
  await dbPut('contacts', contact.id, blob);
  state.contacts.set(contact.id, contact);
}

function lockVault() {
  state.key = null;
  state.contacts.clear();
  clearTimeout(state.autoLockTimer);
  showScreen('lock');
  document.getElementById('lock-pw').value = '';
  document.getElementById('lock-msg').textContent = '';
}

function resetAutoLock() {
  clearTimeout(state.autoLockTimer);
  if (state.key) {
    state.autoLockTimer = setTimeout(lockVault, state.AUTO_LOCK_MS);
  }
}

// ============ VCARD PARSER ============
function unfoldVCard(text) {
  // RFC: lines starting with whitespace are continuation of previous line
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function decodeQuotedPrintable(s) {
  return s.replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseVCardLine(line) {
  // FORMAT: FIELD[;PARAMS]:VALUE
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const header = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1);
  const parts = header.split(';');
  const field = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('=')) {
      const [k, v] = p.split('=');
      params[k.toUpperCase()] = v;
    } else {
      // shorthand type
      params.TYPE = (params.TYPE ? params.TYPE + ',' : '') + p;
    }
  }
  let decoded = value;
  if (params.ENCODING && params.ENCODING.toUpperCase() === 'QUOTED-PRINTABLE') {
    decoded = decodeQuotedPrintable(value);
  }
  // unescape \, \; \n
  decoded = decoded.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  return { field, params, value: decoded };
}

function normalizePhone(p) {
  return p.replace(/[^\d+]/g, '');
}

function parseVCards(text) {
  const unfolded = unfoldVCard(text);
  const cards = [];
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const endIdx = block.search(/END:VCARD/i);
    const body = endIdx >= 0 ? block.substring(0, endIdx) : block;
    const lines = body.split(/\r?\n/).filter(l => l.trim());
    const contact = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      naam: '', voornaam: '', achternaam: '',
      telefoon: [], email: [],
      adres: {},
      geboortedatum: null,
      bio: '',
      notities: [],
      tags: [],
      auditLog: [{ datum: new Date().toISOString(), actie: 'import', bron: 'vCard' }],
    };

    for (const raw of lines) {
      const parsed = parseVCardLine(raw);
      if (!parsed) continue;
      const { field, params, value } = parsed;

      if (field === 'FN') {
        contact.naam = value.trim();
      } else if (field === 'N') {
        // achternaam;voornaam;tussen;voorvoegsel;achtervoegsel
        const np = value.split(';');
        contact.achternaam = (np[0] || '').trim();
        contact.voornaam = (np[1] || '').trim();
      } else if (field === 'TEL') {
        const t = params.TYPE || '';
        contact.telefoon.push({ label: t, nummer: normalizePhone(value) });
      } else if (field === 'EMAIL') {
        const t = params.TYPE || '';
        contact.email.push({ label: t, adres: value.trim() });
      } else if (field === 'ADR') {
        // pobox;extended;street;city;region;postal;country
        const a = value.split(';');
        contact.adres = {
          straat: (a[2] || '').trim(),
          postcode: (a[5] || '').trim(),
          woonplaats: (a[3] || '').trim(),
          land: (a[6] || '').trim(),
        };
      } else if (field === 'BDAY') {
        contact.geboortedatum = value.trim();
      } else if (field === 'ORG') {
        contact.organisatie = value.replace(/;/g, ' - ').trim();
      } else if (field === 'NOTE') {
        if (value.trim()) {
          contact.notities.push({ datum: new Date().toISOString(), tekst: value.trim() });
        }
      }
    }

    if (!contact.naam) {
      contact.naam = (contact.voornaam + ' ' + contact.achternaam).trim() || 'Onbekend';
    }
    if (contact.naam !== 'Onbekend' || contact.telefoon.length || contact.email.length) {
      cards.push(contact);
    }
  }
  return cards;
}

// ============ SEARCH ============
function searchContacts(query) {
  const q = query.trim().toLowerCase();
  const all = Array.from(state.contacts.values());
  if (!q) return all.sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));
  const matches = [];
  for (const c of all) {
    let score = 0;
    const naam = (c.naam || '').toLowerCase();
    if (naam === q) score += 100;
    else if (naam.startsWith(q)) score += 50;
    else if (naam.includes(q)) score += 20;
    for (const t of c.telefoon || []) {
      if (t.nummer.includes(q.replace(/[^\d+]/g, ''))) score += 15;
    }
    for (const e of c.email || []) {
      if (e.adres.toLowerCase().includes(q)) score += 15;
    }
    for (const tag of c.tags || []) {
      if (tag.toLowerCase().includes(q)) score += 10;
    }
    if ((c.bio || '').toLowerCase().includes(q)) score += 5;
    if (score > 0) matches.push({ c, score });
  }
  return matches.sort((a, b) => b.score - a.score).map(m => m.c);
}

// ============ UI HELPERS ============
function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  document.getElementById('screen-' + name).classList.add('active');
}

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function initials(naam) {
  const parts = (naam || '').trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderContacts() {
  const list = document.getElementById('contact-list');
  const results = searchContacts(state.searchQuery);
  document.getElementById('stat-count').textContent = state.contacts.size;

  if (state.contacts.size === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">∅</div>
        <div class="empty-state-title">Lege vault</div>
        <div class="empty-state-text">Importeer je iPhone-contacten om te beginnen.<br>Of voeg er één met de hand toe.</div>
        <button class="btn-primary" style="max-width:240px;margin:0 auto;" onclick="openModal('modal-import')">Importeer .vcf</button>
      </div>`;
    return;
  }

  if (results.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-text">Geen resultaten voor "${escapeHtml(state.searchQuery)}".</div></div>`;
    return;
  }

  list.innerHTML = results.map(c => {
    const sub = (c.telefoon?.[0]?.nummer) || (c.email?.[0]?.adres) || (c.tags?.join(' · ')) || '—';
    const hasRedFlag = (c.redFlags || []).some(r => r.kleur === 'rood');
    return `
      <div class="contact-card" data-id="${c.id}">
        <div class="avatar">${escapeHtml(initials(c.naam))}</div>
        <div class="contact-meta">
          <div class="contact-name">${escapeHtml(c.naam)}</div>
          <div class="contact-sub">${escapeHtml(sub)}</div>
        </div>
        ${hasRedFlag ? '<div class="red-flag-dot" title="Red flag"></div>' : ''}
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ============ PASSWORD STRENGTH ============
function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 12) score += 25;
  if (pw.length >= 16) score += 15;
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/[0-9]/.test(pw)) score += 15;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 20;
  return Math.min(score, 100);
}

function updateStrength(pw) {
  const bar = document.getElementById('strength-bar');
  const label = document.getElementById('strength-label');
  const s = passwordStrength(pw);
  bar.style.width = s + '%';
  if (s < 40) { bar.style.background = 'var(--danger)'; label.textContent = 'Zwak'; }
  else if (s < 70) { bar.style.background = 'var(--warn)'; label.textContent = 'Redelijk'; }
  else { bar.style.background = 'var(--success)'; label.textContent = 'Sterk'; }
}

// ============ EVENT HANDLERS ============
document.getElementById('setup-pw1').addEventListener('input', e => updateStrength(e.target.value));

document.getElementById('setup-btn').addEventListener('click', async () => {
  const pw1 = document.getElementById('setup-pw1').value;
  const pw2 = document.getElementById('setup-pw2').value;
  const msg = document.getElementById('setup-msg');
  if (pw1.length < 12) {
    msg.textContent = 'Wachtwoord moet minimaal 12 tekens zijn.'; msg.className = 'auth-msg error'; return;
  }
  if (pw1 !== pw2) {
    msg.textContent = 'Wachtwoorden komen niet overeen.'; msg.className = 'auth-msg error'; return;
  }
  msg.textContent = 'Vault wordt aangemaakt…'; msg.className = 'auth-msg';
  try {
    await setupVault(pw1);
    document.getElementById('setup-pw1').value = '';
    document.getElementById('setup-pw2').value = '';
    showScreen('main');
    renderContacts();
    resetAutoLock();
    toast('Vault aangemaakt. Welkom.', 'success');
  } catch (e) {
    msg.textContent = 'Fout: ' + e.message; msg.className = 'auth-msg error';
  }
});

document.getElementById('lock-btn').addEventListener('click', async () => {
  const pw = document.getElementById('lock-pw').value;
  const msg = document.getElementById('lock-msg');
  const input = document.getElementById('lock-pw');
  if (!pw) { msg.textContent = 'Voer wachtwoord in.'; msg.className = 'auth-msg error'; return; }
  msg.textContent = 'Ontgrendelen…'; msg.className = 'auth-msg';
  const ok = await unlockVault(pw);
  if (ok) {
    document.getElementById('lock-pw').value = '';
    msg.textContent = '';
    await loadAllContacts();
    showScreen('main');
    renderContacts();
    resetAutoLock();
  } else {
    msg.textContent = 'Wachtwoord onjuist.'; msg.className = 'auth-msg error';
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 500);
  }
});

document.getElementById('lock-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('lock-btn').click();
});
document.getElementById('setup-pw2').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-btn').click();
});

document.getElementById('btn-lock').addEventListener('click', lockVault);
document.getElementById('btn-import').addEventListener('click', () => openModal('modal-import'));

document.getElementById('search').addEventListener('input', e => {
  state.searchQuery = e.target.value;
  renderContacts();
  resetAutoLock();
});

// File drop for vCard
const fileDrop = document.getElementById('file-drop');
const fileInput = document.getElementById('file-input');

fileDrop.addEventListener('click', () => fileInput.click());
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('dragover'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  fileDrop.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleVCardFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleVCardFile(e.target.files[0]);
});

async function handleVCardFile(file) {
  try {
    toast('Bestand lezen…');
    const text = await file.text();
    const cards = parseVCards(text);
    if (cards.length === 0) { toast('Geen vCards gevonden', 'error'); return; }

    toast(`${cards.length} contacten gevonden, versleutelen…`);
    let imported = 0, skipped = 0;
    const existingPhones = new Set();
    const existingEmails = new Set();
    for (const c of state.contacts.values()) {
      for (const t of c.telefoon || []) existingPhones.add(t.nummer);
      for (const e of c.email || []) existingEmails.add(e.adres.toLowerCase());
    }

    for (const card of cards) {
      const dup = card.telefoon.some(t => existingPhones.has(t.nummer))
               || card.email.some(e => existingEmails.has(e.adres.toLowerCase()));
      if (dup) { skipped++; continue; }
      await saveContact(card);
      imported++;
    }
    closeModal('modal-import');
    renderContacts();
    toast(`${imported} geïmporteerd${skipped ? `, ${skipped} duplicaten overgeslagen` : ''}`, 'success');
  } catch (e) {
    console.error(e);
    toast('Fout bij importeren: ' + e.message, 'error');
  }
}

// Reset auto-lock on any interaction
['click', 'touchstart', 'keydown'].forEach(ev => {
  document.addEventListener(ev, () => { if (state.key) resetAutoLock(); }, { passive: true });
});

// Visibility -> lock on background after delay (extra security)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.key) {
    // optional: lock immediately on hide
    // lockVault();
  }
});

// ============ INIT ============
(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    const firstRun = await isFirstRun();
    showScreen(firstRun ? 'setup' : 'lock');
  } catch (e) {
    console.error('Init failed:', e);
    toast('Database kan niet openen', 'error');
  }
})();
document.getElementById('btn-new').addEventListener('click', () => {
  toast('Handmatig contact toevoegen komt in v0.2', '');
});
