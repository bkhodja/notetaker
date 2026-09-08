/* ===========================================================================
   NoteTaker frontend
   - Loads notes from the local server, edits them with EasyMDE, autosaves.
   - Renders [[wiki-links]] as clickable links (via a marked extension).
   - Provides [[ autocomplete, search, tag filters, backlinks and a graph view.
   All state is kept simple and global — this is a single-user local app.
=========================================================================== */

const state = {
  currentSlug: null,   // slug of the note open in the editor (or null)
  notes: [],           // cached list of all notes (metadata) for autocomplete/resolve
  activeTag: null,     // currently selected tag filter
  searchQuery: '',     // current search box value
  easymde: null,       // EasyMDE editor instance
  cm: null,            // underlying CodeMirror instance
  saveTimer: null,     // debounce timer for autosave
  network: null,       // vis-network instance (graph)
  suppressChange: false, // ignore editor "change" events while loading a note
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function slugify(title) {
  return String(title)
    .trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
function linkKey(s) {
  // Lowercase, punctuation/whitespace -> single space, trim. Matches server-side
  // linkKey so "[[Module 1 — Foo & Bar]]" resolves to note "module-1-foo-bar".
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// A compact label for graph nodes: "Module 1 — Long Title" -> "Module 1".
// Non-module titles are truncated so the graph stays readable.
function shortLabel(title) {
  const m = /^\s*module\s+(\d+)/i.exec(title);
  if (m) return `Module ${m[1]}`;
  return title.length > 22 ? title.slice(0, 20).trim() + '…' : title;
}

// Resolve a wiki-link target against the cached notes list (synchronous).
// Returns the matching note meta, or null if it doesn't exist yet.
function resolveLocal(target) {
  const wantSlug = slugify(target);
  const wantKey = linkKey(target);
  return state.notes.find((n) => n.slug === wantSlug || linkKey(n.title) === wantKey) || null;
}

// ---------------------------------------------------------------------------
// Markdown rendering with [[wiki-link]] support
// ---------------------------------------------------------------------------
// Register a marked extension that turns [[Title]] or [[Title|Alias]] into a
// clickable span. Existence is decided from the client-side cache so rendering
// stays synchronous; missing notes get a distinct style.
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const m = /^\[\[([^\]]+?)\]\]/.exec(src);
      if (m) {
        const [target, alias] = m[1].split('|');
        return {
          type: 'wikilink',
          raw: m[0],
          target: target.trim(),
          text: (alias || target).trim(),
        };
      }
    },
    renderer(token) {
      const exists = !!resolveLocal(token.target);
      const cls = exists ? 'wikilink' : 'wikilink missing';
      return `<a class="${cls}" data-target="${escapeHtml(token.target)}">${escapeHtml(token.text)}</a>`;
    },
  }],
});

function renderMarkdown(md) {
  return marked.parse(md || '');
}

