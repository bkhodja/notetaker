/**
 * NoteTaker configuration.
 *
 * Change NOTES_DIR to point at any folder you like — for example your own
 * "~/Notes" folder. It will be created automatically on first run if missing.
 * Notes are stored as plain .md files inside it, so they stay portable and can
 * be opened in any editor (or even Obsidian) later.
 */
const path = require('path');
const os = require('os');

// Allow overriding via an environment variable, otherwise default to ./notes
// next to the app. Use "~" for your home directory, e.g. "~/Notes".
function resolveDir(dir) {
  if (dir.startsWith('~')) {
    return path.join(os.homedir(), dir.slice(1));
  }
  return path.resolve(__dirname, dir);
}

module.exports = {
  // Where your notes live. Set NOTES_DIR env var to override.
  NOTES_DIR: resolveDir(process.env.NOTES_DIR || './notes'),

  // Port the local web app is served on.
  PORT: Number(process.env.PORT) || 3000,
};
