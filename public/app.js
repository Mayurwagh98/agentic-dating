// Proxy frontend: a tiny hash-routed SPA, no build step. Live updates arrive over SSE.
const $app = document.getElementById('app');
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(adminToken() ? { 'x-admin-token': adminToken() } : {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
};
const adminToken = () => { try { return localStorage.getItem('adminToken') || ''; } catch { return ''; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (src, name, size = '') =>
  src
    ? `<img class="avatar ${size}" src="${esc(src)}" referrerpolicy="no-referrer" alt="" onerror="this.outerHTML='<div class=&quot;avatar ${size}&quot;>${esc(initials(name))}</div>'">`
    : `<div class="avatar ${size}">${esc(initials(name))}</div>`;
const displayName = (p) => p.name || p.liSlug || p.igUsername;
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------------------------------------------------------------- live events
let config = {};
let runState = { running: false };
// what's busy right now (for the Stop button)
const busyPeople = new Set();
const liveDates = new Set();
function renderStop() {
  const busy = runState.running || busyPeople.size > 0 || liveDates.size > 0;
  document.getElementById('stopBtn').classList.toggle('hidden', !busy);
}
function trackBusy(ev) {
  if (ev.type === 'person') {
    if (['scraping', 'analyzing'].includes(ev.person.status)) busyPeople.add(ev.person.id);
    else busyPeople.delete(ev.person.id);
  }
  if (ev.type === 'date:start') liveDates.add(ev.date.id);
  if (ev.type === 'date:done') liveDates.delete(ev.date.id);
  if (ev.type === 'date:error') liveDates.delete(ev.dateId);
  if (ev.type === 'reload') { busyPeople.clear(); liveDates.clear(); }
  renderStop();
}
const listeners = new Set();
const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'run') { runState = ev.run; renderRunPill(); }
    trackBusy(ev);
    listeners.forEach((fn) => fn(ev));
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
function renderRunPill() {
  const el = document.getElementById('runpill');
  if (!runState.running) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.innerHTML = `<span class="dot"></span>${esc(runState.stage)} ${runState.total ? `${runState.done}/${runState.total}` : ''}`;
}

// ---------------------------------------------------------------- router
let cleanup = [];
const routes = [
  [/^#?\/?$/, home],
  [/^#\/add$/, addPage],
  [/^#\/p\/(\w+)$/, profilePage],
  [/^#\/date\/(\w+)$/, datePage],
  [/^#\/dates$/, datesPage],
  [/^#\/rankings$/, rankingsPage],
  [/^#\/how$/, howPage],
];
async function router() {
  cleanup.forEach((f) => f());
  cleanup = [];
  const hash = location.hash || '#/';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === hash || (hash.startsWith('#/p/') && a.dataset.nav === 'home')));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      window.scrollTo(0, 0);
      try { await fn(...m.slice(1)); } catch (e) { $app.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
      return;
    }
  }
  $app.innerHTML = '<div class="empty">Page not found</div>';
}
window.addEventListener('hashchange', router);

// ---------------------------------------------------------------- home
async function home() {
  const s = await api('/api/state');
  const ready = s.people.filter((p) => p.status === 'ready').length;
  const matches = s.dates.filter((d) => d.match).length;
  $app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">An agentic dating site</div>
        <h1>Your agent <em>dates</em><br/>so you don't have to.</h1>
        <p class="lede">Paste someone's LinkedIn and public Instagram. Their personal AI agent reads both, works out who they are and what they need, then goes on real conversational dates with everyone else's agents and comes back with a ranked shortlist.</p>
        <div class="row" style="margin-top:18px">
          <a class="btn" href="#/add">+ Add people</a>
          <button class="btn ghost" id="runBtn">▶ Run all agents</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.people.length}</b><span>people</span></div>
        <div class="stat"><b>${s.dates.length}</b><span>agent dates</span></div>
        <div class="stat"><b>${matches}</b><span>mutual 2nd dates</span></div>
      </div>
    </section>
    <div id="progress"></div>
    ${config.llm?.provider === 'mock' ? `<div class="notice section">Running with the offline <b>mock agent</b> (no LLM_API_KEY set). Add a key in <code>.env</code> for real analysis and dates.</div>` : ''}
    <section class="section">
      <div class="spread"><h2>The people</h2><span class="muted small">${ready} of ${s.people.length} profiles read by their agent</span></div>
      ${s.people.length ? `<div class="grid g3" id="people">${s.people.map(personCard).join('')}</div>` : `<div class="card empty">No one here yet. <a href="#/add">Add the first person</a>.</div>`}
    </section>
    ${s.dates.length ? `<section class="section"><div class="spread"><h2>Best dates so far</h2><a href="#/dates" class="small">All dates →</a></div><div class="grid g3">${s.dates.slice(0, 6).map(dateCard).join('')}</div></section>` : ''}
  `;
  document.getElementById('runBtn').onclick = startRun;
  renderProgress();
  let t;
  cleanup.push(on((ev) => {
    if (ev.type === 'run') renderProgress();
    if (['person', 'date:done', 'reload'].includes(ev.type)) { clearTimeout(t); t = setTimeout(() => { if (location.hash === '' || location.hash === '#/') home(); }, 800); }
  }));
}
function renderProgress() {
  const el = document.getElementById('progress');
  if (!el) return;
  if (!runState.running) { el.innerHTML = ''; return; }
  const pct = runState.total ? Math.round((runState.done / runState.total) * 100) : 5;
  el.innerHTML = `<div class="progress"><div class="spread"><b>${esc(runState.stage)}</b><span class="muted small">${runState.done}/${runState.total}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
}
async function startRun() {
  try { await api('/api/run', { method: 'POST' }); toast('Agents are on it. Watch the progress bar.'); } catch (e) { toast(e.message); }
}
const statusLabel = { new: 'queued', scraping: 'scraping profiles…', scraped: 'waiting for agent', analyzing: 'agent is reading…', ready: 'profile ready', error: 'error' };
function personCard(p) {
  return `<a class="card person" href="#/p/${p.id}">
    ${avatar(p.avatar, displayName(p), 'md')}
    <div class="meta">
      <div class="name">${esc(displayName(p))}</div>
      <div class="head">${esc(p.headline || p.linkedinUrl)}</div>
      <div class="status ${p.status}">${p.status === 'scraping' || p.status === 'analyzing' ? '<span class="spinner"></span> ' : ''}${esc(statusLabel[p.status] || p.status)}</div>
    </div></a>`;
}
function dateCard(d) {
  return `<a class="card datecard" href="#/date/${d.id}">
    <div class="spread"><div class="pair">${avatar(d.aAvatar, d.aName, 'sm')}${avatar(d.bAvatar, d.bName, 'sm')}</div>
    ${d.status === 'live' ? '<span class="chip warn"><span class="spinner"></span> live now</span>' : `<span class="chip ${d.match ? 'wine' : ''}">${d.match ? '♥ both want a 2nd date' : `mutual ${d.mutual}`}</span>`}</div>
    <h3 style="margin-top:12px">${esc(d.aName)} × ${esc(d.bName)}</h3>
    <div class="muted small">${d.opener ? `“${esc(d.opener.slice(0, 120))}${d.opener.length > 120 ? '…' : ''}”` : 'The agents are just sitting down…'}</div></a>`;
}

// ---------------------------------------------------------------- add
async function addPage() {
  const warn = [];
  if (config.scraper === 'apify' && !config.apify) warn.push('APIFY_TOKEN is not set on the server, so automatic scraping will fail. You can still paste profile text manually below.');
  if (config.llm?.provider === 'mock') warn.push('No LLM key set: the agent runs in offline mock mode.');
  $app.innerHTML = `
    <div class="eyebrow">Step 1 · find the people</div>
    <h1>Add people</h1>
    <p class="lede">Each person is exactly two official links: their LinkedIn and their <b>public</b> Instagram. Only add people who've agreed to be part of this.</p>
    ${warn.map((w) => `<div class="notice section" style="margin-top:16px">${esc(w)}</div>`).join('')}
    <div class="grid g2 section">
      <form class="card" id="one">
        <h3>One person</h3>
        <p class="muted small">Their agent starts right away: scrape → read → screen → date → rank.</p>
        <label>LinkedIn URL</label><input name="linkedinUrl" placeholder="https://www.linkedin.com/in/username" required />
        <label>Instagram URL (public)</label><input name="instagramUrl" placeholder="https://www.instagram.com/username" required />
        <div class="grid g2" style="gap:12px">
          <div><label>They are <span class="muted">(optional)</span></label><select name="gender"><option value="unspecified">Not specified</option><option value="woman">A woman</option><option value="man">A man</option><option value="nonbinary">Non-binary</option></select></div>
          <div><label>Interested in</label><select name="seeking"><option value="everyone">Everyone</option><option value="women">Women</option><option value="men">Men</option></select></div>
        </div>
        <p class="muted small" style="margin:6px 0 0">Set by you, never guessed by the agent. Used only to decide who can date whom.</p>
        <details><summary>Scraping blocked? Paste profile text instead</summary>
          <label>Text copied from their LinkedIn</label><textarea name="manualLinkedin" placeholder="Headline, About, experience…"></textarea>
          <label>Text copied from their Instagram</label><textarea name="manualInstagram" placeholder="Bio and recent captions…"></textarea>
        </details>
        <label class="check"><input type="checkbox" name="consent" required /> This person agreed to have their public profiles read by an AI agent for this project.</label>
        <div class="row" style="margin-top:16px"><button class="btn wine" type="submit">Create their agent</button></div>
      </form>
      <form class="card" id="bulk">
        <h3>Many at once</h3>
        <p class="muted small">One person per line: <code>linkedin-url, instagram-url</code>. Then hit <b>Run all agents</b>.</p>
        <label>People</label>
        <textarea name="text" style="min-height:230px" placeholder="https://www.linkedin.com/in/jane-doe, https://www.instagram.com/janedoe&#10;https://www.linkedin.com/in/john-roe, https://www.instagram.com/johnroe"></textarea>
        <label class="check"><input type="checkbox" name="consent" required /> Everyone listed agreed to be part of this.</label>
        <div class="row" style="margin-top:16px"><button class="btn" type="submit">Add all</button><button class="btn ghost" type="button" id="runAll">▶ Run all agents</button></div>
        <div id="bulkOut" class="small" style="margin-top:12px"></div>
      </form>
    </div>`;
  document.getElementById('one').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.consent = !!f.consent;
    try {
      const { person } = await api('/api/people', { method: 'POST', body: f });
      toast('Agent created. Watch it read their profiles.');
      location.hash = `#/p/${person.id}`;
    } catch (err) { toast(err.message); }
  };
  document.getElementById('bulk').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/api/people/bulk', { method: 'POST', body: { text: f.text, consent: !!f.consent } });
      document.getElementById('bulkOut').innerHTML = `<b>${r.added.length} added.</b>${r.errors.length ? `<div class="notice err" style="margin-top:8px">${r.errors.map(esc).join('<br>')}</div>` : ''}`;
      if (r.added.length) e.target.text.value = '';
    } catch (err) { toast(err.message); }
  };
  document.getElementById('runAll').onclick = startRun;
}

// ---------------------------------------------------------------- edit / remove (shared)
function manageBox(p) {
  return `<details class="card section" id="manage" style="padding:16px 22px"><summary style="margin:0">Edit links or remove this person</summary>
    <form id="editForm" style="margin-top:6px">
      <div class="grid g2" style="gap:12px">
        <div><label>LinkedIn URL</label><input name="linkedinUrl" value="${esc(p.linkedinUrl)}" required /></div>
        <div><label>Instagram URL (public)</label><input name="instagramUrl" value="${esc(p.instagramUrl)}" required /></div>
        <div><label>They are</label><select name="gender">${['unspecified', 'woman', 'man', 'nonbinary'].map((g) => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${g === 'unspecified' ? 'Not specified' : g}</option>`).join('')}</select></div>
        <div><label>Interested in</label><select name="seeking">${['everyone', 'women', 'men'].map((g) => `<option value="${g}" ${p.seeking === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      </div>
      <details><summary>Paste profile text instead of scraping</summary>
        <label>Text copied from their LinkedIn</label><textarea name="manualLinkedin">${esc(p.manual?.linkedin || '')}</textarea>
        <label>Text copied from their Instagram</label><textarea name="manualInstagram">${esc(p.manual?.instagram || '')}</textarea>
      </details>
      <p class="muted small">Changing a link re-reads this person and clears their old scores and dates.</p>
      <div class="row"><button class="btn" type="submit">Save changes</button><button class="btn ghost" type="button" id="removeBtn" style="border-color:var(--red);color:var(--red)">Remove person</button></div>
    </form></details>`;
}
function wireManage(id) {
  const form = document.getElementById('editForm');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/people/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(form)) });
      toast(r.sourceChanged ? 'Saved. The agent is re-reading them.' : 'Saved.');
      profilePage(id);
    } catch (err) { toast(err.message); }
  };
  document.getElementById('removeBtn').onclick = async () => {
    try { await api(`/api/people/${id}`, { method: 'DELETE' }); toast('Removed.'); location.hash = '#/'; } catch (err) { toast(err.message); }
  };
}