// ---------------------------------------------------------------------------
// Editor (EasyMDE) setup
// ---------------------------------------------------------------------------
function initEditor() {
  state.easymde = new EasyMDE({
    element: $('#editor'),
    autofocus: false,
    spellChecker: false,
    status: ['lines', 'words'],
    placeholder: 'Start writing in Markdown…  Use [[Note title]] to link and #tags to organise.',
    previewRender: (plaintext) => renderMarkdown(plaintext),
    toolbar: [
      'bold', 'italic', 'heading', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'code', 'table', 'link', '|',
      'preview', 'side-by-side', 'fullscreen',
    ],
  });
  state.cm = state.easymde.codemirror;

  // Autosave: debounce editor changes.
  state.cm.on('change', () => {
    if (state.suppressChange || !state.currentSlug) return;
    setSaveStatus('Editing…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveCurrent, 700);
  });

  // Wiki-link autocomplete.
  state.cm.on('keyup', maybeShowAutocomplete);
  // Intercept navigation keys for the autocomplete dropdown (capture phase so
  // we act before CodeMirror handles them).
  state.cm.getWrapperElement().addEventListener('keydown', onEditorKeydown, true);
}

function setSaveStatus(text) { $('#save-status').textContent = text; }

async function saveCurrent() {
  if (!state.currentSlug) return;
  const content = state.easymde.value();
  try {
    const meta = await api(`/api/notes/${encodeURIComponent(state.currentSlug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setSaveStatus('Saved ✓');
    // Title may have changed (from a new # heading); reflect it.
    if (meta.title) $('#title-input').value = meta.title;
    await refreshNotes();          // update list + tag chips
    await loadBacklinks(state.currentSlug);
  } catch (err) {
    setSaveStatus('Save failed');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Opening / creating / deleting notes
// ---------------------------------------------------------------------------
async function openNote(slug) {
  if (!slug) return;
  // Save any pending edits before switching.
  clearTimeout(state.saveTimer);
  if (state.currentSlug && state.currentSlug !== slug) await saveCurrent();

  const note = await api(`/api/notes/${encodeURIComponent(slug)}`);
  state.currentSlug = note.slug;

  $('#empty-state').classList.add('hidden');
  $('#editor-header').classList.remove('hidden');
  $('#editor-container').classList.remove('hidden');

  state.suppressChange = true;
  state.easymde.value(note.content || '');
  state.suppressChange = false;

  $('#title-input').value = note.title || '';
  setSaveStatus(note.exists ? '' : 'New');

  renderNoteList();
  await loadBacklinks(slug);
  if ($('#tab-graph').classList.contains('active')) renderGraph();
}

async function createNote(title) {
  const t = (title || '').trim();
  if (!t) return;
  const slug = slugify(t);
  if (!slug) { alert('Please enter a valid note title.'); return; }
  // Seed with an H1 so the title is captured.
  const existing = state.notes.find((n) => n.slug === slug);
  if (!existing) {
    await api(`/api/notes/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `# ${t}\n\n` }),
    });
    await refreshNotes();
  }
  await openNote(slug);
  state.easymde.codemirror.focus();
  // Place cursor at the end.
  state.cm.setCursor(state.cm.lineCount(), 0);
}

async function deleteCurrent() {
  if (!state.currentSlug) return;
  const note = state.notes.find((n) => n.slug === state.currentSlug);
  const name = note ? note.title : state.currentSlug;
  if (!confirm(`Delete "${name}"? This removes the .md file from disk.`)) return;
  await api(`/api/notes/${encodeURIComponent(state.currentSlug)}`, { method: 'DELETE' });
  state.currentSlug = null;
  $('#editor-header').classList.add('hidden');
  $('#editor-container').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  await refreshNotes();
  $('#backlinks-list').innerHTML = '';
  $('#backlinks-empty').classList.remove('hidden');
  if ($('#tab-graph').classList.contains('active')) renderGraph();
}

// ---------------------------------------------------------------------------
// Note list + tags + search
// ---------------------------------------------------------------------------
async function refreshNotes() {
  // Always keep the full list cached (for autocomplete/link resolution)…
  state.notes = await api('/api/notes');
  renderTagChips(await api('/api/tags'));
  // …but the visible list respects the current search/tag filters.
  await renderFilteredList();
}

async function renderFilteredList() {
  const q = state.searchQuery.trim();
  const tag = state.activeTag;
  let items;
  if (q || tag) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    items = await api(`/api/search?${params.toString()}`);
  } else {
    items = state.notes;
  }
  renderNoteList(items);
}

function renderNoteList(items) {
  const list = items || state.notes;
  const ul = $('#note-list');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = `<li class="list-empty">${
      state.searchQuery || state.activeTag ? 'No matching notes.' : 'No notes yet. Create one!'
    }</li>`;
    return;
  }
  for (const n of list) {
    const li = document.createElement('li');
    li.className = 'note-item' + (n.slug === state.currentSlug ? ' active' : '');
    li.dataset.slug = n.slug;
    const tagsHtml = (n.tags || []).length
      ? `<div class="note-tags">${n.tags.map((t) => `<span class="mini-tag">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const snippet = n.snippet ? `<div class="note-snippet">${escapeHtml(n.snippet)}</div>` : '';
    li.innerHTML = `
      <div class="note-title">${escapeHtml(n.title)}</div>
      <div class="note-meta">${timeAgo(n.mtime)}</div>
      ${snippet}${tagsHtml}`;
    li.addEventListener('click', () => openNote(n.slug));
    ul.appendChild(li);
  }
}

