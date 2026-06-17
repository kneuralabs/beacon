// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = "beacon_feeds";
const TOKEN_KEY   = "beacon_gh_token";
const REPO_OWNER  = "kneuralabs";
const REPO_NAME   = "beacon";
const REPO_PATH   = "data/feeds.json";
const REPO_BRANCH = "main";
let feeds = [], isAdmin = false, editingId = null;
let ghToken = null;

// ── GITHUB CONTENTS API ───────────────────────────────────────────────────────

function getToken() { return localStorage.getItem(TOKEN_KEY) || null; }

function setToken(token) {
  ghToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  updateSyncBadge();
}

function updateSyncBadge() {
  const el = document.getElementById('footerBar');
  if (!el) return;
  // Reads are always from the public repo; token only needed for writes
  el.innerHTML = ghToken
    ? 'Feeds · <span style="color:var(--age1-title)">kneuralabs/beacon ✓ (read+write)</span> &nbsp;·&nbsp; Media · IndexedDB &nbsp;·&nbsp; Beacon by Kneuralabs'
    : 'Feeds · <span style="color:var(--muted)">kneuralabs/beacon (read-only)</span> &nbsp;·&nbsp; Media · IndexedDB &nbsp;·&nbsp; Beacon by Kneuralabs';
}

async function ghFetch(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    cache: 'no-store',   // always read a fresh sha — avoids 409 "does not match"
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 404) return null;   // file doesn't exist yet
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.message || ('GitHub API ' + res.status));
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

// GET current file — works unauthenticated (public repo) for reads
// Returns { feeds: [...] } or null
async function repoLoad() {
  // Authenticated path: Contents API with the raw media type. This returns the
  // file verbatim (fresh, no 1MB base64 limit), so a just-committed post — image
  // and all — comes back exactly as saved when the page is reopened.
  if (ghToken) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_PATH}?ref=${REPO_BRANCH}&t=${Date.now()}`,
        { headers: { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github.raw' }, cache: 'no-store' }
      );
      if (res.status === 404) return null; // file not created yet
      if (res.ok) return { feeds: await res.json() };
      // any other status → fall through to the raw CDN
    } catch (e) {
      console.warn('repo load (auth) failed:', e.message);
    }
  }
  // Unauthenticated / fallback: raw CDN — open CORS, no auth, handles any size
  try {
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${REPO_PATH}`;
    const res = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null; // 404 = not published yet, or network issue
    return { feeds: await res.json() };
  } catch (_) {
    return null; // offline or network error — fail silently, localStorage takes over
  }
}

// PUT / create-or-update → needs sha when updating
async function repoSave() {
  if (!ghToken) return;

  // Guarantee images survive the commit: restore any missing mediaData from this
  // device's IndexedDB, then — for anything still missing — preserve it from the
  // current repo copy so we never overwrite a published image with nothing.
  await reattachLocalMedia();
  if (feeds.some(it => !it.mediaData && it.mediaRef)) {
    try {
      const r = await repoLoad();
      if (r && r.feeds) {
        const byId = {};
        r.feeds.forEach(p => { byId[p.id] = p; });
        for (const item of feeds) {
          if (!item.mediaData && item.mediaRef && byId[item.id] && byId[item.id].mediaData) {
            item.mediaData = byId[item.id].mediaData;
            item.mediaType = item.mediaType || byId[item.id].mediaType;
          }
        }
      }
    } catch (_) {}
  }

  const payload = feeds.map(({ _objectURL, ...r }) => r);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  // GitHub's Contents API rejects files larger than ~1MB. Fail clearly here.
  if (content.length > 1.4 * 1024 * 1024) {
    throw new Error('Feeds file too large for the repo (>1MB) — too many embedded images.');
  }

  // Read the latest sha and PUT. On a 409 (sha moved underneath us, e.g. a
  // concurrent auto-commit) refetch the sha and retry once.
  const latestSha = async () => {
    try {
      const meta = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_PATH}?ref=${REPO_BRANCH}`);
      return meta ? meta.sha : null;
    } catch (_) { return null; }
  };
  const put = async (sha) => {
    const body = { message: 'beacon: update feeds ' + new Date().toISOString(), content, branch: REPO_BRANCH };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_PATH}`, {
      method: 'PUT', body: JSON.stringify(body)
    });
  };

  let sha = await latestSha();
  try {
    await put(sha);
  } catch (e) {
    if (e.status === 409 || /does not match/i.test(e.message)) {
      sha = await latestSha();   // stale sha — refetch fresh and retry
      await put(sha);
    } else {
      throw e;
    }
  }
}