// ---------------------------------------------------------------- profile
async function profilePage(id) {
  const { person: p, rankings, dates } = await api(`/api/people/${id}`);
  const pr = p.profile;
  const name = displayName(p);
  const links = `<div class="row links" style="margin-top:10px">
      <a class="chip li" href="${esc(p.linkedinUrl)}" target="_blank" rel="noopener">in · LinkedIn ↗</a>
      <a class="chip ig" href="${esc(p.instagramUrl)}" target="_blank" rel="noopener">◎ @${esc(p.igUsername)} ↗</a>
      ${p.gender !== 'unspecified' ? `<span class="chip">${esc(p.gender)}</span>` : ''}<span class="chip">into ${esc(p.seeking)}</span>
    </div>`;

  if (!pr) {
    const titleFor = (st) => (st === 'error' ? 'Something went wrong' : ['new', 'scraped'].includes(st) ? 'Waiting to start' : st === 'scraping' ? 'Fetching their LinkedIn + Instagram' : 'The agent is reading this person');
    $app.innerHTML = `
      <div class="phead">${avatar(p.avatar, name, 'lg')}<div><div class="eyebrow">Agent at work</div><h1>${esc(name)}</h1>${links}</div></div>
      <div class="card section">
        <h3 id="waitTitle">${titleFor(p.status)}</h3>
        <div id="errBox">${p.status === 'error' ? `<div class="notice err">${esc(p.error)}</div><p class="muted small" style="margin:8px 0 0">Tip: wrong link or scraping blocked? Use "Edit links" below to fix the URL or paste their profile text.</p>` : ''}</div>
        <div class="row" id="startRow" style="margin-top:10px"><button class="btn wine" id="retry"></button><span class="muted small" id="startHint"></span></div>
        <div class="line muted" id="statusLine" style="margin-top:12px"></div>
        <div class="reading" id="reading" style="margin-top:8px"></div>
      </div>
      ${config.adminLocked && !adminToken() ? '' : manageBox(p)}`;
    wireManage(id);
    // keep header, button and status in sync with the real status
    const sync = (st) => {
      const idle = ['new', 'scraped', 'error'].includes(st);
      document.getElementById('waitTitle').textContent = titleFor(st);
      document.getElementById('startRow').classList.toggle('hidden', !idle);
      document.getElementById('retry').textContent = st === 'error' ? '↻ Retry' : '▶ Start this agent';
      document.getElementById('startHint').textContent = st === 'scraped' ? 'Profiles are already scraped. The agent will read them now.' : st === 'new' ? 'Scrape both profiles and read them.' : '';
      document.getElementById('statusLine').innerHTML = `${idle ? '' : '<span class="spinner"></span> '}Status: ${esc(statusLabel[st] || st)}`;
      if (st !== 'error') document.getElementById('errBox').innerHTML = '';
    };
    sync(p.status);
    if (p.status === 'error' && document.getElementById('manage')) document.getElementById('manage').open = /Instagram|LinkedIn|scrap|private|exist|found/i.test(p.error || '');
    document.getElementById('retry').onclick = async () => {
      sync('scraping' === p.status ? 'scraping' : p.raw ? 'analyzing' : 'scraping'); // instant feedback
      try { await api(`/api/people/${id}/process`, { method: 'POST', body: {} }); } catch (e) { toast(e.message); }
    };
    cleanup.push(on((ev) => {
      const box = document.getElementById('reading');
      if (!box) return;
      if (ev.type === 'person' && ev.person.id === id) {
        if (ev.person.status === 'ready') return profilePage(id);
        if (ev.person.status === 'error') return profilePage(id);
        sync(ev.person.status);
      }
      if (ev.type === 'log' && ev.msg.includes(p.liSlug)) box.insertAdjacentHTML('beforeend', `<div class="line small">${esc(ev.msg)}</div>`);
      if (ev.type === 'reading' && ev.personId === id) {
        if (ev.phase === 'start') box.insertAdjacentHTML('beforeend', `<div class="line" data-src="${ev.source}"><span class="spinner"></span> ${ev.source === 'analyst' ? 'Combining both sources into a profile…' : `Reading their <b>${ev.source === 'linkedin' ? 'LinkedIn' : 'Instagram'}</b>…`}</div>`);
        if (ev.phase === 'done') box.querySelector(`[data-src="${ev.source}"] .spinner`)?.replaceWith('✓');
        if (ev.phase === 'done') box.insertAdjacentHTML('beforeend', `<div class="line card" style="padding:14px"><div class="chip ${ev.source === 'linkedin' ? 'li' : 'ig'}">${ev.source} notes</div><ul class="notes small">${(ev.notes?.observations || []).map((o) => `<li><b>${esc(o.note)}</b><div class="ev">${esc(o.evidence)}</div></li>`).join('')}</ul></div>`);
      }
    }));
    return;
  }

  const srcChip = (s) => (s ? `<span class="chip ${s === 'linkedin' ? 'li' : s === 'instagram' ? 'ig' : ''}">${s === 'linkedin' ? 'in' : s === 'instagram' ? 'ig' : 'both'}</span>` : '');
  const list = (arr, key) => (arr || []).map((x) => `<div class="item"><div class="row" style="gap:8px"><b>${esc(x[key])}</b>${srcChip(x.source)}</div>${x.evidence || x.why ? `<div class="ev">${esc(x.evidence || x.why)}</div>` : ''}</div>`).join('') || '<div class="muted small">No signal found</div>';
  const notes = (n, src) => n ? `<div class="card"><div class="spread"><span class="chip ${src === 'linkedin' ? 'li' : 'ig'}">${src === 'linkedin' ? 'LinkedIn' : 'Instagram'} field notes</span><span class="muted small">data: ${esc(n.dataQuality || '?')}</span></div><ul class="notes small" style="padding-left:18px;margin-bottom:0">${(n.observations || []).map((o) => `<li><b>${esc(o.note)}</b><div class="ev">“${esc(o.evidence)}”</div></li>`).join('')}</ul></div>` : `<div class="card muted">No ${src} data${p.scrapeWarnings?.length ? `: ${esc(p.scrapeWarnings.join(' '))}` : ''}</div>`;

  $app.innerHTML = `
    <div class="phead">${avatar(p.avatar, name, 'lg')}
      <div><div class="eyebrow">Profile · as read by their agent</div><h1>${esc(pr.name || name)}</h1>
      <div class="lede" style="font-size:16px">${esc(pr.headline || '')}${pr.location ? ` · ${esc(pr.location)}` : ''}</div>${links}</div>
    </div>
    <p class="quote section" style="margin-top:28px">“${esc(pr.oneLiner)}”</p>
    <p class="lede" style="max-width:820px">${esc(pr.summary)}</p>

    <section class="section">
      <div class="eyebrow">1 · The reading</div><h2>What the agent noticed</h2>
      <div class="grid g2">${notes(p.notes?.linkedin, 'linkedin')}${notes(p.notes?.instagram, 'instagram')}</div>
    </section>

    <section class="section">
      <div class="eyebrow">2 · The analysis</div><h2>Who they are</h2>
      <div class="grid g3">
        <div class="card"><h3>Needs</h3>${list(pr.needs, 'need')}</div>
        <div class="card"><h3>Hobbies</h3>${list(pr.hobbies, 'name')}</div>
        <div class="card"><h3>Interests</h3>${list(pr.interests, 'name')}</div>
        <div class="card"><h3>Values</h3>${list(pr.values, 'name')}</div>
        <div class="card"><h3>Personality</h3>${list(pr.personality, 'trait')}</div>
        <div class="card"><h3>Vibe</h3>${Object.entries(pr.vibe || {}).map(([k, v]) => `<div class="vibe"><span>${esc(k)}</span><div class="bar"><i style="width:${Number(v) || 0}%"></i></div><b>${Math.max(0, Math.min(100, Number(v) || 0))}</b></div>`).join('')}
          <h3 style="margin-top:16px">Lifestyle</h3><dl class="kv">${Object.entries(pr.lifestyle || {}).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
      </div>
      <div class="grid g3" style="margin-top:16px">
        <div class="card"><h3>Green flags</h3>${(pr.greenFlags || []).map((x) => `<div class="item">✓ ${esc(x)}</div>`).join('')}</div>
        <div class="card"><h3>Possible frictions</h3>${(pr.frictions || []).map((x) => `<div class="item">△ ${esc(x)}</div>`).join('')}</div>
        <div class="card"><h3>Ideal match</h3><p>${esc(pr.idealMatch)}</p><h3>Date ideas</h3>${(pr.dateIdeas || []).map((x) => `<div class="item">${esc(x)}</div>`).join('')}</div>
      </div>
      <div class="card" style="margin-top:16px"><div class="spread"><div><b>Communication style:</b> ${esc(pr.communicationStyle)}</div><span class="chip ${pr.confidence >= 60 ? 'ok' : 'warn'}">agent confidence ${esc(pr.confidence)}%</span></div>
        ${pr.dataGaps?.length ? `<div class="muted small" style="margin-top:8px">What we couldn't learn: ${esc(pr.dataGaps.join(' · '))}</div>` : ''}</div>
    </section>

    <section class="section">
      <div class="spread"><div><div class="eyebrow">3 · The ranking</div><h2>Who fits ${esc((pr.name || name).split(' ')[0])} best</h2></div>
      <span class="muted small">Dated pairs: 70% mutual date score + 30% screening. Not dated yet: screening only, discounted.</span></div>
      <div class="card">${rankings.length ? rankings.map((r, i) => rankRow(r, i, id)).join('') : '<div class="empty">No compatible profiles yet.</div>'}</div>
    </section>

    <section class="section">
      <details><summary>Raw scraped data (the only two sources the agent used)${p.scrapedAt ? ` · fetched ${esc(new Date(p.scrapedAt).toLocaleString())}` : ''}</summary>
        <div class="grid g2" style="margin-top:12px"><pre class="raw">${esc(JSON.stringify(p.raw?.linkedin, null, 2))}</pre><pre class="raw">${esc(JSON.stringify(p.raw?.instagram, null, 2))}</pre></div>
      </details>
      ${config.adminLocked && !adminToken() ? '' : `<div class="row" style="margin-top:16px"><button class="btn ghost sm" id="refresh" title="Scrape LinkedIn + Instagram again (bypasses cache). Re-analyses only if the data changed.">↻ Refresh data</button><button class="btn ghost sm" id="reanalyze" title="Run the agent's analysis again on the same data">Re-read profile</button></div>${manageBox(p)}`}
    </section>`;

  $app.querySelectorAll('[data-date-with]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('/api/dates', { method: 'POST', body: { a: id, b: b.dataset.dateWith } }); location.hash = `#/date/${r.dateId}`; } catch (e) { toast(e.message); b.disabled = false; }
  }));
  const re = document.getElementById('reanalyze');
  if (re) re.onclick = async () => { await api(`/api/people/${id}/process`, { method: 'POST', body: { reanalyze: true } }); toast('Re-reading…'); setTimeout(() => profilePage(id), 400); };
  const rf = document.getElementById('refresh');
  if (rf) rf.onclick = async () => { await api(`/api/people/${id}/process`, { method: 'POST', body: { refresh: true } }); toast('Fetching fresh data…'); setTimeout(() => profilePage(id), 400); };
  wireManage(id);
  cleanup.push(on((ev) => { if ((['date:done', 'date:start'].includes(ev.type) && (ev.date.a === id || ev.date.b === id)) || (ev.type === 'date:error') || (ev.type === 'rankings' && ev.personId === id)) { const y = window.scrollY; profilePage(id).then(() => window.scrollTo(0, y)); } }));
}

