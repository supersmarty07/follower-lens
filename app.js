'use strict';

const DB_NAME = 'follower-lens-db';
const DB_VERSION = 2;
const LEGACY_STORE = 'snapshots';
const VAULT_STORE = 'vault';
const META_STORE = 'meta';
const VAULT_CONFIG_KEY = 'config';
const KDF_ITERATIONS = 600000;
const CHECK_VALUE = 'FOLLOWER_LENS_VAULT_CHECK_V2';
const CHECK_AAD = 'follower-lens:check:v2';
const SNAPSHOT_AAD_PREFIX = 'follower-lens:snapshot:v2:';
const AUTO_LOCK_MS = 10 * 60 * 1000;
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const MAX_JSON_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const MAX_JSON_ENTRIES = 1000;
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
const MAX_SNAPSHOTS = 1000;
const MAX_RELATIONSHIPS_PER_LIST = 500000;

let snapshots = [];
let activeTab = 'unfollowers';
let currentView = 'dashboard';
let vaultKey = null;
let vaultConfig = null;
let vaultMode = 'unlock';
let autoLockTimer = null;
let lastActivityAt = Date.now();
let legacyCountAtStart = 0;
let pendingEncryptedBackup = null;
let renderedPeople = [];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const $ = (id) => document.getElementById(id);
const els = {
  importFile: $('importFile'), restoreFile: $('restoreFile'), toast: $('toast'), statusBadge: $('statusBadge'),
  snapshotLabel: $('snapshotLabel'), followersCount: $('followersCount'), followingCount: $('followingCount'),
  newCount: $('newCount'), lostCount: $('lostCount'), mutualCount: $('mutualCount'), notBackCount: $('notBackCount'),
  youDontCount: $('youDontCount'), netCount: $('netCount'), followersDelta: $('followersDelta'), followingDelta: $('followingDelta'),
  historyList: $('historyList'), historyCount: $('historyCount'), peopleList: $('peopleList'), peopleCount: $('peopleCount'),
  search: $('search'), helpModal: $('helpModal'), vaultModal: $('vaultModal'), vaultTitle: $('vaultTitle'),
  vaultIntro: $('vaultIntro'), vaultPassphrase: $('vaultPassphrase'), vaultConfirm: $('vaultConfirm'),
  vaultSubmit: $('vaultSubmit'), vaultReset: $('vaultReset'), vaultStatus: $('vaultStatus'), vaultWarning: $('vaultWarning'),
  restorePassModal: $('restorePassModal'), restorePassphrase: $('restorePassphrase'), restorePassSubmit: $('restorePassSubmit'),
  restorePassCancel: $('restorePassCancel'), restorePassStatus: $('restorePassStatus'),
  timelineModal: $('timelineModal'), timelineTitle: $('timelineTitle'), timelineSummary: $('timelineSummary'),
  timelineList: $('timelineList'), timelineClose: $('timelineClose'), activityList: $('activityList'), activityCount: $('activityCount')
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Local database upgrade is blocked. Close other Follower Lens tabs and reopen the app.'));
  });
}

async function storeGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Database transaction aborted.')); };
  });
}

async function storeGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function storePut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Database transaction aborted.')); };
  });
}

async function storeClear(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Database transaction aborted.')); };
  });
}

async function storeCount(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function deleteLocalDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not delete the local vault database.'));
    req.onblocked = () => reject(new Error('Vault deletion is blocked by another Follower Lens tab. Close other tabs/windows and try again.'));
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function validateVaultConfig(config) {
  if (!config || config.version !== 2 || config.kdf !== 'PBKDF2-SHA-256') throw new Error('Unsupported encrypted vault format.');
  if (!Number.isInteger(config.iterations) || config.iterations < 100000 || config.iterations > 1000000) throw new Error('Invalid vault key-derivation settings.');
  const salt = base64ToBytes(config.salt);
  const iv = base64ToBytes(config.checkIv);
  const cipher = base64ToBytes(config.checkCiphertext);
  if (salt.length < 16 || salt.length > 64 || iv.length !== 12 || cipher.length < 16) throw new Error('Invalid vault encryption metadata.');
  return { salt, iv, cipher };
}

async function deriveKey(passphrase, configOrSalt, iterations = KDF_ITERATIONS) {
  if (!window.crypto?.subtle) throw new Error('Web Crypto is unavailable. Use Follower Lens over HTTPS in a modern browser.');
  const salt = configOrSalt instanceof Uint8Array ? configOrSalt : validateVaultConfig(configOrSalt).salt;
  const rounds = configOrSalt instanceof Uint8Array ? iterations : configOrSalt.iterations;
  const material = await crypto.subtle.importKey('raw', textEncoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptJson(value, key, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aad), tagLength: 128 },
    key,
    plaintext
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptJson(envelope, key, aad) {
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Encrypted record is malformed.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aad), tagLength: 128 },
    key,
    ciphertext
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

async function createVault(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const check = await encryptJson(CHECK_VALUE, key, CHECK_AAD);
  const config = {
    key: VAULT_CONFIG_KEY,
    version: 2,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    checkIv: check.iv,
    checkCiphertext: check.ciphertext,
    createdAt: new Date().toISOString()
  };
  await storePut(META_STORE, config);
  vaultConfig = config;
  vaultKey = key;
}

async function unlockVault(passphrase, config) {
  const key = await deriveKey(passphrase, config);
  let check;
  try {
    check = await decryptJson({ iv: config.checkIv, ciphertext: config.checkCiphertext }, key, CHECK_AAD);
  } catch (_) {
    throw new Error('Incorrect passphrase or damaged vault.');
  }
  if (check !== CHECK_VALUE) throw new Error('Incorrect passphrase or damaged vault.');
  vaultConfig = config;
  vaultKey = key;
}

function ensureUnlocked() {
  if (!vaultKey) {
    showVaultModal(vaultConfig ? 'unlock' : 'setup');
    throw new Error('Follower Lens is locked.');
  }
}

function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').slice(0, 160);
  const importedAt = new Date(value.importedAt);
  if (!id || Number.isNaN(importedAt.getTime())) return null;
  if (!Array.isArray(value.followers) || !Array.isArray(value.following)) return null;
  if (value.followers.length > MAX_RELATIONSHIPS_PER_LIST || value.following.length > MAX_RELATIONSHIPS_PER_LIST) throw new Error('Snapshot is too large to import safely on this device.');
  return {
    id,
    importedAt: importedAt.toISOString(),
    followers: uniq(value.followers),
    following: uniq(value.following)
  };
}

