const DB_NAME = 'follower-lens-db';
const STORE = 'snapshots';
const DB_VERSION = 1;

let snapshots = [];
let activeTab = 'unfollowers';
let currentView = 'dashboard';

const $ = (id) => document.getElementById(id);
const els = {
  importFile: $('importFile'), restoreFile: $('restoreFile'), toast: $('toast'), statusBadge: $('statusBadge'),
  snapshotLabel: $('snapshotLabel'), followersCount: $('followersCount'), followingCount: $('followingCount'),
  newCount: $('newCount'), lostCount: $('lostCount'), mutualCount: $('mutualCount'), notBackCount: $('notBackCount'),
  youDontCount: $('youDontCount'), netCount: $('netCount'), followersDelta: $('followersDelta'), followingDelta: $('followingDelta'),
  historyList: $('historyList'), historyCount: $('historyCount'), peopleList: $('peopleList'), peopleCount: $('peopleCount'),
  search: $('search'), helpModal: $('helpModal')
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(snapshot) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(snapshot);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
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
  if (!cur) return { followers:[], following:[], newFollowers:[], unfollowers:[], mutuals:[], notBack:[], youDont:[] };
  return {
    followers: cur.followers,
    following: cur.following,
    newFollowers: prev ? diff(cur.followers, prev.followers) : [],
    unfollowers: prev ? diff(prev.followers, cur.followers) : [],
    mutuals: intersect(cur.followers, cur.following),
    notBack: diff(cur.following, cur.followers),
    youDont: diff(cur.followers, cur.following)
  };
}

function toast(message, ms=3200) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