function rankRow(r, i, selfId) {
  return `<div class="rank ${i < 3 ? 'top' : ''}">
    <div class="n">${i + 1}</div>
    <a href="#/p/${r.id}">${avatar(r.avatar, r.name)}</a>
    <div style="min-width:0">
      <div class="row" style="gap:8px"><a href="#/p/${r.id}" style="text-decoration:none"><b>${esc(r.name)}</b></a>
        ${r.match ? '<span class="chip wine">♥ both want a 2nd date</span>' : ''}${r.dated ? `<span class="chip ok">dated · mutual ${r.mutual}</span>` : r.live ? '<span class="chip warn"><span class="spinner"></span> on a date right now</span>' : '<span class="chip">not dated yet</span>'}</div>
      <div class="muted small">${esc(r.headline || '')}</div>
      <div class="small" style="margin-top:4px">${r.live ? 'Their agents are talking now. The verdict and fit score update when the date ends.' : r.dated ? `<b>Agent's verdict:</b> ${esc(r.verdict)} <span class="muted">(my agent ${r.myAgentScore} · their agent ${r.theirAgentScore})</span>` : esc(r.compatReason || '')}</div>
      <div style="margin-top:6px">${r.dated ? `<a class="btn ghost sm" href="#/date/${r.dateId}">Watch the date →</a>` : r.live ? `<a class="btn wine sm" href="#/date/${r.dateId}">● Watch live →</a>` : `<button class="btn ghost sm" data-date-with="${r.id}">Send agents on a date</button>`}</div>
    </div>
    <div class="score">${r.score}<small>fit score</small></div>
  </div>`;
}

// ---------------------------------------------------------------- date theater
async function datePage(id) {
  let { date: d } = await api(`/api/dates/${id}`);
  $app.innerHTML = `
    <div class="eyebrow">An agent date${d.status === 'live' ? ' · happening live' : ''}</div>
    <div class="couple">
      <a class="who" href="#/p/${d.a}">${avatar(d.aAvatar, d.aName, 'lg')}<b>${esc(d.aName)}</b><div class="muted small">represented by their agent</div></a>
      <div class="heart">♥</div>
      <a class="who" href="#/p/${d.b}">${avatar(d.bAvatar, d.bName, 'lg')}<b>${esc(d.bName)}</b><div class="muted small">represented by their agent</div></a>
    </div>
    <div class="theater">
      <div class="card">
        <div class="spread" style="margin-bottom:14px"><h3 style="margin:0">The conversation</h3><label class="check" style="margin:0"><input type="checkbox" id="showThoughts" checked /> show agents' private notes</label></div>
        <div class="chat" id="chat"></div>
      </div>
      <div id="side"></div>
    </div>`;
  const chat = document.getElementById('chat');
  const toggle = document.getElementById('showThoughts');
  toggle.onchange = () => chat.querySelectorAll('.thought').forEach((t) => t.classList.toggle('hidden', !toggle.checked));
  const addMsg = (m) => {
    chat.querySelector('.typing')?.remove();
    chat.insertAdjacentHTML('beforeend', `<div class="msg ${m.side}"><div class="who">${esc(m.name)}'s agent</div><div class="bubble">${esc(m.text)}</div>${m.thought ? `<div class="thought ${toggle.checked ? '' : 'hidden'}">🔒 ${esc(m.thought)}</div>` : ''}</div>`);
  };
  d.turns.forEach(addMsg);
  const renderSide = () => {
    const side = document.getElementById('side');
    if (d.status !== 'done') { side.innerHTML = `<div class="card"><h3>Date in progress</h3><p class="muted small">Each agent only sees its own person's full profile, plus the other person's dating listing. After the last message both agents report back privately.</p></div>`; return; }
    const db = (x, nm) => `<div class="card debrief" style="margin-bottom:14px"><div class="muted small">${esc(nm)}'s agent reports back</div><div class="spread" style="align-items:center"><div class="big">${x.score}</div><span class="chip ${x.secondDate ? 'ok' : 'err'}">${x.secondDate ? 'wants a 2nd date' : 'no 2nd date'}</span></div>
      <p style="margin:8px 0"><b>${esc(x.verdict)}</b></p><p class="small">${esc(x.reportToPerson)}</p>
      <div class="vibe"><span>chemistry</span><div class="bar"><i style="width:${x.chemistry}%"></i></div><b>${x.chemistry}</b></div>
      <div class="vibe"><span>needs met</span><div class="bar"><i style="width:${x.needsMet}%"></i></div><b>${x.needsMet}</b></div>
      <div class="vibe"><span>lifestyle</span><div class="bar"><i style="width:${x.lifestyleFit}%"></i></div><b>${x.lifestyleFit}</b></div>
      <div class="vibe"><span>values</span><div class="bar"><i style="width:${x.valuesFit}%"></i></div><b>${x.valuesFit}</b></div>
      ${(x.greenFlags || []).map((g) => `<div class="small">✓ ${esc(g)}</div>`).join('')}${(x.redFlags || []).map((g) => `<div class="small" style="color:var(--red)">△ ${esc(g)}</div>`).join('')}</div>`;
    side.innerHTML = `${d.match ? '<div class="match-banner" style="margin-bottom:14px">♥ It\'s a match: both agents want a second date</div>' : ''}
      <div class="card" style="margin-bottom:14px;text-align:center"><div class="muted small">mutual score (harmonic mean)</div><div class="debrief"><div class="big">${d.mutual}</div></div></div>
      ${db(d.debrief.a, d.aName)}${db(d.debrief.b, d.bName)}`;
  };
  renderSide();
  if (d.status === 'live') {
    cleanup.push(on(async (ev) => {
      if (ev.dateId !== id && ev.date?.id !== id) return;
      if (ev.type === 'date:typing') { chat.querySelector('.typing')?.remove(); chat.insertAdjacentHTML('beforeend', `<div class="typing ${ev.side}"><span class="spinner"></span> ${esc(ev.name)}'s agent is typing…</div>`); }
      if (ev.type === 'date:msg') addMsg(ev.msg);
      if (ev.type === 'date:done') { d = (await api(`/api/dates/${id}`)).date; renderSide(); }
      if (ev.type === 'date:error') { toast(ev.error === 'Stopped by user' ? 'Date stopped.' : 'Date failed: ' + ev.error); chat.querySelector('.typing')?.remove(); }
    }));
  }
}