async function vaultPut(snapshot) {
  ensureUnlocked();
  const safe = sanitizeSnapshot(snapshot);
  if (!safe) throw new Error('Invalid snapshot.');
  const encrypted = await encryptJson(safe, vaultKey, SNAPSHOT_AAD_PREFIX + safe.id);
  await storePut(VAULT_STORE, { id: safe.id, iv: encrypted.iv, ciphertext: encrypted.ciphertext });
}

async function decryptVaultRecords(records, key = vaultKey) {
  const good = [];
  let failures = 0;
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') { failures++; continue; }
    try {
      const value = await decryptJson(record, key, SNAPSHOT_AAD_PREFIX + record.id);
      const safe = sanitizeSnapshot(value);
      if (!safe || safe.id !== record.id) throw new Error('Snapshot identity mismatch.');
      good.push(safe);
    } catch (_) {
      failures++;
    }
  }
  return { snapshots: good, failures };
}

async function loadVaultSnapshots() {
  ensureUnlocked();
  const records = await storeGetAll(VAULT_STORE);
  if (records.length > MAX_SNAPSHOTS) throw new Error('Vault contains too many snapshots to load safely.');
  const result = await decryptVaultRecords(records);
  snapshots = result.snapshots.sort((a, b) => new Date(a.importedAt) - new Date(b.importedAt));
  render();
  if (result.failures) toast(`${result.failures} encrypted record${result.failures === 1 ? '' : 's'} failed authentication and were not opened.`, 8000);
}

async function migrateLegacyPlaintext() {
  const legacy = await storeGetAll(LEGACY_STORE);
  if (!legacy.length) return 0;
  ensureUnlocked();
  let migrated = 0;
  for (const item of legacy.slice(0, MAX_SNAPSHOTS)) {
    const safe = sanitizeSnapshot(item);
    if (!safe) continue;
    await vaultPut(safe);
    migrated++;
  }
  await storeClear(LEGACY_STORE);
  return migrated;
}

function uniq(items) {
  return [...new Set(items.map(x => String(x || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))].sort();
}
function diff(a, b) { const bs = new Set(b); return a.filter(x => !bs.has(x)); }
function intersect(a, b) { const bs = new Set(b); return a.filter(x => bs.has(x)); }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function signed(n) { return `${n > 0 ? '+' : ''}${fmt(n)}`; }
function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function latest() { return snapshots.at(-1) || null; }
function previous() { return snapshots.at(-2) || null; }

function relationshipData() {
  const cur = latest();
  const prev = previous();
  if (!cur) return { followers:[], following:[], newFollowers:[], unfollowers:[], mutuals:[], notBack:[], youDont:[], lostMutuals:[] };
  const currentMutuals = intersect(cur.followers, cur.following);
  const previousMutuals = prev ? intersect(prev.followers, prev.following) : [];
  return {
    followers: cur.followers,
    following: cur.following,
    newFollowers: prev ? diff(cur.followers, prev.followers) : [],
    unfollowers: prev ? diff(prev.followers, cur.followers) : [],
    mutuals: currentMutuals,
    notBack: diff(cur.following, cur.followers),
    youDont: diff(cur.followers, cur.following),
    lostMutuals: prev ? diff(previousMutuals, currentMutuals) : []
  };
}

const EVENT_INFO = {
  FOLLOWED_YOU: { label:'Followed you', tone:'good', symbol:'+' },
  REFOLLOWED_YOU: { label:'Re-followed you', tone:'good', symbol:'↻' },
  UNFOLLOWED_YOU: { label:'Unfollowed you', tone:'bad', symbol:'−' },
  YOU_FOLLOWED: { label:'You followed', tone:'good', symbol:'+' },
  YOU_UNFOLLOWED: { label:'You unfollowed', tone:'bad', symbol:'−' },
  BECAME_MUTUAL: { label:'Became mutual', tone:'good', symbol:'◎' },
  LOST_MUTUAL: { label:'Lost mutual', tone:'bad', symbol:'◌' },
  POSSIBLE_UNAVAILABLE: { label:'Possible block / unavailable', tone:'warning', symbol:'?' },
  ACCOUNT_REAPPEARED: { label:'Account reappeared', tone:'good', symbol:'↺' }
};

function buildEventHistory() {
  const events = [];
  if (snapshots.length < 2) return events;
  const seenFollowers = new Set(snapshots[0].followers);
  const seenAny = new Set([...snapshots[0].followers, ...snapshots[0].following]);

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    const pf = new Set(prev.followers), pg = new Set(prev.following);
    const cf = new Set(cur.followers), cg = new Set(cur.following);
    const names = new Set([...pf, ...pg, ...cf, ...cg]);

    for (const name of names) {
      const wasFollower = pf.has(name), isFollower = cf.has(name);
      const wasFollowing = pg.has(name), isFollowing = cg.has(name);
      const wasMutual = wasFollower && wasFollowing;
      const isMutual = isFollower && isFollowing;
      const base = { name, detectedAt:cur.importedAt, fromSnapshotId:prev.id, toSnapshotId:cur.id };

      if (wasFollower && !isFollower) events.push({ ...base, type:'UNFOLLOWED_YOU' });
      if (!wasFollower && isFollower) {
        events.push({ ...base, type:seenFollowers.has(name) ? 'REFOLLOWED_YOU' : 'FOLLOWED_YOU' });
      }
      if (wasFollowing && !isFollowing) events.push({ ...base, type:'YOU_UNFOLLOWED' });
      if (!wasFollowing && isFollowing) events.push({ ...base, type:'YOU_FOLLOWED' });
      if (!wasMutual && isMutual) events.push({ ...base, type:'BECAME_MUTUAL' });
      if (wasMutual && !isMutual) events.push({ ...base, type:'LOST_MUTUAL' });

      // Disappearing from BOTH exported relationship lists can be consistent with a block,
      // but can also be caused by deactivation, deletion, username changes, or both sides
      // changing follow state. Never present this as proof of a block.
      if ((wasFollower || wasFollowing) && !isFollower && !isFollowing) {
        events.push({
          ...base,
          type:'POSSIBLE_UNAVAILABLE',
          confidence:wasMutual ? 'medium' : 'low',
          reason:wasMutual ? 'Previously mutual, then absent from both exported lists.' : 'Previously present in a relationship list, then absent from both exported lists.'
        });
      }

      if (!wasFollower && !wasFollowing && (isFollower || isFollowing) && seenAny.has(name)) {
        events.push({ ...base, type:'ACCOUNT_REAPPEARED' });
      }
    }

    for (const name of cf) seenFollowers.add(name);
    for (const name of cf) seenAny.add(name);
    for (const name of cg) seenAny.add(name);
  }

  return events.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
}