function parseCandidateList(node) {
  const out = [];
  const seen = new Set();
  function visit(v, key='') {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(x => visit(x, key)); return; }
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
      for (const [k,val] of Object.entries(v)) visit(val, k);
      return;
    }
    if (typeof v === 'string') {
      const m = v.match(/instagram\.com\/([^/?#]+)/i); if (m) out.push(m[1]);
    }
  }
  visit(node);
  return uniq(out.filter(x => { const k=x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }));
}

function classifyJson(name, data) {
  const lower = name.toLowerCase();
  const extracted = parseCandidateList(data);
  if (/followers(_\d+)?\.json$/.test(lower) || /(^|\/)followers[^/]*\.json$/.test(lower)) return { type:'followers', items:extracted };
  if (/following(\.json)?$/.test(lower.replace(/\.json$/,'')) || /(^|\/)following[^/]*\.json$/.test(lower)) return { type:'following', items:extracted };
  // Handle common wrapped keys if filenames are unusual.
  if (data && typeof data === 'object') {
    for (const [k,v] of Object.entries(data)) {
      const key = k.toLowerCase();
      if (key.includes('relationships_followers')) return { type:'followers', items:parseCandidateList(v) };
      if (key.includes('relationships_following')) return { type:'following', items:parseCandidateList(v) };
    }
  }
  return null;
}

function readUint32LE(view, off) { return view.getUint32(off, true); }
function readUint16LE(view, off) { return view.getUint16(off, true); }

async function unzipJson(file) {
  if (!('DecompressionStream' in window)) throw new Error('Your browser cannot decompress ZIP files here. Extract the ZIP on your phone and import the JSON files instead.');
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  const entries = [];

  // Find end of central directory from the last ~64 KiB.
  let eocd = -1;
  const min = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readUint32LE(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This ZIP file could not be read.');
  const count = readUint16LE(view, eocd + 10);
  let pos = readUint32LE(view, eocd + 16);

  for (let i=0; i<count; i++) {
    if (readUint32LE(view, pos) !== 0x02014b50) break;
    const method = readUint16LE(view, pos + 10);
    const compSize = readUint32LE(view, pos + 20);
    const uncompSize = readUint32LE(view, pos + 24);
    const nameLen = readUint16LE(view, pos + 28);
    const extraLen = readUint16LE(view, pos + 30);
    const commentLen = readUint16LE(view, pos + 32);
    const localOff = readUint32LE(view, pos + 42);
    const name = decoder.decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    if (name.toLowerCase().endsWith('.json')) entries.push({name, method, compSize, uncompSize, localOff});
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const files = [];
  for (const e of entries) {
    if (readUint32LE(view, e.localOff) !== 0x04034b50) continue;
    const nameLen = readUint16LE(view, e.localOff + 26);
    const extraLen = readUint16LE(view, e.localOff + 28);
    const dataStart = e.localOff + 30 + nameLen + extraLen;
    const compressed = bytes.slice(dataStart, dataStart + e.compSize);
    let raw;
    if (e.method === 0) raw = compressed;
    else if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer();
      raw = new Uint8Array(ab);
    } else continue;
    try { files.push({ name:e.name, data:JSON.parse(decoder.decode(raw)) }); } catch (_) {}
  }
  return files;
}

async function parseImport(files) {
  let followers = [];
  let following = [];
  const notes = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const inside = await unzipJson(file);
      if (!inside.length) notes.push(`${file.name}: no readable JSON files`);
      for (const item of inside) {
        const c = classifyJson(item.name, item.data);
        if (c?.type === 'followers') followers.push(...c.items);
        if (c?.type === 'following') following.push(...c.items);
      }
    } else if (file.name.toLowerCase().endsWith('.json')) {
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
  if (!followers.length && !following.length) throw new Error('I could not find Instagram follower/following data. Choose the JSON export and include “Followers and following”.');
  return { followers, following, notes };
}

async function handleImport(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  toast('Reading Instagram export…', 120000);
  try {
    const {followers, following} = await parseImport(files);
    const snapshot = {
      id: `${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
      importedAt: new Date().toISOString(),
      followers, following
    };
    await dbPut(snapshot);
    snapshots.push(snapshot);
    snapshots.sort((a,b) => new Date(a.importedAt) - new Date(b.importedAt));
    render();
    toast(`Snapshot saved: ${fmt(followers.length)} followers, ${fmt(following.length)} following.`);
  } catch (err) {
    toast(err?.message || 'Import failed.', 7000);
  } finally { els.importFile.value=''; }
}

function tabDataset() {
  const d = relationshipData();
  const map = {
    unfollowers: [d.unfollowers, 'Unfollowed since last import', 'bad'],
    new: [d.newFollowers, 'New since last import', 'good'],
    notback: [d.notBack, "Doesn't follow you back", 'bad'],
    mutuals: [d.mutuals, 'Mutual', 'good'],
    followers: [d.followers, 'Follower', ''],
    following: [d.following, 'Following', '']
  };
  return map[activeTab];
}

function renderPeople() {
  const [items, label, tone] = tabDataset();
  const q = els.search.value.trim().toLowerCase();
  const filtered = q ? items.filter(x => x.includes(q)) : items;
  els.peopleCount.textContent = `${fmt(items.length)} account${items.length===1?'':'s'}`;
  if (!filtered.length) {
    els.peopleList.innerHTML = `<div class="empty">${items.length ? 'No usernames match your search.' : 'Nothing to show in this category yet.'}</div>`;
    return;
  }
  els.peopleList.innerHTML = filtered.slice(0, 1000).map(name => `
    <div class="person">
      <div style="min-width:0"><div class="handle">@${escapeHtml(name)}</div><div class="meta">Latest snapshot</div></div>
      <div class="pill ${tone}">${escapeHtml(label)}</div>
    </div>`).join('');
}

function renderHistory() {
  els.historyCount.textContent = `${snapshots.length} snapshot${snapshots.length===1?'':'s'}`;
  if (!snapshots.length) { els.historyList.innerHTML = '<div class="empty">Your imported snapshots will appear here.</div>'; return; }
  els.historyList.innerHTML = [...snapshots].reverse().map((s, idx, arr) => {
    const date = new Date(s.importedAt);
    return `<div class="snap"><strong>${date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</strong><span>${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><span>${fmt(s.followers.length)} followers • ${fmt(s.following.length)} following</span></div>`;
  }).join('');
}

function renderDashboard() {
  const cur = latest(), prev = previous(), d = relationshipData();
  if (!cur) {
    ['followersCount','followingCount','newCount','lostCount','mutualCount','notBackCount','youDontCount','netCount'].forEach(id => $(id).textContent='—');
    els.statusBadge.textContent='No data yet';
    els.snapshotLabel.textContent='Import your first snapshot';
    els.followersDelta.textContent='No snapshot yet'; els.followingDelta.textContent='No snapshot yet';
    return;
  }
  els.statusBadge.textContent = `${fmt(cur.followers.length)} followers`;
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
  els.followersDelta.textContent = prev ? `${signed(fdelta)} since previous snapshot` : 'First snapshot';
  els.followingDelta.textContent = prev ? `${signed(gdelta)} since previous snapshot` : 'First snapshot';
  els.followersDelta.className = `sub ${fdelta>0?'positive':fdelta<0?'negative':''}`;
  els.followingDelta.className = `sub ${gdelta>0?'positive':gdelta<0?'negative':''}`;
}

function render() {
  renderDashboard(); renderHistory(); renderPeople();
}

function downloadBlob(name, blob) {
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();}, 1500);
}

function csvEscape(v) { const s=String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s; }
function exportCsv() {
  const cur=latest(), prev=previous(), d=relationshipData();
  if (!cur) return toast('Import a snapshot first.');
  const rows = [
    ['metric','value'], ['generated_at',new Date().toISOString()], ['snapshot_at',cur.importedAt],
    ['followers',cur.followers.length], ['following',cur.following.length], ['new_followers',prev?d.newFollowers.length:''],
    ['unfollowers',prev?d.unfollowers.length:''], ['mutuals',d.mutuals.length], ['not_following_back',d.notBack.length], ['you_dont_follow_back',d.youDont.length],
    [], ['category','username']
  ];
  for (const x of d.unfollowers) rows.push(['unfollower',x]);
  for (const x of d.newFollowers) rows.push(['new_follower',x]);
  for (const x of d.notBack) rows.push(['not_following_back',x]);
  for (const x of d.mutuals) rows.push(['mutual',x]);
  downloadBlob(`follower-lens-report-${new Date().toISOString().slice(0,10)}.csv`, new Blob([rows.map(r=>r.map(csvEscape).join(',')).join('\n')],{type:'text/csv'}));
}

function printReport() {
  const cur=latest(), prev=previous(), d=relationshipData();
  if (!cur) return toast('Import a snapshot first.');
  const w=window.open('','_blank');
  if (!w) return toast('Allow pop-ups for this site to generate a printable report.');
  const rows=[['Followers',cur.followers.length],['Following',cur.following.length],['New followers',prev?d.newFollowers.length:'—'],['Unfollowers',prev?d.unfollowers.length:'—'],['Mutuals',d.mutuals.length],['Not following back',d.notBack.length],['You don’t follow back',d.youDont.length],['Net change',prev?d.newFollowers.length-d.unfollowers.length:'—']];
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Follower Lens Report</title><style>body{font-family:system-ui,sans-serif;margin:36px;color:#111}h1{margin-bottom:4px}.muted{color:#666}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:24px 0}.box{border:1px solid #ddd;border-radius:12px;padding:16px}.v{font-size:28px;font-weight:800}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:12px}@media print{button{display:none}}</style><h1>Follower Lens Report</h1><div class="muted">Snapshot ${escapeHtml(new Date(cur.importedAt).toLocaleString())} • Generated ${escapeHtml(new Date().toLocaleString())}</div><div class="grid">${rows.map(([k,v])=>`<div class="box"><div class="muted">${k}</div><div class="v">${fmt(v)}</div></div>`).join('')}</div><h2>Recent unfollowers</h2><table><tr><th>Username</th></tr>${d.unfollowers.slice(0,250).map(x=>`<tr><td>@${escapeHtml(x)}</td></tr>`).join('')}</table><p class="muted">This report is based on differences between imported Instagram data snapshots. A missing account does not prove that the account blocked you.</p><button onclick="window.print()">Print / Save PDF</button>`);
  w.document.close();
}

function backup() {
  if (!snapshots.length) return toast('Nothing to back up yet.');
  downloadBlob(`follower-lens-backup-${new Date().toISOString().slice(0,10)}.json`, new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),snapshots},null,2)],{type:'application/json'}));
}

