/**
 * NoteTaker — a lightweight local Markdown notes server.
 *
 * Serves the static frontend from ./public and exposes a small REST API over a
 * folder of plain .md files (see config.js for the folder location).
 *
 * It keeps an in-memory index of every note (title, tags, and outgoing
 * [[wiki-links]]) so search, backlinks and the graph view are instant. The
 * index is rebuilt automatically whenever files change on disk (chokidar),
 * so editing a .md file in another editor is reflected here too.
 */
const express = require('express');
const chokidar = require('chokidar');
const matter = require('gray-matter');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { NOTES_DIR, PORT } = require('./config');

// ---------------------------------------------------------------------------
// Note identity helpers
// ---------------------------------------------------------------------------
// A note's "slug" is its filename without the .md extension. Wiki-links refer to
// notes by title; we normalise both so that "My Note", "my-note" and "my note"
// all resolve to the same file.

function slugify(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // drop punctuation
    .replace(/\s+/g, '-')          // spaces -> hyphens
    .replace(/-+/g, '-')           // collapse repeats
    .replace(/^-|-$/g, '');        // trim stray hyphens
}

// Normalise any title/slug into a comparison key for link resolution.
// Lowercase, turn every run of punctuation/whitespace into a single space, and
// trim — so "Module 1 — Foo & Bar" and "module-1-foo-bar" compare equal.
function linkKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugToFile(slug) {
  return path.join(NOTES_DIR, `${slug}.md`);
}

// A human-friendly default title from a slug (used if no # heading is present).
function titleFromSlug(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Parsing: extract title, tags and wiki-links from a note's contents
// ---------------------------------------------------------------------------
const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;
// Inline #tags: a # preceded by start/space, followed by a word. Avoids matching
// Markdown headings (which are "# " with a space) by requiring a non-space char.
const TAG_RE = /(?:^|\s)#([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;

function parseNote(slug, raw) {
  let data = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data || {};
    body = parsed.content;
  } catch {
    // If frontmatter is malformed, just treat the whole file as body.
    body = raw;
  }

  // Title: first "# heading", else frontmatter title, else prettified slug.
  let title;
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) title = h1[1].trim();
  else if (data.title) title = String(data.title).trim();
  else title = titleFromSlug(slug);

  // Tags: from frontmatter (array or comma string) + inline #tags in body.
  const tags = new Set();
  if (Array.isArray(data.tags)) data.tags.forEach((t) => tags.add(String(t).trim()));
  else if (typeof data.tags === 'string') {
    data.tags.split(',').forEach((t) => t.trim() && tags.add(t.trim()));
  }
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body))) tags.add(m[1]);

  // Outgoing wiki-links stored as their RAW target text. We resolve them to
  // notes at query time (see resolveLink) so links match by title even when a
  // title contains punctuation like & or — that slugifying would drop.
  const outLinks = new Set();
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body))) {
    // Support "[[Target|Alias]]" — link target is the part before the pipe.
    const target = m[1].split('|')[0].trim();
    if (target) outLinks.add(target);
  }

  return {
    slug,
    title,
    tags: [...tags],
    outLinks: [...outLinks],
    body,          // markdown without frontmatter (used for search)
    raw,           // full file contents (returned to editor)
  };
}

// ---------------------------------------------------------------------------
// In-memory index
// ---------------------------------------------------------------------------
// Map<slug, { slug, title, tags[], outLinks[], body, raw, mtime }>
const index = new Map();

async function indexFile(slug) {
  try {
    const file = slugToFile(slug);
    const [raw, stat] = await Promise.all([
      fsp.readFile(file, 'utf8'),
      fsp.stat(file),
    ]);
    const note = parseNote(slug, raw);
    note.mtime = stat.mtimeMs;
    index.set(slug, note);
  } catch {
    index.delete(slug);
  }
}

async function buildIndex() {
  index.clear();
  const entries = await fsp.readdir(NOTES_DIR).catch(() => []);
  const slugs = entries
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => f.slice(0, -3));
  await Promise.all(slugs.map(indexFile));
  console.log(`Indexed ${index.size} note(s) from ${NOTES_DIR}`);
}