function eventsForUser(name) {
  return buildEventHistory().filter(e => e.name === name);
}

function latestEventUsers(type, onlyCurrentlyPresent = null) {
  const cur = latest();
  if (!cur) return [];
  const cf = new Set(cur.followers), cg = new Set(cur.following);
  const seen = new Set();
  const out = [];
  for (const event of buildEventHistory()) {
    if (event.type !== type || seen.has(event.name)) continue;
    const present = cf.has(event.name) || cg.has(event.name);
    if (onlyCurrentlyPresent === true && !present) continue;
    if (onlyCurrentlyPresent === false && present) continue;
    seen.add(event.name);
    out.push(event);
  }
  return out;
}

function possibleUnavailableEvents() {
  const cur = latest();
  if (!cur) return [];
  const present = new Set([...cur.followers, ...cur.following]);
  const latestByName = new Map();
  for (const event of buildEventHistory()) {
    if (event.type === 'POSSIBLE_UNAVAILABLE' && !latestByName.has(event.name)) latestByName.set(event.name, event);
  }
  return [...latestByName.values()].filter(e => !present.has(e.name));
}

function fmtEventDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function currentRelationshipLabel(name) {
  const cur = latest();
  if (!cur) return 'No current snapshot';
  const follower = cur.followers.includes(name);
  const following = cur.following.includes(name);
  if (follower && following) return 'Currently mutual';
  if (follower) return 'Currently follows you';
  if (following) return 'You currently follow them';
  return 'Not present in either current relationship list';
}

function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

