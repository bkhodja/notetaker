# NoteTaker

A lightweight, local Markdown notes app — like a much simpler Obsidian. Your notes
are plain `.md` files on disk, so they stay portable and future-proof.

## Features

- **Live Markdown preview** — headings, bold/italic, lists, code blocks, tables, quotes.
- **`[[Wiki-links]]`** — type `[[` to link notes, with autocomplete. Click a link to
  jump to it; linking to a note that doesn't exist yet creates it.
- **Search & `#tags`** — full-text search plus tag chips to filter by topic. Search
  `#exam` to filter by a tag directly.
- **Backlinks & Graph** — see which notes link to the current one, and a visual graph
  of how everything connects.
- **Dark mode** — toggle with the 🌙 / ☀️ button.
- **Autosave** — edits save automatically as you type.

## Running it

```bash
cd /Users/khodjayevb/NoteTaker
npm install       # first time only
npm start         # or: node server.js
```

Then open **http://localhost:3000** in your browser.

## Where your notes live

By default, notes are stored as `.md` files in the `notes/` folder inside this project.

To use a different folder (for example `~/Notes`), edit `config.js` or start with an
environment variable:

```bash
NOTES_DIR="~/Notes" npm start
```

You can also change the port:

```bash
PORT=4000 npm start
```

## Tips

- Press **Cmd/Ctrl + N** to create a new note.
- Rename a note by editing the title at the top — it updates the note's `# heading`.
- Because notes are just Markdown files, you can edit them in any editor; NoteTaker
  picks up external changes automatically.