// Find a note by a wiki-link target (title or slug), case/format insensitive.
function resolveLink(target) {
  const wantSlug = slugify(target);
  if (index.has(wantSlug)) return index.get(wantSlug);
  const wantKey = linkKey(target);
  for (const note of index.values()) {
    if (linkKey(note.title) === wantKey) return note;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Reject slugs that could escape the notes directory.
function safeSlug(name) {
  const slug = slugify(name);
  if (!slug || slug.includes('/') || slug.includes('..')) return null;
  return slug;
}

// GET all notes (metadata only, sorted by most-recently-modified)
app.get('/api/notes', (req, res) => {
  const notes = [...index.values()]
    .map((n) => ({ slug: n.slug, title: n.title, tags: n.tags, mtime: n.mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(notes);
});

// GET all distinct tags with counts
app.get('/api/tags', (req, res) => {
  const counts = new Map();
  for (const n of index.values()) {
    for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  res.json(tags);
});

// GET one note (raw markdown + metadata). exists:false if not yet created.
app.get('/api/notes/:name', (req, res) => {
  const slug = safeSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'invalid name' });
  const note = index.get(slug);
  if (!note) {
    return res.json({
      slug,
      title: titleFromSlug(slug),
      content: '',
      tags: [],
      exists: false,
    });
  }
  res.json({
    slug: note.slug,
    title: note.title,
    content: note.raw,
    tags: note.tags,
    mtime: note.mtime,
    exists: true,
  });
});

// PUT (create/update) a note
app.put('/api/notes/:name', async (req, res) => {
  const slug = safeSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'invalid name' });
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  try {
    await fsp.mkdir(NOTES_DIR, { recursive: true });
    await fsp.writeFile(slugToFile(slug), content, 'utf8');
    await indexFile(slug); // keep index fresh immediately (don't wait for watcher)
    const note = index.get(slug);
    res.json({
      slug,
      title: note?.title || titleFromSlug(slug),
      tags: note?.tags || [],
      mtime: note?.mtime,
      exists: true,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE a note
app.delete('/api/notes/:name', async (req, res) => {
  const slug = safeSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'invalid name' });
  try {
    await fsp.unlink(slugToFile(slug)).catch(() => {});
    index.delete(slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET search across titles, tags and body text. Also supports "#tag" queries.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const tag = String(req.query.tag || '').trim().toLowerCase();

  let notes = [...index.values()];

  if (tag) {
    notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag));
  }

  if (q) {
    // A "#foo" query is treated as a tag filter.
    if (q.startsWith('#')) {
      const t = q.slice(1);
      notes = notes.filter((n) => n.tags.some((x) => x.toLowerCase().includes(t)));
    } else {
      notes = notes
        .map((n) => {
          const inTitle = n.title.toLowerCase().includes(q);
          const inTags = n.tags.some((t) => t.toLowerCase().includes(q));
          const bodyLower = n.body.toLowerCase();
          const bodyIdx = bodyLower.indexOf(q);
          if (!inTitle && !inTags && bodyIdx === -1) return null;
          // Build a small snippet around the first body match.
          let snippet = '';
          if (bodyIdx !== -1) {
            const start = Math.max(0, bodyIdx - 40);
            snippet = (start > 0 ? '…' : '') +
              n.body.slice(start, bodyIdx + q.length + 40).replace(/\s+/g, ' ').trim() + '…';
          }
          const score = (inTitle ? 3 : 0) + (inTags ? 2 : 0) + (bodyIdx !== -1 ? 1 : 0);
          return { note: n, score, snippet };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .map((r) => ({ ...toMeta(r.note), snippet: r.snippet }));
      return res.json(notes);
    }
  }

  res.json(notes.sort((a, b) => b.mtime - a.mtime).map(toMeta));
});

function toMeta(n) {
  return { slug: n.slug, title: n.title, tags: n.tags, mtime: n.mtime };
}

// GET backlinks: notes whose outgoing links resolve to this note.
app.get('/api/backlinks/:name', (req, res) => {
  const slug = safeSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'invalid name' });

  const backlinks = [];
  for (const n of index.values()) {
    if (n.slug === slug) continue;
    // A note links to us if any of its wiki-link targets resolves to this slug.
    const hit = n.outLinks.some((l) => {
      const r = resolveLink(l);
      return r ? r.slug === slug : slugify(l) === slug;
    });
    if (hit) backlinks.push(toMeta(n));
  }
  res.json(backlinks.sort((a, b) => b.mtime - a.mtime));
});

// GET graph: nodes for every note + edges for resolvable wiki-links.
app.get('/api/graph', (req, res) => {
  const nodes = [];
  const edges = [];
  for (const n of index.values()) {
    nodes.push({ id: n.slug, label: n.title, tags: n.tags });
  }
  const known = new Set(index.keys());
  for (const n of index.values()) {
    for (const l of n.outLinks) {
      const target = resolveLink(l);
      const toId = target ? target.slug : l;
      if (known.has(toId) && toId !== n.slug) {
        edges.push({ from: n.slug, to: toId });
      }
    }
  }
  res.json({ nodes, edges });
});

// Resolve a wiki-link target to a note slug (used by the frontend on click).
app.get('/api/resolve', (req, res) => {
  const target = String(req.query.target || '');
  const note = resolveLink(target);
  if (note) res.json({ exists: true, slug: note.slug, title: note.title });
  else res.json({ exists: false, slug: slugify(target), title: titleFromSlug(slugify(target)) });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  await buildIndex();

  // Watch for external changes and keep the index in sync.
  chokidar
    .watch(NOTES_DIR, { ignoreInitial: true, depth: 0 })
    .on('add', (f) => f.endsWith('.md') && indexFile(path.basename(f, '.md')))
    .on('change', (f) => f.endsWith('.md') && indexFile(path.basename(f, '.md')))
    .on('unlink', (f) => f.endsWith('.md') && index.delete(path.basename(f, '.md')));

  app.listen(PORT, () => {
    console.log(`\n  NoteTaker running →  http://localhost:${PORT}`);
    console.log(`  Notes folder: ${NOTES_DIR}\n`);
  });
}

start();