function parseCandidateList(node) {
  const out = [];
  const seen = new Set();
  function visit(v, key = '', depth = 0) {
    if (v == null || depth > 100) return;
    if (Array.isArray(v)) { v.forEach(x => visit(x, key, depth + 1)); return; }
    if (typeof v === 'object') {
      if (typeof v.value === 'string' && /string_list_data/i.test(key)) out.push(v.value);
      if (Array.isArray(v.string_list_data)) {
        v.string_list_data.forEach(item => {
          if (item && typeof item.value === 'string') out.push(item.value);
          else if (item && typeof item.href === 'string') {
            const m = item.href.match(/instagram\.com\/([^/?#]+)/i); if (m) out.push(m[1]);
          }
        });
      }
      for (const [k, val] of Object.entries(v)) visit(val, k, depth + 1);
      return;
    }
    if (typeof v === 'string') {
      const m = v.match(/instagram\.com\/([^/?#]+)/i); if (m) out.push(m[1]);
    }
  }
  visit(node);
  return uniq(out.filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }));
}

function classifyJson(name, data) {
  const lower = name.toLowerCase();
  const extracted = parseCandidateList(data);
  if (/followers(_\d+)?\.json$/.test(lower) || /(^|\/)followers[^/]*\.json$/.test(lower)) return { type:'followers', items:extracted };
  if (/following(\.json)?$/.test(lower.replace(/\.json$/,'')) || /(^|\/)following[^/]*\.json$/.test(lower)) return { type:'following', items:extracted };
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const key = k.toLowerCase();
      if (key.includes('relationships_followers')) return { type:'followers', items:parseCandidateList(v) };
      if (key.includes('relationships_following')) return { type:'following', items:parseCandidateList(v) };
    }
  }
  return null;
}

function readUint32LE(view, off) { return view.getUint32(off, true); }
function readUint16LE(view, off) { return view.getUint16(off, true); }

async function inflateWithLimit(compressed, maxBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const reader = new Blob([compressed]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('A JSON file inside the ZIP is unexpectedly large. Import stopped for safety.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function unzipJson(file) {
  if (!('DecompressionStream' in window)) throw new Error('Your browser cannot decompress ZIP files here. Extract the ZIP on your phone and import the JSON files instead.');
  if (file.size > MAX_ZIP_BYTES) throw new Error('This ZIP is larger than 250 MB. Request only “Followers and following” from Instagram, or extract and import just those JSON files.');
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  const entries = [];

  let eocd = -1;
  const min = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readUint32LE(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This ZIP file could not be read.');
  const count = readUint16LE(view, eocd + 10);
  if (count > MAX_ZIP_ENTRIES) throw new Error('This ZIP contains too many entries to process safely.');
  let pos = readUint32LE(view, eocd + 16);
  let advertisedJsonBytes = 0;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || readUint32LE(view, pos) !== 0x02014b50) break;
    const method = readUint16LE(view, pos + 10);
    const compSize = readUint32LE(view, pos + 20);
    const uncompSize = readUint32LE(view, pos + 24);
    const nameLen = readUint16LE(view, pos + 28);
    const extraLen = readUint16LE(view, pos + 30);
    const commentLen = readUint16LE(view, pos + 32);
    const localOff = readUint32LE(view, pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > bytes.length) throw new Error('ZIP directory is malformed.');
    const name = decoder.decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    if (name.toLowerCase().endsWith('.json')) {
      if (entries.length >= MAX_JSON_ENTRIES) throw new Error('This ZIP contains too many JSON files to process safely.');
      if (uncompSize > MAX_JSON_ENTRY_BYTES) throw new Error('A JSON file inside the ZIP is larger than 25 MB. Import only follower/following JSON files.');
      advertisedJsonBytes += uncompSize;
      if (advertisedJsonBytes > MAX_TOTAL_JSON_BYTES) throw new Error('The ZIP contains more than 50 MB of JSON data. Import only follower/following JSON files.');
      entries.push({ name, method, compSize, uncompSize, localOff });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const files = [];
  for (const e of entries) {
    if (e.localOff + 30 > bytes.length || readUint32LE(view, e.localOff) !== 0x04034b50) continue;
    const nameLen = readUint16LE(view, e.localOff + 26);
    const extraLen = readUint16LE(view, e.localOff + 28);
    const dataStart = e.localOff + 30 + nameLen + extraLen;
    const dataEnd = dataStart + e.compSize;
    if (dataStart < 0 || dataEnd > bytes.length) throw new Error('ZIP entry points outside the archive.');
    const compressed = bytes.slice(dataStart, dataEnd);
    let raw;
    if (e.method === 0) {
      if (compressed.byteLength > MAX_JSON_ENTRY_BYTES) throw new Error('A JSON file inside the ZIP is too large.');
      raw = compressed;
    } else if (e.method === 8) {
      raw = await inflateWithLimit(compressed, MAX_JSON_ENTRY_BYTES);
    } else {
      continue;
    }
    try { files.push({ name:e.name, data:JSON.parse(decoder.decode(raw)) }); } catch (_) {}
  }
  return files;
}

async function parseImport(files) {
  let followers = [];
  let following = [];
  const notes = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const inside = await unzipJson(file);
      if (!inside.length) notes.push(`${file.name}: no readable JSON files`);
      for (const item of inside) {
        const c = classifyJson(item.name, item.data);
        if (c?.type === 'followers') followers.push(...c.items);
        if (c?.type === 'following') following.push(...c.items);
      }
    } else if (lower.endsWith('.json')) {
      if (file.size > MAX_JSON_ENTRY_BYTES) throw new Error('A selected JSON file is larger than 25 MB.');
      try {
        const data = JSON.parse(await file.text());
        const c = classifyJson(file.name, data);
        if (c?.type === 'followers') followers.push(...c.items);
        if (c?.type === 'following') following.push(...c.items);
      } catch (_) { notes.push(`${file.name}: invalid JSON`); }
    }
  }
  followers = uniq(followers);
  following = uniq(following);
  if (followers.length > MAX_RELATIONSHIPS_PER_LIST || following.length > MAX_RELATIONSHIPS_PER_LIST) throw new Error('This account list is too large to process safely on this device.');
  if (!followers.length && !following.length) throw new Error('I could not find Instagram follower/following data. Choose the JSON export and include “Followers and following”.');
  return { followers, following, notes };
}

async function handleImport(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!vaultKey) { showVaultModal(vaultConfig ? 'unlock' : 'setup'); els.importFile.value = ''; return; }
  toast('Reading Instagram export locally…', 120000);
  try {
    const { followers, following } = await parseImport(files);
    const snapshot = {
      id: `${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
      importedAt: new Date().toISOString(),
      followers,
      following
    };
    await vaultPut(snapshot);
    snapshots.push(snapshot);
    snapshots.sort((a, b) => new Date(a.importedAt) - new Date(b.importedAt));
    render();
    resetAutoLock();
    toast(`Encrypted snapshot saved: ${fmt(followers.length)} followers, ${fmt(following.length)} following.`);
  } catch (err) {
    toast(err?.message || 'Import failed.', 8000);
  } finally {
    els.importFile.value = '';
  }
}

function tabDataset() {
  const d = relationshipData();
  const cur = latest();
  const detected = cur ? fmtEventDate(cur.importedAt) : '';
  const basic = (names, label, tone, meta) => names.map(name => ({ name, label, tone, meta }));

  if (activeTab === 'possible') {
    return possibleUnavailableEvents().map(e => ({
      name:e.name,
      label:'Possible unavailable',
      tone:'warning',
      meta:`Detected ${fmtEventDate(e.detectedAt)} • ${e.confidence || 'low'} confidence`
    }));
  }
  if (activeTab === 'refollowers') {
    return latestEventUsers('REFOLLOWED_YOU', true).map(e => ({ name:e.name, label:'Re-follower', tone:'good', meta:`Detected ${fmtEventDate(e.detectedAt)}` }));
  }
  if (activeTab === 'reappeared') {
    return latestEventUsers('ACCOUNT_REAPPEARED', true).map(e => ({ name:e.name, label:'Reappeared', tone:'good', meta:`Detected ${fmtEventDate(e.detectedAt)}` }));
  }
  if (activeTab === 'lostmutuals') {
    return basic(d.lostMutuals, 'Lost mutual', 'bad', detected ? `Since ${detected}` : 'Since previous snapshot');
  }

  const map = {
    unfollowers: basic(d.unfollowers, 'Unfollowed', 'bad', detected ? `Detected ${detected}` : 'Since last import'),
    new: basic(d.newFollowers, 'New follower', 'good', detected ? `Detected ${detected}` : 'Since last import'),
    notback: basic(d.notBack, "Doesn't follow back", 'bad', 'Latest snapshot'),
    mutuals: basic(d.mutuals, 'Mutual', 'good', 'Latest snapshot'),
    followers: basic(d.followers, 'Follower', '', 'Latest snapshot'),
    following: basic(d.following, 'Following', '', 'Latest snapshot')
  };
  return map[activeTab] || [];
}

function renderPeople() {
  if (!vaultKey) {
    renderedPeople = [];
    els.peopleCount.textContent = 'Locked';
    els.peopleList.innerHTML = '<div class="empty">Unlock Follower Lens to view usernames.</div>';
    return;
  }
  const items = tabDataset();
  const q = els.search.value.trim().toLowerCase();
  const filtered = q ? items.filter(x => x.name.includes(q)) : items;
  renderedPeople = filtered.slice(0, 1000);
  els.peopleCount.textContent = `${fmt(items.length)} account${items.length === 1 ? '' : 's'}`;
  if (!filtered.length) {
    els.peopleList.innerHTML = `<div class="empty">${items.length ? 'No usernames match your search.' : 'Nothing to show in this category yet.'}</div>`;
    return;
  }
  els.peopleList.innerHTML = renderedPeople.map((item, index) => `
    <button type="button" class="person person-button" data-person-index="${index}">
      <div style="min-width:0;text-align:left"><div class="handle">@${escapeHtml(item.name)}</div><div class="meta">${escapeHtml(item.meta || 'Latest snapshot')} • Tap for timeline</div></div>
      <div class="pill ${escapeHtml(item.tone || '')}">${escapeHtml(item.label)}</div>
    </button>`).join('');
}

function showTimeline(name) {
  if (!vaultKey || !name) return;
  const first = snapshots[0];
  const events = eventsForUser(name);
  const baselineFollower = first?.followers.includes(name);
  const baselineFollowing = first?.following.includes(name);
  els.timelineTitle.textContent = `@${name}`;
  els.timelineSummary.textContent = currentRelationshipLabel(name);

  const rows = [];
  if (first && (baselineFollower || baselineFollowing)) {
    const baseline = baselineFollower && baselineFollowing ? 'Mutual in first snapshot' : baselineFollower ? 'Follower in first snapshot' : 'Following in first snapshot';
    rows.push(`<div class="timeline-item"><div class="event-symbol">•</div><div><strong>${escapeHtml(baseline)}</strong><div class="meta">Baseline • ${escapeHtml(fmtEventDate(first.importedAt))}</div></div></div>`);
  }
  for (const event of [...events].reverse()) {
    const info = EVENT_INFO[event.type] || {label:event.type, tone:'', symbol:'•'};
    const extra = event.type === 'POSSIBLE_UNAVAILABLE'
      ? `<div class="event-note">${escapeHtml(event.reason || '')} This is a heuristic, not proof of a block.</div>`
      : '';
    rows.push(`<div class="timeline-item"><div class="event-symbol ${escapeHtml(info.tone)}">${escapeHtml(info.symbol)}</div><div><strong>${escapeHtml(info.label)}</strong><div class="meta">${escapeHtml(fmtEventDate(event.detectedAt))}</div>${extra}</div></div>`);
  }
  if (!rows.length) rows.push('<div class="empty">No relationship changes recorded for this account yet.</div>');
  els.timelineList.innerHTML = rows.join('');
  els.timelineModal.classList.remove('hidden');
  resetAutoLock();
}

function hideTimeline() {
  els.timelineModal.classList.add('hidden');
  els.timelineTitle.textContent = '';
  els.timelineSummary.textContent = '';
  els.timelineList.innerHTML = '';
}

function renderActivity() {
  if (!vaultKey) {
    els.activityCount.textContent = 'Locked';
    els.activityList.innerHTML = '<div class="empty">Unlock Follower Lens to view relationship activity.</div>';
    return;
  }
  const events = buildEventHistory();
  els.activityCount.textContent = `${fmt(events.length)} event${events.length === 1 ? '' : 's'}`;
  if (!events.length) {
    els.activityList.innerHTML = '<div class="empty">Import at least two snapshots to build relationship activity.</div>';
    return;
  }
  els.activityList.innerHTML = events.slice(0, 100).map(event => {
    const info = EVENT_INFO[event.type] || {label:event.type, tone:'', symbol:'•'};
    const caveat = event.type === 'POSSIBLE_UNAVAILABLE' ? ' • heuristic only' : '';
    return `<div class="activity-event"><div class="event-symbol ${escapeHtml(info.tone)}">${escapeHtml(info.symbol)}</div><div style="min-width:0"><strong>@${escapeHtml(event.name)}</strong><div class="meta">${escapeHtml(info.label)}${escapeHtml(caveat)} • ${escapeHtml(fmtEventDate(event.detectedAt))}</div></div></div>`;
  }).join('');
}

function renderHistory() {
  if (!vaultKey) {
    els.historyCount.textContent = 'Locked';
    els.historyList.innerHTML = '<div class="empty">Unlock Follower Lens to view snapshot history.</div>';
    return;
  }
  els.historyCount.textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`;
  if (!snapshots.length) { els.historyList.innerHTML = '<div class="empty">Your encrypted snapshots will appear here.</div>'; return; }
  els.historyList.innerHTML = [...snapshots].reverse().map(s => {
    const date = new Date(s.importedAt);
    return `<div class="snap"><strong>${date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</strong><span>${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><span>${fmt(s.followers.length)} followers • ${fmt(s.following.length)} following</span></div>`;
  }).join('');
}

function renderDashboard() {
  if (!vaultKey) {
    ['followersCount','followingCount','newCount','lostCount','mutualCount','notBackCount','youDontCount','netCount','possibleCount','refollowerCount'].forEach(id => $(id).textContent = '—');
    els.statusBadge.textContent = 'Locked 🔒';
    els.snapshotLabel.textContent = 'Unlock to view data';
    els.followersDelta.textContent = 'Encrypted locally';
    els.followingDelta.textContent = 'Passphrase required';
    return;
  }
  const cur = latest(), prev = previous(), d = relationshipData();
  if (!cur) {
    ['followersCount','followingCount','newCount','lostCount','mutualCount','notBackCount','youDontCount','netCount','possibleCount','refollowerCount'].forEach(id => $(id).textContent = '—');
    els.statusBadge.textContent = 'Unlocked 🔓';
    els.snapshotLabel.textContent = 'Import your first snapshot';
    els.followersDelta.textContent = 'Encrypted vault ready';
    els.followingDelta.textContent = 'No snapshot yet';
    return;
  }
  els.statusBadge.textContent = `🔒 ${fmt(cur.followers.length)} followers`;
  els.snapshotLabel.textContent = `Updated ${new Date(cur.importedAt).toLocaleString()}`;
  els.followersCount.textContent = fmt(cur.followers.length);
  els.followingCount.textContent = fmt(cur.following.length);
  els.newCount.textContent = prev ? fmt(d.newFollowers.length) : '—';
  els.lostCount.textContent = prev ? fmt(d.unfollowers.length) : '—';
  els.mutualCount.textContent = fmt(d.mutuals.length);
  els.notBackCount.textContent = fmt(d.notBack.length);
  els.youDontCount.textContent = fmt(d.youDont.length);
  const fdelta = prev ? cur.followers.length - prev.followers.length : 0;
  const gdelta = prev ? cur.following.length - prev.following.length : 0;
  els.netCount.textContent = prev ? signed(d.newFollowers.length - d.unfollowers.length) : '—';
  $('possibleCount').textContent = prev ? fmt(possibleUnavailableEvents().length) : '—';
  $('refollowerCount').textContent = prev ? fmt(latestEventUsers('REFOLLOWED_YOU', true).length) : '—';
  els.followersDelta.textContent = prev ? `${signed(fdelta)} since previous snapshot` : 'First snapshot';
  els.followingDelta.textContent = prev ? `${signed(gdelta)} since previous snapshot` : 'First snapshot';
  els.followersDelta.className = `sub ${fdelta > 0 ? 'positive' : fdelta < 0 ? 'negative' : ''}`;
  els.followingDelta.className = `sub ${gdelta > 0 ? 'positive' : gdelta < 0 ? 'negative' : ''}`;
}

function render() {
  renderDashboard();
  renderHistory();
  renderActivity();
  renderPeople();
}

function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}

function exportCsv() {
  if (!vaultKey) return showVaultModal(vaultConfig ? 'unlock' : 'setup');
  const cur = latest(), prev = previous(), d = relationshipData();
  if (!cur) return toast('Import a snapshot first.');
  if (!confirm('This CSV will contain Instagram usernames in PLAINTEXT outside the encrypted vault. Continue?')) return;
  const rows = [
    ['metric','value'], ['generated_at',new Date().toISOString()], ['snapshot_at',cur.importedAt],
    ['followers',cur.followers.length], ['following',cur.following.length], ['new_followers',prev ? d.newFollowers.length : ''],
    ['unfollowers',prev ? d.unfollowers.length : ''], ['possible_unavailable',prev ? possibleUnavailableEvents().length : ''], ['re_followers',prev ? latestEventUsers('REFOLLOWED_YOU', true).length : ''], ['lost_mutuals',prev ? d.lostMutuals.length : ''], ['mutuals',d.mutuals.length], ['not_following_back',d.notBack.length], ['you_dont_follow_back',d.youDont.length],
    [], ['category','username','detected_at','confidence']
  ];
  for (const x of d.unfollowers) rows.push(['unfollower',x]);
  for (const x of d.newFollowers) rows.push(['new_follower',x]);
  for (const e of possibleUnavailableEvents()) rows.push(['possible_unavailable', e.name, e.detectedAt, e.confidence || 'low']);
  for (const e of latestEventUsers('REFOLLOWED_YOU', true)) rows.push(['re_follower', e.name, e.detectedAt]);
  for (const x of d.lostMutuals) rows.push(['lost_mutual',x]);
  for (const x of d.notBack) rows.push(['not_following_back',x]);
  for (const x of d.mutuals) rows.push(['mutual',x]);
  downloadBlob(`follower-lens-report-${new Date().toISOString().slice(0,10)}.csv`, new Blob([rows.map(r => r.map(csvEscape).join(',')).join('\n')], {type:'text/csv'}));
}

function printReport() {
  if (!vaultKey) return showVaultModal(vaultConfig ? 'unlock' : 'setup');
  const cur = latest(), prev = previous(), d = relationshipData();
  if (!cur) return toast('Import a snapshot first.');
  if (!confirm('The printable report contains usernames in PLAINTEXT while open and in any saved PDF. Continue?')) return;
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups for this site to generate a printable report.');
  const rows = [['Followers',cur.followers.length],['Following',cur.following.length],['New followers',prev ? d.newFollowers.length : '—'],['Unfollowers',prev ? d.unfollowers.length : '—'],['Possible unavailable',prev ? possibleUnavailableEvents().length : '—'],['Re-followers',prev ? latestEventUsers('REFOLLOWED_YOU', true).length : '—'],['Lost mutuals',prev ? d.lostMutuals.length : '—'],['Mutuals',d.mutuals.length],['Not following back',d.notBack.length],['You don’t follow back',d.youDont.length],['Net change',prev ? d.newFollowers.length - d.unfollowers.length : '—']];
  w.document.write(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Follower Lens Report</title><style>body{font-family:system-ui,sans-serif;margin:36px;color:#111}h1{margin-bottom:4px}.muted{color:#666}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:24px 0}.box{border:1px solid #ddd;border-radius:12px;padding:16px}.v{font-size:28px;font-weight:800}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:12px}</style><h1>Follower Lens Report</h1><div class="muted">Snapshot ${escapeHtml(new Date(cur.importedAt).toLocaleString())} • Generated ${escapeHtml(new Date().toLocaleString())}</div><div class="grid">${rows.map(([k,v]) => `<div class="box"><div class="muted">${escapeHtml(k)}</div><div class="v">${escapeHtml(fmt(v))}</div></div>`).join('')}</div><h2>Recent unfollowers</h2><table><tr><th>Username</th></tr>${d.unfollowers.slice(0,250).map(x => `<tr><td>@${escapeHtml(x)}</td></tr>`).join('')}</table><h2>Possible block / unavailable signals</h2><table><tr><th>Username</th><th>Detected</th><th>Confidence</th></tr>${possibleUnavailableEvents().slice(0,250).map(e => `<tr><td>@${escapeHtml(e.name)}</td><td>${escapeHtml(fmtEventDate(e.detectedAt))}</td><td>${escapeHtml(e.confidence || 'low')}</td></tr>`).join('')}</table><p class="muted">This report is based on differences between imported Instagram data snapshots. A missing account does not prove that the account blocked you; deactivation, deletion, username changes, or relationship changes can look similar.</p>`);
  w.document.close();
  w.onafterprint = () => { try { w.close(); } catch (_) {} };
  setTimeout(() => { try { w.print(); } catch (_) {} }, 150);
}

async function backupEncrypted() {
  if (!vaultKey) return showVaultModal(vaultConfig ? 'unlock' : 'setup');
  if (!snapshots.length) return toast('Nothing to back up yet.');
  const config = await storeGet(META_STORE, VAULT_CONFIG_KEY);
  if (!config) return toast('Vault configuration is missing.');
  // Re-encrypt the authenticated in-memory snapshots with fresh IVs instead of copying raw DB records.
  const records = [];
  for (const snapshot of snapshots) {
    const encrypted = await encryptJson(snapshot, vaultKey, SNAPSHOT_AAD_PREFIX + snapshot.id);
    records.push({ id: snapshot.id, iv: encrypted.iv, ciphertext: encrypted.ciphertext });
  }
  const backup = {
    format: 'follower-lens-encrypted-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    encryption: {
      version: config.version,
      cipher: config.cipher,
      kdf: config.kdf,
      iterations: config.iterations,
      salt: config.salt,
      checkIv: config.checkIv,
      checkCiphertext: config.checkCiphertext
    },
    records
  };
  downloadBlob(`follower-lens-encrypted-backup-${new Date().toISOString().slice(0,10)}.flens.json`, new Blob([JSON.stringify(backup)], {type:'application/json'}));
  toast('Encrypted backup created. Keep its passphrase safe.');
}

async function restoreEncryptedBackup(data, suppliedPassphrase) {
  if (!data || data.format !== 'follower-lens-encrypted-backup' || data.version !== 2 || !Array.isArray(data.records)) throw new Error('Invalid encrypted Follower Lens backup.');
  if (data.records.length > MAX_SNAPSHOTS) throw new Error('Backup contains too many snapshots.');
  const backupConfig = { key:VAULT_CONFIG_KEY, ...data.encryption };
  validateVaultConfig(backupConfig);
  let passphrase = suppliedPassphrase;
  if (!passphrase) throw new Error('Enter the backup passphrase.');
  let backupKey;
  try {
    backupKey = await deriveKey(passphrase, backupConfig);
    const check = await decryptJson({iv:backupConfig.checkIv,ciphertext:backupConfig.checkCiphertext}, backupKey, CHECK_AAD);
    if (check !== CHECK_VALUE) throw new Error('Wrong backup passphrase.');
  } catch (_) {
    passphrase = '';
    throw new Error('Wrong backup passphrase or damaged encrypted backup.');
  }
  passphrase = '';
  const result = await decryptVaultRecords(data.records, backupKey);
  if (result.failures) throw new Error(`${result.failures} backup record${result.failures === 1 ? '' : 's'} failed authentication. Restore stopped.`);
  let restored = 0;
  for (const s of result.snapshots) { await vaultPut(s); restored++; }
  return restored;
}

function showRestorePassModal(data) {
  pendingEncryptedBackup = data;
  els.restorePassphrase.value = '';
  els.restorePassStatus.textContent = 'The restored snapshots will be re-encrypted with your currently unlocked vault key.';
  els.restorePassModal.classList.remove('hidden');
  setTimeout(() => els.restorePassphrase.focus(), 50);
}

function hideRestorePassModal() {
  pendingEncryptedBackup = null;
  els.restorePassphrase.value = '';
  els.restorePassSubmit.disabled = false;
  els.restorePassModal.classList.add('hidden');
}

async function submitRestorePassphrase() {
  if (!pendingEncryptedBackup) return hideRestorePassModal();
  let passphrase = els.restorePassphrase.value;
  if (!passphrase) return toast('Enter the backup passphrase.');
  els.restorePassSubmit.disabled = true;
  els.restorePassStatus.textContent = 'Authenticating and decrypting backup locally…';
  try {
    const restored = await restoreEncryptedBackup(pendingEncryptedBackup, passphrase);
    passphrase = '';
    await loadVaultSnapshots();
    hideRestorePassModal();
    toast(`${restored} snapshot${restored === 1 ? '' : 's'} restored into the encrypted vault.`);
  } catch (e) {
    passphrase = '';
    els.restorePassphrase.value = '';
    els.restorePassSubmit.disabled = false;
    els.restorePassStatus.textContent = 'Restore failed. The backup was not trusted or the passphrase was incorrect.';
    toast(e?.message || 'Restore failed.', 8000);
    els.restorePassphrase.focus();
  }
}

async function restoreLegacyBackup(data) {
  if (!Array.isArray(data?.snapshots)) throw new Error('Invalid backup file.');
  if (data.snapshots.length > MAX_SNAPSHOTS) throw new Error('Backup contains too many snapshots.');
  if (!confirm('This is an older PLAINTEXT Follower Lens backup. Its contents will be encrypted into the new vault. Continue?')) return 0;
  let restored = 0;
  for (const s of data.snapshots) {
    const safe = sanitizeSnapshot(s);
    if (!safe) continue;
    await vaultPut(safe);
    restored++;
  }
  return restored;
}

async function restoreBackup(file) {
  if (!vaultKey) { showVaultModal(vaultConfig ? 'unlock' : 'setup'); els.restoreFile.value = ''; return; }
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup file is too large to restore safely.');
    const data = JSON.parse(await file.text());
    if (data?.format === 'follower-lens-encrypted-backup' && data?.version === 2) {
      validateVaultConfig({ key:VAULT_CONFIG_KEY, ...data.encryption });
      if (!Array.isArray(data.records) || data.records.length > MAX_SNAPSHOTS) throw new Error('Invalid or oversized encrypted backup.');
      showRestorePassModal(data);
    } else {
      const restored = await restoreLegacyBackup(data);
      if (restored) {
        await loadVaultSnapshots();
        toast(`${restored} snapshot${restored === 1 ? '' : 's'} restored into the encrypted vault.`);
      }
    }
  } catch (e) {
    toast(e?.message || 'Restore failed.', 8000);
  }
  els.restoreFile.value = '';
}

function showView(view) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach(el => el.style.display = el.dataset.view === view ? '' : 'none');
  document.querySelectorAll('[data-nav]').forEach(btn => btn.classList.toggle('active', btn.dataset.nav === view));
  document.getElementById('homeHero').style.display = view === 'dashboard' ? '' : 'none';
  window.scrollTo({top:0, behavior:'smooth'});
}

function showVaultModal(mode) {
  vaultMode = mode;
  const setup = mode === 'setup';
  els.vaultModal.classList.remove('hidden');
  els.vaultTitle.textContent = setup ? 'Create your encrypted vault' : 'Unlock Follower Lens';
  els.vaultIntro.textContent = setup
    ? (legacyCountAtStart ? `Create a passphrase. Your ${legacyCountAtStart} existing plaintext snapshot${legacyCountAtStart === 1 ? '' : 's'} will then be encrypted and the plaintext copy removed.` : 'Create a passphrase before importing Instagram data. It never leaves this browser and is not stored.')
    : 'Enter your passphrase to decrypt your local follower history.';
  els.vaultPassphrase.value = '';
  els.vaultPassphrase.autocomplete = setup ? 'new-password' : 'current-password';
  els.vaultConfirm.value = '';
  els.vaultConfirm.classList.toggle('hidden', !setup);
  els.vaultReset.classList.toggle('hidden', setup);
  els.vaultSubmit.textContent = setup ? 'Create encrypted vault' : 'Unlock';
  els.vaultWarning.textContent = setup
    ? 'Use at least 12 characters. The passphrase is never stored. If you forget it, encrypted history cannot be recovered without an encrypted backup and its passphrase.'
    : 'Your passphrase is never stored. If you forget it, use an encrypted backup or erase the local vault and start again.';
  els.vaultStatus.textContent = `Encryption: AES-256-GCM • PBKDF2-SHA-256 (${KDF_ITERATIONS.toLocaleString()} rounds) • Auto-lock: 10 minutes`;
  setTimeout(() => els.vaultPassphrase.focus(), 50);
}

function hideVaultModal() {
  els.vaultModal.classList.add('hidden');
  els.vaultPassphrase.value = '';
  els.vaultConfirm.value = '';
}

function setVaultBusy(busy, text) {
  els.vaultSubmit.disabled = busy;
  els.vaultReset.disabled = busy;
  if (text) els.vaultStatus.textContent = text;
}

async function submitVault() {
  let passphrase = els.vaultPassphrase.value;
  if (!passphrase) return toast('Enter your passphrase.');
  setVaultBusy(true, vaultMode === 'setup' ? 'Deriving encryption key and creating vault…' : 'Deriving key and authenticating vault…');
  try {
    if (vaultMode === 'setup') {
      const confirmation = els.vaultConfirm.value;
      if (passphrase.length < 12) throw new Error('Use a passphrase with at least 12 characters.');
      if (passphrase !== confirmation) throw new Error('Passphrases do not match.');
      await createVault(passphrase);
      passphrase = '';
      const migrated = await migrateLegacyPlaintext();
      legacyCountAtStart = 0;
      await loadVaultSnapshots();
      hideVaultModal();
      resetAutoLock();
      toast(migrated ? `${migrated} old snapshot${migrated === 1 ? '' : 's'} encrypted; plaintext copy removed.` : 'Encrypted vault created.');
    } else {
      await unlockVault(passphrase, vaultConfig);
      passphrase = '';
      const migrated = await migrateLegacyPlaintext();
      legacyCountAtStart = 0;
      await loadVaultSnapshots();
      hideVaultModal();
      resetAutoLock();
      toast(migrated ? `Unlocked. ${migrated} legacy snapshot${migrated === 1 ? '' : 's'} encrypted.` : 'Follower Lens unlocked.');
    }
  } catch (e) {
    passphrase = '';
    toast(e?.message || 'Could not unlock the vault.', 7000);
    els.vaultPassphrase.value = '';
    els.vaultConfirm.value = '';
    els.vaultPassphrase.focus();
  } finally {
    setVaultBusy(false, `Encryption: AES-256-GCM • PBKDF2-SHA-256 (${KDF_ITERATIONS.toLocaleString()} rounds) • Auto-lock: 10 minutes`);
  }
}

function lockNow(showToast = true) {
  if (!vaultKey) { showVaultModal(vaultConfig ? 'unlock' : 'setup'); return; }
  if (pendingEncryptedBackup || !els.restorePassModal.classList.contains('hidden')) hideRestorePassModal();
  hideTimeline();
  vaultKey = null;
  snapshots = [];
  els.search.value = '';
  clearTimeout(autoLockTimer);
  autoLockTimer = null;
  render();
  showVaultModal('unlock');
  if (showToast) toast('Follower Lens locked. Decrypted views were cleared and the in-memory key was released.');
}

function resetAutoLock() {
  if (!vaultKey) return;
  lastActivityAt = Date.now();
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => lockNow(false), AUTO_LOCK_MS);
}

function resumeAutoLock() {
  if (!vaultKey) return;
  const elapsed = Date.now() - lastActivityAt;
  if (elapsed >= AUTO_LOCK_MS) { lockNow(false); return; }
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => lockNow(false), AUTO_LOCK_MS - elapsed);
}