// DELETE the file from the repo
async function repoDelete() {
  if (!ghToken) return;
  const meta = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_PATH}?ref=${REPO_BRANCH}`);
  if (!meta) return; // already gone
  await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_PATH}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: 'beacon: clear feeds',
      sha: meta.sha,
      branch: REPO_BRANCH
    })
  });
}

// Verify token → returns login string or throws
async function verifyToken(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error('Token invalid or missing repo access');
  const u = await res.json();
  return u.login;
}

// ── SINGLE SYNC BUTTON ─────────────────────────────────────────────────────────
// One ultra-minimal admin button. red = not connected (click → token routine) ·
// amber = connecting · green = connected (click → commit now; auto-commits every 1 minute).
let syncState = 'red';
const SYNC_IC = {
  red:   '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l10 10M11 5.5V3.5a1 1 0 0 0-1-1H8M5 10.5v2a1 1 0 0 0 1 1h2"/></svg>',
  amber: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke-width="1.6" stroke-linecap="round"><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></path></svg>',
  green: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8.5 6.5,12 13,4.5"/></svg>'
};
const SYNC_TITLE = { red:'Connect to repo', amber:'Connecting…', green:'Connected · click to commit now (auto every minute)' };

function setSync(state) {
  syncState = state;
  const btn = document.getElementById('gistSaveBtn');
  if (!btn) return;
  btn.classList.remove('sync-red','sync-amber','sync-green');
  btn.classList.add('sync-' + state);
  btn.disabled = (state === 'amber');
  btn.innerHTML = SYNC_IC[state];
  btn.title = SYNC_TITLE[state];
}

// First-time routine: prompt for the token
function openTokenPrompt() {
  document.getElementById('gistOverlay').classList.add('open');
  document.getElementById('gistTokenInput').value = '';
  document.getElementById('gistStatus').textContent = '';
  setTimeout(() => document.getElementById('gistTokenInput').focus(), 80);
}
function closeTokenPrompt() { document.getElementById('gistOverlay').classList.remove('open'); }

async function commitNow() {
  if (!ghToken) return;
  try {
    await repoSave();
    showToast('Saved to repo');
  } catch (e) {
    showToast('Repo save failed: ' + e.message);
  }
}

// Verify a token, load feeds, then lock into auto-commit. Surfaces errors in red.
async function connectWithToken(tokenVal, statusEl) {
  setSync('amber');
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Verifying…'; }
  try {
    const login = await verifyToken(tokenVal);
    ghToken = tokenVal;                    // set before repoLoad
    const result = await repoLoad();
    if (result !== null) { feeds = result.feeds; persistLocal(); await renderFeeds(); }
    setToken(tokenVal);
    setSync('green');
    closeTokenPrompt();
    showToast('Connected as @' + login);
    return true;
  } catch (e) {
    setToken(null);
    setSync('red');
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = e.message; }
    showToast('Connection failed: ' + e.message);
    return false;
  }
}

// Connect from the overlay's input
async function connectGist() {
  const tokenVal = document.getElementById('gistTokenInput').value.trim();
  const statusEl = document.getElementById('gistStatus');
  if (!tokenVal) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Enter a token to connect';
    return;
  }
  await connectWithToken(tokenVal, statusEl);
}


// ── STORAGE HELPERS ───────────────────────────────────────────────────────────

function save() {
  persistLocal();
  if (ghToken) repoSave().catch(e => showError('Sync error: ' + e.message));
}

// Write feeds to localStorage WITHOUT the heavy embedded media (base64 data URLs
// blow past the ~5MB quota). Local views fall back to the IndexedDB blob via
// mediaRef; the full media still travels to the repo in repoSave().
function persistLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(feeds.map(({ _objectURL, mediaData, ...r }) => r)));
    return true;
  } catch (e) {
    showToast('Local cache full — changes saved to repo');
    return false;
  }
}

function load() {
  try { feeds = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { feeds = []; }
}

async function loadWithRemote() {
  load(); // populate instantly from localStorage while we wait on network
  // Re-attach images from this device's IndexedDB for any item the (light)
  // localStorage cache dropped, so photos show even before/without the network.
  await reattachLocalMedia();
  // Paint the cached feed right away — don't make the reader stare at a blank
  // page while the (cache-busting, no-store) network fetch below resolves.
  await renderFeeds();

  try {
    const result = await repoLoad();
    if (result !== null) {
      feeds = result.feeds;
      persistLocal();
      // Network copy arrived — re-attach its media and refresh the view in place.
      await reattachLocalMedia();
      await renderFeeds();
    }
    // result === null means file doesn't exist yet or network unavailable — both fine
  } catch (_) {
    // Network completely unavailable — cached feeds already rendered above
  }
}

const ROLE_LABELS = {
  CEO:"Chief Executive Officer", CIO:"Chief Information Officer", CTO:"Chief Technology Officer",
  CAIO:"Chief Artificial Intelligence Officer", CDAIO:"Chief Data & AI Officer",
  CISO:"Chief Information Security Officer", CTrO:"Chief Transformation Officer",
  CDO:"Chief Data Officer", CFO:"Chief Financial Officer", CEA:"Chief Executive Assistant"
};

const IC = {
  edit:   '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>',
  trash:  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10M8 8v5M6 8v5M10 8v5M5 5l.5-2h5l.5 2"/></svg>'
};

// ── INDEXEDDB ──────────────────────────────────────────────────────────────────
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('BeaconMediaDB', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('media'))
        e.target.result.createObjectStore('media', { keyPath: 'id' });
    };
  });
}
async function storeMediaBlob(id, blob, mimeType) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['media'], 'readwrite');
    tx.objectStore('media').put({ id, blob, mimeType });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function getMediaBlob(id) {
  const db = await openDB();
  return new Promise(res => {
    const tx = db.transaction(['media'], 'readonly');
    const req = tx.objectStore('media').get(id);
    req.onsuccess = () => res(req.result);
  });
}
async function deleteMediaBlob(id) {
  const db = await openDB();
  return new Promise(res => {
    const tx = db.transaction(['media'], 'readwrite');
    tx.objectStore('media').delete(id);
    tx.oncomplete = () => res();
  });
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
// Restore embedded media (mediaData) from this device's IndexedDB blob for any
// item that lost it (e.g. after reloading from the media-light localStorage
// cache). This keeps the image in the feed so commits never drop it.
async function reattachLocalMedia() {
  for (const item of feeds) {
    if (!item.mediaData && item.mediaRef) {
      try {
        const m = await getMediaBlob(item.mediaRef);
        if (m && m.blob) {
          item.mediaData = await blobToDataURL(m.blob);
          item.mediaType = item.mediaType || m.mimeType;
        }
      } catch (_) {}
    }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, ms = 3500) {
  const t = document.getElementById("toastMsg");
  t.textContent = msg; t.className = "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
// Errors stay up longer and are logged so they can be read/copied.
function showError(msg) { console.error('[beacon]', msg); showToast(msg, 12000); }
function esc(s) {
  return (s || '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}

// ── RICH MESSAGE: sanitize a small whitelist of inline formatting ──────────────
// Allows only B/I/U + legacy <font size> + <span style="font-size"> + line breaks,
// stripping everything else so stored/rendered HTML stays safe.
const RICH_TAGS = { B:1, STRONG:1, I:1, EM:1, U:1, FONT:1, SPAN:1, BR:1, DIV:1, P:1 };
function sanitizeRich(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  (function walk(node) {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === 3) return;               // text — keep
      if (child.nodeType !== 1) { node.removeChild(child); return; } // comments etc.
      walk(child);                                    // clean descendants first
      if (!RICH_TAGS[child.tagName]) {                // disallowed → unwrap
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        return;
      }
      [...child.attributes].forEach(a => {
        const n = a.name.toLowerCase();
        if (child.tagName === 'FONT' && n === 'size') return;
        if (child.tagName === 'SPAN' && n === 'style') {
          const fs = child.style.fontSize;
          child.removeAttribute('style');
          if (fs) child.style.fontSize = fs;
          return;
        }
        child.removeAttribute(a.name);
      });
    });
  })(root);
  return root.innerHTML;
}

function getEditorHTML() {
  return sanitizeRich(document.getElementById('intContent').innerHTML).trim();
}
function setEditorHTML(val) {
  const ed = document.getElementById('intContent');
  // Old plain-text posts (no tags) → preserve their line breaks
  ed.innerHTML = (val && /<[a-z][\s\S]*>/i.test(val))
    ? sanitizeRich(val)
    : esc(val || '').replace(/\n/g, '<br>');
}

// Floating selection toolbar wiring
function initRichEditor() {
  const ed = document.getElementById('intContent');
  const bar = document.getElementById('fmtBar');
  if (!ed || !bar) return;
  const hide = () => bar.classList.remove('show');
  const place = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed ||
        !ed.contains(sel.anchorNode) || !ed.contains(sel.focusNode)) { hide(); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) { hide(); return; }
    bar.classList.add('show');
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - 8));
    let top = r.top - bh - 8; if (top < 8) top = r.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  };
  bar.querySelectorAll('button').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection
    b.addEventListener('click', e => {
      e.preventDefault();
      ed.focus();
      if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
      else if (b.dataset.size) document.execCommand('fontSize', false, b.dataset.size);
      place();
    });
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === ed) place();
  });
  ed.addEventListener('mouseup', place);
  ed.addEventListener('keyup', place);
  ed.addEventListener('blur', () => setTimeout(() => {
    if (!bar.contains(document.activeElement)) hide();
  }, 150));
  addEventListener('scroll', () => { if (bar.classList.contains('show')) place(); }, true);
  addEventListener('resize', hide);
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }) + ' · ' +
         d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
}
function ageBucket(sorted, i) {
  const n = sorted.length;
  if (i === 0) return 0;
  if (n <= 4) return Math.min(i, 4);
  const q = Math.floor(n / 4);
  if (i < q) return 1; if (i < q*2) return 2; if (i < q*3) return 3; return 4;
}

// ── MEDIA HTML ────────────────────────────────────────────────────────────────
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Center-crop an image to 1:1 (already-square images are kept as-is), then
// downscale + re-encode so the embedded data URL stays small. This keeps
// feeds.json under GitHub's 1MB Contents-API limit (a raw phone photo is
// several MB and gets the commit rejected).
function compressImage(file, size = 1080, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);   // largest centered square
      const sx = (img.width  - side) / 2;             // centers the subject
      const sy = (img.height - side) / 2;
      const out = Math.min(size, side);               // resize, never upscale
      const canvas = document.createElement('canvas');
      canvas.width = out; canvas.height = out;
      canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, out, out);
      try { resolve(canvas.toDataURL('image/jpeg', quality)); }
      catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

async function getMediaHTML(item) {
  // Preferred: media embedded in the synced feed (visible on every device)
  if (item.mediaData) {
    const isVideo = (item.mediaType || '').startsWith('video/');
    const tag = isVideo
      ? '<video src="' + item.mediaData + '" controls></video>'
      : '<img src="' + item.mediaData + '" alt="media" loading="lazy">';
    return '<div class="attached-media">' + tag + '</div>';
  }
  // Fallback: legacy items whose blob lives only in this device's IndexedDB
  if (!item.mediaRef) return '';
  try {
    const m = await getMediaBlob(item.mediaRef);
    if (m && m.blob) {
      const url = URL.createObjectURL(m.blob);
      item._objectURL = url;
      const isVideo = m.mimeType.startsWith('video/');
      const tag = isVideo
        ? '<video src="' + url + '" controls></video>'
        : '<img src="' + url + '" alt="media" loading="lazy">';
      return '<div class="attached-media">' + tag + '</div>';
    }
  } catch (e) {}
  return '';
}

// ── AWARD POSTER ──────────────────────────────────────────────────────────────
function awardPoster(item) {
  const name  = esc(item.awardName || item.title || '');
  const cat   = esc(item.awardCategory || '');
  const recip = esc(item.awardRecipient || '');
  const year  = new Date(item.timestamp).getFullYear();
  const logoSVG =
    '<svg class="award-poster-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="40" height="40">' +
      '<defs>' +
        '<linearGradient id="ap-tile" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#2e274a"/><stop offset="1" stop-color="#1a1422"/>' +
        '</linearGradient>' +
        '<radialGradient id="ap-dot" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0" stop-color="#f3d9a6"/><stop offset="1" stop-color="#e0b260"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<rect x="3.5" y="3.5" width="57" height="57" rx="14" fill="url(#ap-tile)"/>' +
      '<rect x="3.5" y="3.5" width="57" height="57" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>' +
      '<text x="31" y="45.5" text-anchor="middle" font-family="\'Cormorant Garamond\',Georgia,serif" font-weight="600" font-size="50" fill="#ede8d8">b</text>' +
      '<rect x="3.5" y="31" width="57" height="1.6" fill="#000" fill-opacity="0.55"/>' +
      '<circle cx="46" cy="19" r="6.5" fill="#e0b260" fill-opacity="0.18"/>' +
      '<circle cx="46" cy="19" r="3.4" fill="url(#ap-dot)"/>' +
    '</svg>';
  const starSVG =
    '<svg class="award-medal-star" width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M16 3 L18.94 11.27 L27.8 11.31 L20.72 16.56 L23.25 25.06 L16 20.18 L8.75 25.06 L11.28 16.56 L4.2 11.31 L13.06 11.27 Z" fill="rgba(255,255,255,0.94)" stroke="rgba(255,220,120,0.35)" stroke-width="0.5"/>' +
    '</svg>';
  return '<div class="award-poster">' +
    '<div class="award-poster-ornament">✦ ✦ ✦</div>' +
    '<div class="award-poster-brand">' +
      logoSVG +
      '<div class="award-poster-orgname">Kneuralabs</div>' +
    '</div>' +
    '<div class="award-medal">' +
      '<div class="award-medal-ribbon"></div>' +
      '<div class="award-medal-disc">' + starSVG + '</div>' +
    '</div>' +
    '<div class="award-poster-rule"></div>' +
    (name ? '<div class="award-poster-type">Award of Excellence</div><div class="award-poster-name">' + name + '</div>' : '') +
    '<div class="award-poster-rule"></div>' +
    '<div class="award-poster-presented">Presented to</div>' +
    (recip ? '<div class="award-poster-recipient">' + recip + '</div>' : '') +
    (cat   ? '<div class="award-poster-category">' + cat + '</div>' : '') +
    '<div class="award-poster-year">' + year + '</div>' +
  '</div>';
}

// Expand/collapse an older post's summary
function toggleMore(btn) {
  const content = btn.previousElementSibling;
  if (!content) return;
  const open = content.classList.toggle('item-content--open');
  btn.textContent = open ? 'Show less' : 'Show more…';
}

// ── RENDER ────────────────────────────────────────────────────────────────────
async function renderFeeds() {
  const sorted = [...feeds].sort((a, b) => b.timestamp - a.timestamp);
  const grid = document.getElementById('unified-grid');
  if (!grid) return;
  document.getElementById('internalCount').textContent =
    sorted.length + ' item' + (sorted.length !== 1 ? 's' : '');

  if (!sorted.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--muted)">No posts yet</div>';
  } else {
    let html = '';
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const media = await getMediaHTML(item);
      const featured = i === 0;
      const age = ageBucket(sorted, i);
      const roleLabel = esc(ROLE_LABELS[item.authorRole] || item.authorRole || '');
      const poster = item.msgType === 'Award' ? awardPoster(item) : '';
      const eventDateHtml = (item.msgType === 'Event' && item.eventDate)
        ? '<div class="event-date-badge">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="12" rx="1.5"/><path d="M5 2v2M11 2v2M2 7h12"/></svg>' +
            new Date(item.eventDate + 'T00:00:00').toLocaleDateString(undefined, { weekday:'short', month:'long', day:'numeric', year:'numeric' }) +
          '</div>'
        : '';
      // Latest post shows in full; older posts collapse to a summary + "Show more…"
      let bodyHtml = '';
      if (item.content) {
        const plainLen = item.content.replace(/<[^>]*>/g, '').length;
        const collapse = !featured && plainLen > 140;
        bodyHtml =
          '<div class="item-content' + (collapse ? ' item-content--clamp' : '') + '"' +
            (poster ? ' style="margin-top:.5rem"' : '') + '>' + sanitizeRich(item.content) + '</div>' +
          (collapse ? '<button class="show-more" onclick="toggleMore(this)">Show more…</button>' : '');
      }
      // Content-aware headline sizing for the latest (featured) post
      const tl = (item.title || '').length;
      const tlen = featured ? (tl <= 28 ? ' data-tlen="short"' : tl >= 60 ? ' data-tlen="long"' : ' data-tlen="mid"') : '';
      html +=
        '<div class="grid-item' + (featured ? ' grid-item--featured' : '') +
        (!item.title && !item.content && (item.mediaData || item.mediaRef) ? ' grid-item--photo-only' : '') +
        '" data-age="' + age + '" data-rank="' + Math.min(i + 1, 4) + '"' + tlen + '>' +
          '<div class="feed-item">' +
            '<div class="item-title"><span class="item-title-text">' + esc(item.title) + '</span></div>' +
            '<div class="item-meta">' +
              '<span class="role-tag type-' + item.msgType + '">' + item.msgType + '</span>' +
              '<span class="role-tag role-' + item.authorRole + '" title="' + roleLabel + '">' + roleLabel + '</span>' +
              '<span class="meta-date">' + fmtDate(item.timestamp) + '</span>' +
            '</div>' +
            eventDateHtml + media + poster + bodyHtml +
          '</div>' +
        '</div>';
    }
    grid.innerHTML = html;
  }

  if (isAdmin) {
    ['Announcement','Notice','Event','Award'].forEach(type => {
      const el = document.getElementById('adm-' + type);
      if (!el) return;
      const list = feeds.filter(f => f.msgType === type).sort((a, b) => b.timestamp - a.timestamp);
      if (!list.length) {
        el.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted2);font-size:.8rem">No posts</div>';
        return;
      }
      el.innerHTML = list.map(item =>
        '<div style="margin-bottom:.8rem;padding-bottom:.8rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:.5rem">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-weight:600;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">' + esc(item.title) + '</div>' +
            '<div style="font-size:.65rem;color:var(--muted2);margin-top:.15rem">' + fmtDate(item.timestamp) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:.3rem;flex-shrink:0">' +
            '<button class="icon-btn" onclick="startEdit(\'' + item.id + '\')" title="Edit">' + IC.edit + '</button>' +
            '<button class="icon-btn icon-btn--danger" onclick="deletePost(\'' + item.id + '\')" title="Delete">' + IC.trash + '</button>' +
          '</div>' +
        '</div>'
      ).join('');
    });
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
async function addPost(title, content) {
  if (!isAdmin || !title.trim()) { showToast("Title required"); return; }
  const type   = document.querySelector('.msg-type-pill.active').dataset.type;
  const author = document.getElementById('authorRoleSelect').value;
  const id     = editingId || 'feed_' + Date.now();
  const post   = {
    id, title, content, msgType: type, authorRole: author,
    timestamp: editingId ? feeds.find(f => f.id === editingId).timestamp : Date.now()
  };
  if (type === 'Award') {
    post.awardName      = document.getElementById('awardName').value;
    post.awardCategory  = document.getElementById('awardCategory').value;
    post.awardRecipient = document.getElementById('awardRecipient').value;
  }
  if (type === 'Event') post.eventDate = document.getElementById('eventDate').value;
  const file = document.getElementById('mediaUpload').files[0];
  if (file) {
    if (!file.type.startsWith('image/')) { showToast('Only image files are allowed'); return; }
    const mediaId = 'media_' + id;
    // Center-cropped to 1:1 and compressed; embedded so it syncs in feeds.json
    // and shows on every device, while staying under the 1MB API limit.
    post.mediaData = await compressImage(file);
    post.mediaType = 'image/jpeg';
    await storeMediaBlob(mediaId, await (await fetch(post.mediaData)).blob(), 'image/jpeg');
    post.mediaRef = mediaId;
  } else if (editingId) {
    const ex = feeds.find(f => f.id === editingId);
    if (ex) {
      if (ex.mediaRef)  post.mediaRef  = ex.mediaRef;
      if (ex.mediaData) post.mediaData = ex.mediaData;
      if (ex.mediaType) post.mediaType = ex.mediaType;
    }
  }
  if (editingId) {
    const idx = feeds.findIndex(f => f.id === editingId);
    if (idx >= 0) feeds[idx] = { ...feeds[idx], ...post };
  } else {
    feeds.push(post);
  }
  save(); resetForm(); await renderFeeds();
  showToast(editingId ? "Updated" : "Published");
  if (ghToken) commitNow();
}

async function deletePost(id) {
  if (!confirm("Delete this post?")) return;
  const item = feeds.find(f => f.id === id);
  if (item && item.mediaRef) await deleteMediaBlob(item.mediaRef);
  feeds = feeds.filter(f => f.id !== id);
  save(); await renderFeeds(); showToast("Deleted");
  if (ghToken) commitNow();
}

function startEdit(id) {
  const item = feeds.find(f => f.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('intTitle').value   = item.title;
  setEditorHTML(item.content || '');
  document.getElementById('authorRoleSelect').value = item.authorRole;
  document.querySelectorAll('.msg-type-pill').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-type="' + item.msgType + '"].msg-type-pill').classList.add('active');
  document.getElementById('pillTypeLabel').textContent = item.msgType;
  updateTypeFields(item.msgType);
  if (item.msgType === 'Award') {
    document.getElementById('awardName').value      = item.awardName || '';
    document.getElementById('awardCategory').value  = item.awardCategory || '';
    document.getElementById('awardRecipient').value = item.awardRecipient || '';
  }
  if (item.msgType === 'Event' && item.eventDate)
    document.getElementById('eventDate').value = item.eventDate;
  document.getElementById('formHeading').textContent = "Edit Post";
  document.getElementById('editingNote').style.display = 'flex';
  document.getElementById('cancelEditBtn').style.display = 'inline-flex';
  document.querySelector('#adminView .admin-layout > div:last-child').scrollIntoView({ behavior:'smooth' });
}

function updateTypeFields(type) {
  document.getElementById('eventFields').style.display = type === 'Event' ? 'block' : 'none';
  document.getElementById('awardFields').style.display = type === 'Award' ? 'block' : 'none';
}

function resetForm() {
  editingId = null;
  ['intTitle','awardName','awardCategory','awardRecipient','eventDate'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('intContent').innerHTML = '';
  document.getElementById('fmtBar').classList.remove('show');
  document.getElementById('mediaUpload').value = '';
  document.getElementById('mediaFileName').textContent = '';
  document.getElementById('formHeading').textContent = 'New Post';
  document.getElementById('editingNote').style.display = 'none';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.querySelectorAll('.msg-type-pill').forEach((p, i) => p.classList.toggle('active', i === 0));
  document.getElementById('pillTypeLabel').textContent = 'Announcement';
  updateTypeFields('Announcement');
}

// ── THEME ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('beacon_theme', theme);
  document.getElementById('iconSun').style.display  = theme === 'dark'  ? 'block' : 'none';
  document.getElementById('iconMoon').style.display = theme === 'light' ? 'block' : 'none';
}

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('beacon_theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);

  document.getElementById('themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  document.getElementById('mastheadDate').textContent = new Date().toLocaleDateString(undefined, {
    weekday:'long', year:'numeric', month:'long', day:'numeric'
  });

  // Restore token, then load
  ghToken = getToken();
  updateSyncBadge();

  await openDB();
  // Renders the cached feed immediately, then refreshes from the repo in place.
  await loadWithRemote();

  if (ghToken) {
    verifyToken(ghToken)
      .then(() => setSync('green'))
      .catch(() => { setToken(null); setSync('red'); });
  }

  // Admin dot
  document.getElementById('dotBtn').addEventListener('click', () => {
    if (isAdmin) {
      isAdmin = false;
      document.getElementById('adminView').style.display  = 'none';
      document.getElementById('readonlyView').style.display = 'block';
      renderFeeds();
    } else {
      document.getElementById('magicOverlay').classList.add('open');
      setTimeout(() => document.getElementById('magicInput').focus(), 80);
    }
  });

  document.getElementById('magicSubmit').addEventListener('click', () => {
    if (document.getElementById('magicInput').value.toLowerCase() === 'hello') {
      isAdmin = true;
      document.getElementById('magicOverlay').classList.remove('open');
      document.getElementById('magicInput').value = '';
      document.getElementById('magicError').textContent = '';
      document.getElementById('readonlyView').style.display  = 'none';
      document.getElementById('adminView').style.display = 'block';
      renderFeeds();
      if (!ghToken) openTokenPrompt();
    } else {
      document.getElementById('magicError').textContent = 'Invalid password';
    }
  });
  document.getElementById('magicCancel').addEventListener('click', () => {
    document.getElementById('magicOverlay').classList.remove('open');
    document.getElementById('magicInput').value = '';
    document.getElementById('magicError').textContent = '';
  });
  document.getElementById('magicInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('magicSubmit').click();
  });

  document.querySelectorAll('.msg-type-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.msg-type-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      document.getElementById('pillTypeLabel').textContent = p.dataset.type;
      updateTypeFields(p.dataset.type);
    });
  });

  document.querySelectorAll('.adm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.adm-panel').forEach(p => p.style.display = 'none');
      tab.classList.add('active');
      document.getElementById('adm-' + tab.dataset.type).style.display = 'block';
    });
  });

  document.getElementById('mediaUpload').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f && !f.type.startsWith('image/')) {
      e.target.value = '';
      document.getElementById('mediaFileName').textContent = '';
      showToast('Only image files are allowed');
      return;
    }
    document.getElementById('mediaFileName').textContent = f ? f.name : '';
  });

  document.getElementById('publishIntBtn').addEventListener('click', () => {
    addPost(document.getElementById('intTitle').value, getEditorHTML());
  });

  document.getElementById('clearIntBtn').addEventListener('click', async () => {
    if (!confirm("Delete ALL posts?")) return;
    for (const item of feeds) if (item.mediaRef) await deleteMediaBlob(item.mediaRef);
    feeds = []; save(); await renderFeeds(); showToast("All deleted");
    if (ghToken) commitNow();
  });

  document.getElementById('gistCancelBtn').addEventListener('click', closeTokenPrompt);
  document.getElementById('gistSaveBtn').addEventListener('click', connectGist);
  document.getElementById('gistTokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('gistSaveBtn').click();
  });

  document.getElementById('cancelEditBtn').addEventListener('click', resetForm);

  initRichEditor();

  // ── BEACON FLIP CLOCK ANIMATION ──
  // True split-flap board: each tile ticks through random letters and lands on its target.
  (function() {
    const FLIP_MS = 150;   // duration of one full flip (fall + rise)
    const HOLD_MS = 45;    // pause between consecutive flips
    const STAGGER = 110;   // start offset between tiles (cascade)
    const ALPHA   = 'abcdefghijklmnopqrstuvwxyz';
    const rnd = () => ALPHA[(Math.random() * ALPHA.length) | 0];
    const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

    // Wait for the blackletter web font so glyphs are measured at their real
    // size (otherwise slow mobile connections clip the tiles with fallback metrics).
    const ready = document.fonts
      ? document.fonts.load('600 1rem "Cormorant Garamond"').then(() => document.fonts.ready).catch(() => {})
      : Promise.resolve();
    ready.then(() => build(true));
    // Re-layout the logo when the viewport changes (e.g. device rotation) so the
    // fixed-size tiles always fit in both portrait and landscape. No re-scramble.
    let rzT;
    addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => build(false), 250); });

    const revealDot = () => document.getElementById('dotBtn').classList.add('revealed');

    function build(animate) {
    const tiles = document.querySelectorAll('.bl');
    const lastIdx = tiles.length - 1;
    if (animate) setTimeout(revealDot, 9000); // safety net so the dot always appears
    tiles.forEach((el, idx) => {
      const target = el.dataset.letter || (el.dataset.letter = el.textContent.trim());
      el.innerHTML = '';
      el.style.opacity = '1';

      const probe = document.createElement('span');
      probe.textContent = target;
      probe.style.cssText = 'visibility:hidden;position:absolute;font-family:var(--blackletter);font-weight:600;font-size:inherit;line-height:1;white-space:nowrap;';
      el.appendChild(probe);
      const LH = probe.offsetHeight || 64;
      const LW = Math.max(probe.offsetWidth, LH * 0.62);
      el.removeChild(probe);

      const PAD = Math.round(LH * 0.12);
      const CH  = LH + PAD * 2;
      const CW  = Math.round(LW * 1.18);
      const R   = Math.max(4, Math.round(CH * 0.07));

      el.style.cssText += `display:inline-block;position:relative;width:${CW}px;height:${CH}px;vertical-align:middle;perspective:${CH * 9}px;transform-style:preserve-3d;`;

      const letterColor = () => isDark() ? '#1a1520' : '#ede8d8';
      const bgColor     = () => isDark() ? '#e8e2d4' : '#26203d';

      function makeLetter(isTop, ch) {
        const s = document.createElement('span');
        s.textContent = ch;
        const top = isTop ? PAD : PAD - CH / 2;
        s.style.cssText = `display:block;position:absolute;top:${top}px;left:0;width:100%;text-align:center;font-family:var(--blackletter);font-weight:600;font-size:${LH}px;color:${letterColor()};line-height:1;white-space:nowrap;transition:color .25s;`;
        return s;
      }
      function makeHalf(isTop) {
        const d = document.createElement('span');
        const rr = `${R}px`;
        const br = isTop
          ? `border-radius:${rr} ${rr} 0 0;border-bottom:2px solid rgba(0,0,0,.45);`
          : `border-radius:0 0 ${rr} ${rr};`;
        d.style.cssText = `display:block;position:absolute;left:0;width:100%;height:50%;overflow:hidden;background:${bgColor()};backface-visibility:hidden;${br}${isTop ? 'top:0;' : 'top:50%;'}transition:background .25s;`;
        return d;
      }

      let curChar = animate ? rnd() : target;

      // Static halves (revealed/covered during the flip)
      const botStatic = makeHalf(false), botStaticLet = makeLetter(false, curChar);
      botStatic.appendChild(botStaticLet); el.appendChild(botStatic);
      const topStatic = makeHalf(true),  topStaticLet = makeLetter(true, curChar);
      topStatic.appendChild(topStaticLet); el.appendChild(topStatic);

      // Falling flap (front top half — shows the OLD char, folds down)
      const flapT = makeHalf(true);
      flapT.style.cssText += 'transform-origin:bottom center;transform:rotateX(0deg);z-index:4;transform-style:preserve-3d;';
      const flapTLet = makeLetter(true, curChar); flapT.appendChild(flapTLet); el.appendChild(flapT);
      const flapTShade = document.createElement('span');
      flapTShade.style.cssText = 'display:block;position:absolute;inset:0;background:rgba(0,0,0,0);pointer-events:none;z-index:2;';
      flapT.appendChild(flapTShade);

      // Rising flap (front bottom half — shows the NEW char, unfolds up)
      const flapB = makeHalf(false);
      flapB.style.cssText += 'transform-origin:top center;transform:rotateX(90deg);z-index:4;transform-style:preserve-3d;';
      const flapBLet = makeLetter(false, curChar); flapB.appendChild(flapBLet); el.appendChild(flapB);
      const flapBShade = document.createElement('span');
      flapBShade.style.cssText = 'display:block;position:absolute;inset:0;background:rgba(0,0,0,.5);pointer-events:none;z-index:2;';
      flapB.appendChild(flapBShade);

      // Hinge line
      const hinge = document.createElement('span');
      hinge.style.cssText = `display:block;position:absolute;left:-4%;width:108%;top:calc(50% - 1px);height:2px;background:rgba(0,0,0,.72);z-index:6;pointer-events:none;border-radius:2px;`;
      el.appendChild(hinge);
      // Outer shell
      const outer = document.createElement('span');
      outer.style.cssText = `display:block;position:absolute;inset:0;border-radius:${R}px;box-shadow:0 10px 28px rgba(0,0,0,.6),0 3px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.10);pointer-events:none;z-index:8;`;
      el.appendChild(outer);
      // Mid-hinge depth shadow
      const shade = document.createElement('span');
      shade.style.cssText = `display:block;position:absolute;left:0;right:0;top:50%;height:12%;background:linear-gradient(to bottom,rgba(0,0,0,.22),transparent);z-index:5;pointer-events:none;`;
      el.appendChild(shade);

      // Theme observer — update colors live when theme changes
      new MutationObserver(() => {
        const tc = letterColor(), bc = bgColor();
        [topStaticLet, botStaticLet, flapTLet, flapBLet].forEach(s => s.style.color = tc);
        [topStatic, botStatic, flapT, flapB].forEach(h => h.style.background = bc);
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      const totalFlips = 6 + idx * 2;   // later tiles keep ticking → cascade settle
      const half = FLIP_MS / 2;
      let flip = 0;

      function doFlip() {
        flip++;
        const isLast   = flip >= totalFlips;
        const nextChar = isLast ? target : rnd();

        // Pre-load the layers about to be exposed with the NEXT char.
        topStaticLet.textContent = nextChar;   // revealed behind the falling flap
        flapBLet.textContent     = nextChar;   // rises to cover the bottom half

        // Phase 1: top flap falls 0° → -90° (accelerating, like gravity)
        flapT.style.transition = `transform ${half}ms cubic-bezier(.36,0,.66,-.06)`;
        flapT.style.transform  = 'rotateX(-90deg)';
        flapTShade.style.transition = `background ${half}ms ease-in`;
        flapTShade.style.background  = 'rgba(0,0,0,.45)';

        setTimeout(() => {
          // Phase 2: bottom flap rises 90° → 0° (settling with a slight overshoot)
          flapB.style.transition = `transform ${half}ms cubic-bezier(.33,1.12,.68,1)`;
          flapB.style.transform  = 'rotateX(0deg)';
          flapBShade.style.transition = `background ${half}ms ease-out`;
          flapBShade.style.background  = 'rgba(0,0,0,0)';

          setTimeout(() => {
            // Commit the new char everywhere, snap both flaps back to rest instantly.
            curChar = nextChar;
            botStaticLet.textContent = nextChar;
            flapTLet.textContent     = nextChar;
            flapT.style.transition = 'none'; flapT.style.transform = 'rotateX(0deg)';
            flapTShade.style.transition = 'none'; flapTShade.style.background = 'rgba(0,0,0,0)';
            flapB.style.transition = 'none'; flapB.style.transform = 'rotateX(90deg)';
            flapBShade.style.transition = 'none'; flapBShade.style.background = 'rgba(0,0,0,.5)';
            if (!isLast) setTimeout(doFlip, HOLD_MS);
            else if (idx === lastIdx) revealDot();
          }, half + 10);
        }, half + 10);
      }

      if (animate) setTimeout(doFlip, idx * STAGGER + 120);
      else if (idx === lastIdx) revealDot();
    });
    }
  })();
});