async function restore(file) {
  try {
    const data=JSON.parse(await file.text());
    if (!Array.isArray(data.snapshots)) throw new Error('Invalid backup file.');
    for (const s of data.snapshots) {
      if (!s.id || !Array.isArray(s.followers) || !Array.isArray(s.following)) continue;
      s.followers=uniq(s.followers); s.following=uniq(s.following); await dbPut(s);
    }
    snapshots=await dbGetAll(); snapshots.sort((a,b)=>new Date(a.importedAt)-new Date(b.importedAt)); render(); toast('Backup restored.');
  } catch(e) { toast(e?.message || 'Restore failed.', 6000); }
  els.restoreFile.value='';
}

function showView(view) {
  currentView=view;
  document.querySelectorAll('[data-view]').forEach(el => el.style.display = el.dataset.view===view ? '' : 'none');
  document.querySelectorAll('[data-nav]').forEach(btn => btn.classList.toggle('active',btn.dataset.nav===view));
  if (view==='dashboard') document.getElementById('homeHero').style.display=''; else document.getElementById('homeHero').style.display='none';
  window.scrollTo({top:0,behavior:'smooth'});
}

els.importFile.addEventListener('change', e => handleImport(e.target.files));
els.restoreFile.addEventListener('change', e => e.target.files[0] && restore(e.target.files[0]));
els.search.addEventListener('input', renderPeople);
document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
  activeTab=btn.dataset.tab; document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b===btn)); renderPeople();
}));
document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.nav)));
$('downloadCsv').addEventListener('click', exportCsv);
$('printReport').addEventListener('click', printReport);
$('backupData').addEventListener('click', backup);
$('clearData').addEventListener('click', async () => {
  if (!confirm('Delete all local Follower Lens snapshots from this browser?')) return;
  await dbClear(); snapshots=[]; render(); toast('Local data deleted.');
});
$('showHelp').addEventListener('click',()=>els.helpModal.classList.remove('hidden'));
$('closeHelp').addEventListener('click',()=>els.helpModal.classList.add('hidden'));
els.helpModal.addEventListener('click',e=>{if(e.target===els.helpModal) els.helpModal.classList.add('hidden')});

(async function init(){
  try { snapshots=await dbGetAll(); snapshots.sort((a,b)=>new Date(a.importedAt)-new Date(b.importedAt)); render(); }
  catch(e) { toast('Local storage could not be opened.'); }
  showView('dashboard');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