function renderTagChips(tags) {
  const box = $('#tag-filters');
  box.innerHTML = '';
  for (const { tag, count } of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (state.activeTag === tag ? ' active' : '');
    chip.textContent = `#${tag} ${count}`;
    chip.addEventListener('click', () => {
      state.activeTag = state.activeTag === tag ? null : tag;
      renderTagChips(tags);
      renderFilteredList();
    });
    box.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------
async function loadBacklinks(slug) {
  const links = await api(`/api/backlinks/${encodeURIComponent(slug)}`);
  const ul = $('#backlinks-list');
  ul.innerHTML = '';
  if (!links.length) {
    $('#backlinks-empty').classList.remove('hidden');
    return;
  }
  $('#backlinks-empty').classList.add('hidden');
  for (const n of links) {
    const li = document.createElement('li');
    li.className = 'backlink-item';
    li.textContent = n.title;
    li.addEventListener('click', () => openNote(n.slug));
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Graph (vis-network)
// ---------------------------------------------------------------------------
async function renderGraph() {
  const data = await api('/api/graph');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const nodeColor = isDark ? '#818cf8' : '#4f46e5';
  const fontColor = isDark ? '#e6e7ea' : '#1f2328';

  const nodes = data.nodes.map((n) => ({
    id: n.id,
    label: shortLabel(n.label),
    title: n.label, // full title shown on hover
    color: n.id === state.currentSlug
      ? { background: '#f0abfc', border: '#c026d3' }
      : { background: nodeColor, border: nodeColor },
    font: { color: fontColor },
  }));
  const edges = data.edges.map((e) => ({ from: e.from, to: e.to }));

  const container = $('#graph');
  const visData = {
    nodes: new vis.DataSet(nodes),
    edges: new vis.DataSet(edges),
  };
  const options = {
    nodes: { shape: 'dot', size: 14, borderWidth: 2 },
    edges: { arrows: 'to', color: { color: isDark ? '#4b5563' : '#c7cad1' }, smooth: { type: 'continuous' } },
    physics: { stabilization: true, barnesHut: { springLength: 120 } },
    interaction: { hover: true },
  };
  if (state.network) state.network.destroy();
  state.network = new vis.Network(container, visData, options);
  state.network.on('click', (params) => {
    if (params.nodes.length) openNote(params.nodes[0]);
  });
}

// ---------------------------------------------------------------------------
// Wiki-link autocomplete
// ---------------------------------------------------------------------------
const ac = { open: false, items: [], activeIndex: 0, from: null, query: '' };

function maybeShowAutocomplete() {
  const cm = state.cm;
  const cur = cm.getCursor();
  const lineText = cm.getRange({ line: cur.line, ch: 0 }, cur);
  const m = /\[\[([^\]]*)$/.exec(lineText); // "[[" followed by partial (no closing yet)
  if (!m) { hideAutocomplete(); return; }

  ac.query = m[1];
  ac.from = { line: cur.line, ch: cur.ch - m[1].length };
  const q = ac.query.toLowerCase();
  const matches = state.notes
    .filter((n) => n.title.toLowerCase().includes(q))
    .slice(0, 8);

  ac.items = matches.map((n) => ({ type: 'note', title: n.title }));
  // Offer to create a new note if the query is non-empty and not an exact match.
  if (ac.query.trim() && !matches.some((n) => linkKey(n.title) === linkKey(ac.query))) {
    ac.items.push({ type: 'create', title: ac.query.trim() });
  }
  if (!ac.items.length) { hideAutocomplete(); return; }

  ac.activeIndex = 0;
  renderAutocomplete();
}

function renderAutocomplete() {
  const box = $('#autocomplete');
  box.innerHTML = '';
  ac.items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'ac-item' + (i === ac.activeIndex ? ' active' : '') + (item.type === 'create' ? ' create' : '');
    el.textContent = item.type === 'create' ? `+ Create "${item.title}"` : item.title;
    el.addEventListener('mousedown', (e) => { e.preventDefault(); pickAutocomplete(i); });
    box.appendChild(el);
  });
  // Position near the cursor.
  const coords = state.cm.cursorCoords(true, 'page');
  box.style.left = `${coords.left}px`;
  box.style.top = `${coords.bottom + 4}px`;
  box.classList.remove('hidden');
  ac.open = true;
}

function hideAutocomplete() {
  if (!ac.open) return;
  $('#autocomplete').classList.add('hidden');
  ac.open = false;
}

function pickAutocomplete(i) {
  const item = ac.items[i];
  if (!item) return;
  const cm = state.cm;
  const cur = cm.getCursor();
  // Replace the partial query with "Title]]".
  cm.replaceRange(`${item.title}]]`, ac.from, cur);
  hideAutocomplete();
  cm.focus();
}

function onEditorKeydown(e) {
  if (!ac.open) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    ac.activeIndex = (ac.activeIndex + 1) % ac.items.length; renderAutocomplete();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    ac.activeIndex = (ac.activeIndex - 1 + ac.items.length) % ac.items.length; renderAutocomplete();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault(); e.stopPropagation();
    pickAutocomplete(ac.activeIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    hideAutocomplete();
  }
}

// ---------------------------------------------------------------------------
// Clicking a rendered [[wiki-link]] opens (or creates) the target note.
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const link = e.target.closest('.wikilink');
  if (!link) return;
  e.preventDefault();
  const target = link.dataset.target;
  const existing = resolveLocal(target);
  if (existing) {
    openNote(existing.slug);
  } else {
    // Create the missing note on the fly.
    await createNote(target);
  }
});

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('notetaker-theme', theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
  if (state.network && $('#tab-graph').classList.contains('active')) renderGraph();
}

// ---------------------------------------------------------------------------
// Side-panel tabs
// ---------------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll('.panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel-body').forEach((b) => b.classList.remove('active'));
      tab.classList.add('active');
      const body = $(`#tab-${tab.dataset.tab}`);
      body.classList.add('active');
      if (tab.dataset.tab === 'graph') renderGraph();
    });
  });
}