// ---------------------------------------------------------------- dates list
async function datesPage() {
  const s = await api('/api/state');
  $app.innerHTML = `<div class="eyebrow">Step 3 · the agents date</div><h1>Dates</h1>
    <p class="lede">Every date here was a real turn-by-turn conversation between two agents, each speaking for its own person.</p>
    <div class="grid g3 section">${s.dates.map(dateCard).join('') || '<div class="card empty">No dates yet. Run the agents from the People page.</div>'}</div>`;
  let t;
  cleanup.push(on((ev) => { if (ev.type === 'date:start' || ev.type === 'date:done') { clearTimeout(t); t = setTimeout(datesPage, 600); } }));
}

// ---------------------------------------------------------------- rankings
async function rankingsPage() {
  const { rankings } = await api('/api/rankings');
  $app.innerHTML = `<div class="eyebrow">Step 4 · the ranking</div><h1>Who fits whom</h1>
    <p class="lede">Top five for every person. Open anyone for their full ranking, the reasoning, and the dates behind it.</p>
    <div class="board section">${rankings.map((p) => `<div class="card">
      <a href="#/p/${p.id}" class="row" style="text-decoration:none;margin-bottom:10px">${avatar(p.avatar, p.name)}<div><b style="font-family:var(--serif);font-size:18px">${esc(p.name)}</b><div class="muted small">${esc(p.headline || '')}</div></div></a>
      ${p.top.map((r, i) => `<a class="mini" href="${r.dated ? `#/date/${r.dateId}` : `#/p/${r.id}`}"><span class="muted">${i + 1}</span>${avatar(r.avatar, r.name, 'sm')}<span>${esc(r.name)} ${r.match ? '<span style="color:var(--wine)">♥</span>' : ''}</span><b>${r.score}</b></a>`).join('') || '<div class="muted small">No matches yet</div>'}
    </div>`).join('') || '<div class="card empty">No rankings yet.</div>'}</div>`;
}

// ---------------------------------------------------------------- how it works
async function howPage() {
  $app.innerHTML = `<div class="eyebrow">Under the hood</div><h1>How Proxy works</h1>
    <p class="lede">Every person is represented by an AI agent. The agent only ever uses two sources: the person's LinkedIn and their public Instagram.</p>
    <div class="steps section">
      <div class="card"><h3>Find the people</h3>You paste two official links per person. Links are validated and normalised; private Instagram profiles are rejected.</div>
      <div class="card"><h3>Scrape</h3>LinkedIn and Instagram block plain HTTP scraping, so the server runs Apify actors (<code>${esc(config.scraper === 'apify' ? 'harvestapi/linkedin-profile-scraper' : config.scraper)}</code>, <code>apify/instagram-profile-scraper</code>) through Apify's REST API and normalises the results: headline, about, experience, education, skills; bio, and the latest captions, hashtags and locations.</div>
      <div class="card"><h3>The agent reads its person</h3>A <b>reader</b> agent goes through each source separately and writes field notes with quoted evidence. An <b>analyst</b> step merges both into the profile: needs, hobbies, interests, values, personality, vibe, lifestyle, green flags, frictions, ideal match. Each claim is tagged with the source it came from. It is told never to infer sensitive traits (religion, health, orientation and so on) and to admit data gaps.</div>
      <div class="card"><h3>Screening</h3>Each agent reviews every compatible person's dating listing and scores how well they'd fit <i>its</i> person (0-100). Its top ${config.shortlistK || 4} go on real dates. That keeps the number of dates linear, not N².</div>
      <div class="card"><h3>The agents date</h3>Two agents take turns (${config.dateTurns || 8} messages). Each agent sees its own person's full profile, but only the other person's public listing, just like a real dating app. A phase script moves the date along: plan → hobbies → ambitions → needs → a gentle friction test → wrap-up. Each turn the agent also writes a private note you can toggle on.</div>
      <div class="card"><h3>Debrief and ranking</h3>After the date each agent privately reports back to its person: score, chemistry, needs met, lifestyle and values fit, flags, and whether to go on a second date. The pair's <b>mutual score</b> is the harmonic mean of the two agents' scores, so a match has to work for both people. A person's ranking blends mutual date scores (70%) with screening scores (30%). Anyone not dated yet ranks on a discounted screening score, and you can send them on a date with one click.</div>
    </div>
    <div class="card section"><h3>Stack</h3><p>Node.js + Express, a JSON-file store, Server-Sent Events for the live view, and a vanilla-JS single page app. The LLM is any OpenAI-compatible endpoint (currently <b>${esc(config.llm?.provider)} · ${esc(config.llm?.model)}</b>). Scraping is done with Apify.</p>
      <div class="row"><a class="btn ghost sm" href="/api/export">Download all data (JSON)</a></div></div>`;
}

// ---------------------------------------------------------------- boot
(async () => {
  config = await api('/api/config').catch(() => ({}));
  try {
    const s = await api('/api/state');
    runState = s.run;
    s.people.filter((p) => ['scraping', 'analyzing'].includes(p.status)).forEach((p) => busyPeople.add(p.id));
    s.dates.filter((d) => d.status === 'live').forEach((d) => liveDates.add(d.id));
    renderRunPill();
    renderStop();
  } catch {}
  document.getElementById('stopBtn').onclick = async () => {
    try { await api('/api/stop', { method: 'POST' }); toast('All agents stopped. Finished work is kept.'); router(); } catch (e) { toast(e.message); }
  };
  connect();
  router();
})();