async function eraseLocalVault() {
  const phrase = 'ERASE';
  const typed = prompt(`This permanently deletes encrypted Follower Lens history from this browser. Type ${phrase} to continue:`);
  if (typed !== phrase) return;
  if (pendingEncryptedBackup || !els.restorePassModal.classList.contains('hidden')) hideRestorePassModal();
  await deleteLocalDatabase();
  snapshots = [];
  els.search.value = '';
  vaultKey = null;
  vaultConfig = null;
  legacyCountAtStart = 0;
  clearTimeout(autoLockTimer);
  render();
  showVaultModal('setup');
  toast('Local vault erased. App files remain installed, but follower history is gone.', 6500);
}

els.importFile.addEventListener('change', e => handleImport(e.target.files));
els.restoreFile.addEventListener('change', e => e.target.files[0] && restoreBackup(e.target.files[0]));
els.search.addEventListener('input', () => { renderPeople(); resetAutoLock(); });
els.peopleList.addEventListener('click', e => {
  const button = e.target.closest('[data-person-index]');
  if (!button) return;
  const item = renderedPeople[Number(button.dataset.personIndex)];
  if (item) showTimeline(item.name);
});
els.timelineClose.addEventListener('click', hideTimeline);
els.timelineModal.addEventListener('click', e => { if (e.target === els.timelineModal) hideTimeline(); });
document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
  activeTab = btn.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
  renderPeople();
  resetAutoLock();
}));
document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => { showView(btn.dataset.nav); resetAutoLock(); }));
$('downloadCsv').addEventListener('click', exportCsv);
$('printReport').addEventListener('click', printReport);
$('backupData').addEventListener('click', () => backupEncrypted().catch(e => toast(e?.message || 'Backup failed.', 7000)));
$('lockNow').addEventListener('click', () => lockNow());
els.statusBadge.addEventListener('click', () => vaultKey ? lockNow() : showVaultModal(vaultConfig ? 'unlock' : 'setup'));
$('clearData').addEventListener('click', () => eraseLocalVault().catch(e => toast(e?.message || 'Could not erase local vault.', 7000)));
$('showHelp').addEventListener('click', () => els.helpModal.classList.remove('hidden'));
$('closeHelp').addEventListener('click', () => els.helpModal.classList.add('hidden'));
els.helpModal.addEventListener('click', e => { if (e.target === els.helpModal) els.helpModal.classList.add('hidden'); });
els.vaultSubmit.addEventListener('click', submitVault);
els.vaultReset.addEventListener('click', () => eraseLocalVault().catch(e => toast(e?.message || 'Could not erase local vault.', 7000)));
els.vaultPassphrase.addEventListener('keydown', e => { if (e.key === 'Enter' && vaultMode === 'unlock') submitVault(); });
els.vaultConfirm.addEventListener('keydown', e => { if (e.key === 'Enter' && vaultMode === 'setup') submitVault(); });
els.restorePassSubmit.addEventListener('click', submitRestorePassphrase);
els.restorePassCancel.addEventListener('click', hideRestorePassModal);
els.restorePassphrase.addEventListener('keydown', e => { if (e.key === 'Enter') submitRestorePassphrase(); });

['pointerdown', 'keydown', 'touchstart'].forEach(type => document.addEventListener(type, () => { if (vaultKey) resetAutoLock(); }, {passive:true}));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && vaultKey) resumeAutoLock();
});

(async function init() {
  if (window.top !== window.self) {
    document.body.textContent = 'Follower Lens refuses to run inside an embedded frame.';
    return;
  }
  showView('dashboard');
  render();
  try {
    if (!window.crypto?.subtle) throw new Error('Web Crypto is unavailable. Open this app from its HTTPS GitHub Pages address in a modern browser.');
    // Opening the database also performs the v1 -> v2 schema upgrade without touching legacy plaintext yet.
    const db = await openDb();
    db.close();
    legacyCountAtStart = await storeCount(LEGACY_STORE);
    vaultConfig = await storeGet(META_STORE, VAULT_CONFIG_KEY);
    if (vaultConfig) {
      validateVaultConfig(vaultConfig);
      showVaultModal('unlock');
    } else {
      showVaultModal('setup');
    }
  } catch (e) {
    toast(e?.message || 'Secure local storage could not be opened.', 10000);
    els.vaultStatus.textContent = 'Secure storage unavailable in this browser.';
    showVaultModal('setup');
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