// ---------------------------------------------------------------------------
// Wire up + boot
// ---------------------------------------------------------------------------
function initControls() {
  $('#new-note-btn').addEventListener('click', () => {
    const title = prompt('New note title:');
    if (title) createNote(title);
  });
  $('#delete-btn').addEventListener('click', deleteCurrent);
  $('#theme-toggle').addEventListener('click', toggleTheme);

  // Title input: rename by rewriting the note's first H1 heading in the body.
  $('#title-input').addEventListener('change', () => {
    if (!state.currentSlug) return;
    const newTitle = $('#title-input').value.trim();
    if (!newTitle) return;
    const body = state.easymde.value();
    let updated;
    if (/^\s*#\s+.+$/m.test(body)) {
      updated = body.replace(/^\s*#\s+.+$/m, `# ${newTitle}`); // replace first H1
    } else {
      updated = `# ${newTitle}\n\n${body}`;                    // no H1 yet — add one
    }
    state.suppressChange = true;
    state.easymde.value(updated);
    state.suppressChange = false;
    setSaveStatus('Editing…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveCurrent, 300);
  });

  // Search box (debounced).
  let searchTimer;
  $('#search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderFilteredList, 200);
  });

  // Keyboard shortcut: Cmd/Ctrl+N for a new note.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      const title = prompt('New note title:');
      if (title) createNote(title);
    }
  });

  // Hide autocomplete when clicking elsewhere.
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#autocomplete')) hideAutocomplete();
  });
}

async function boot() {
  applyTheme(localStorage.getItem('notetaker-theme') || 'light');
  initEditor();
  initTabs();
  initControls();
  await refreshNotes();
  // Open the most recent note if one exists.
  if (state.notes.length) openNote(state.notes[0].slug);
}

boot();
