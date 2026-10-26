'use strict';

// Pure helpers. This file must not require('vscode') so it can be unit-tested with plain Node.

// Template for listing changes. Fields (tab separated, one change per line):
// change id, commit id, first description line, bookmarks, flags.
const CHANGE_TEMPLATE =
  'change_id.shortest(8) ++ "\\t" ++ commit_id.shortest(8) ++ "\\t" ++ ' +
  'description.first_line() ++ "\\t" ++ bookmarks.join(" ") ++ "\\t" ++ ' +
  'if(current_working_copy, "@ ") ++ if(empty, "empty") ++ "\\n"';

const DEFAULT_CHANGE_REVSET = 'ancestors(visible_heads(), 50) ~ root()';

const PLACEHOLDER = /\$\{(revision|input)\}/g;

/**
 * Split a command line into arguments. Supports single and double quotes.
 * Backslashes are literal, except for \" and \\ inside double quotes.
 */
function splitArgs(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        cur += input[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) {
    throw new Error('Unterminated ' + (quote === '"' ? 'double' : 'single') + ' quote');
  }
  if (started) {
    out.push(cur);
  }
  return out;
}

/** Accepts a string or an array of strings. Strips a leading "jj". Throws on empty or invalid input. */
function normalizeArgs(value) {
  let args;
  if (Array.isArray(value)) {
    args = value.map((v) => String(v));
  } else if (typeof value === 'string') {
    args = splitArgs(value);
  } else {
    throw new Error('args must be a string or an array of strings');
  }
  if (args.length > 0 && args[0] === 'jj') {
    args = args.slice(1);
  }
  if (args.length === 0) {
    throw new Error('args is empty');
  }
  return args;
}

/** Names of ${...} placeholders used in args. */
function findPlaceholders(args) {
  const found = new Set();
  for (const arg of args) {
    for (const m of arg.matchAll(PLACEHOLDER)) {
      found.add(m[1]);
    }
  }
  return found;
}

function substitute(args, values) {
  return args.map((arg) =>
    arg.replace(PLACEHOLDER, (_, name) => (values[name] !== undefined ? values[name] : ''))
  );
}

/** Parse the output of `jj log -T CHANGE_TEMPLATE`. */
function parseChanges(stdout) {
  const changes = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const f = line.split('\t');
    if (!f[1]) {
      continue;
    }
    changes.push({
      change: f[0],
      commit: f[1],
      description: f[2] || '',
      bookmarks: f[3] || '',
      flags: (f[4] || '').trim(),
    });
  }
  return changes;
}

/** Decide how to show command output: short text as a notification, long text in a document. */
function summarizeOutput(text, maxLines, maxChars) {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed === '') {
    return { kind: 'empty', text: '' };
  }
  const lines = trimmed.split('\n').length;
  if (lines > maxLines || trimmed.length > maxChars) {
    return { kind: 'long', text: trimmed };
  }
  return { kind: 'short', text: trimmed };
}

function firstLines(text, count, maxChars) {
  const t = text.trim().split('\n').slice(0, count).join('\n');
  return t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t;
}

function displayArgs(args) {
  return Array.isArray(args) ? args.join(' ') : String(args);
}

// ---------------------------------------------------------------------------
// Shell quoting for task arguments
//
// VS Code wraps a plain task argument that contains a space in quotes WITHOUT escaping quotes that are
// already inside it, so an argument such as  jj bookmark set -r 'latest(::@)'  reaches the shell broken.
// An argument that already starts and ends with the shell's quote character is passed through unchanged,
// so arguments are quoted here, for the shell that runs the task.
// ---------------------------------------------------------------------------

/** "posix" (bash, zsh, sh, dash, fish, ...), "powershell" or "cmd", from the path of the shell. */
function shellFamily(shellPath) {
  const base = String(shellPath || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') {
    return 'powershell';
  }
  if (base === 'cmd') {
    return 'cmd';
  }
  return 'posix';
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument so the given shell passes it to the program unchanged. */
function quoteShellArg(arg, family) {
  const s = String(arg);
  if (SAFE_ARG.test(s)) {
    return s;
  }
  if (family === 'powershell') {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  if (family === 'cmd') {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Generated Command Palette entries for custom commands
// ---------------------------------------------------------------------------

const PALETTE_PREFIX = 'jjPalette.run.';

function slugify(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'cmd' : s;
}

function shortHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Stable command ids for custom command names. The result must not depend on the order of the names,
 * because ids are written to the manifest and looked up again later.
 * Returns a Map from name to id. Names whose slugs collide get a hash suffix.
 */
function commandIds(names) {
  const unique = Array.from(new Set(names));
  const bySlug = new Map();
  for (const n of unique) {
    const s = slugify(n);
    bySlug.set(s, (bySlug.get(s) || []).concat(n));
  }
  const ids = new Map();
  for (const [slug, group] of bySlug) {
    for (const n of group) {
      ids.set(n, PALETTE_PREFIX + (group.length === 1 ? slug : slug + '-' + shortHash(n)));
    }
  }
  return ids;
}

/** The command contributions wanted in the manifest for these custom command names. */
function paletteCommands(names) {
  return Array.from(commandIds(names), ([name, id]) => ({ command: id, title: 'jj ' + name }));
}

function isGenerated(entry) {
  return entry && typeof entry.command === 'string' && entry.command.startsWith(PALETTE_PREFIX);
}

/** Ids of generated palette commands currently present in a manifest. */
function generatedIds(manifest) {
  const cmds = (manifest && manifest.contributes && manifest.contributes.commands) || [];
  return cmds.filter(isGenerated).map((c) => c.command);
}

/**
 * Replace the generated command contributions in a manifest.
 * Returns { changed, manifest }. The input is not modified.
 */
function applyPaletteCommands(manifest, desired) {
  const existing = (manifest.contributes && manifest.contributes.commands) || [];
  const current = existing.filter(isGenerated);
  if (JSON.stringify(current) === JSON.stringify(desired)) {
    return { changed: false, manifest };
  }
  const next = JSON.parse(JSON.stringify(manifest));
  next.contributes = next.contributes || {};
  next.contributes.commands = existing.filter((c) => !isGenerated(c)).concat(desired);
  return { changed: true, manifest: next };
}

// ---------------------------------------------------------------------------
// Split diff helpers
// ---------------------------------------------------------------------------

/**
 * Parse `jj diff --summary`. Lines look like "M path", "A path", "D path", "R {old => new}",
 * "R dir/{a => b}/file". Returns [{ status, path, oldPath? }] where path is the path in the
 * working copy (for deleted files: the path that was deleted) and oldPath is the source of a
 * rename or copy.
 */
function parseSummary(stdout) {
  const entries = [];
  for (const line of stdout.split('\n')) {
    const m = /^([MADRC]) (.+)$/.exec(line);
    if (!m) {
      continue;
    }
    const status = m[1];
    const rest = m[2];
    if (status === 'R' || status === 'C') {
      const clean = (p) => p.replace(/\/{2,}/g, '/');
      const b = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(rest);
      if (b) {
        entries.push({ status, oldPath: clean(b[1] + b[2] + b[4]), path: clean(b[1] + b[3] + b[4]) });
      } else {
        const i = rest.indexOf(' => ');
        entries.push(
          i < 0 ? { status, path: rest } : { status, oldPath: rest.slice(0, i), path: rest.slice(i + 4) }
        );
      }
    } else {
      entries.push({ status, path: rest });
    }
  }
  return entries;
}

/** A fileset expression that names exactly this workspace-root-relative file. */
function rootFileset(filePath) {
  return 'root-file:"' + String(filePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Label for a changed file in the picker. */
function describeEntry(entry) {
  if (entry.oldPath && entry.oldPath !== entry.path) {
    return entry.status + ' ' + entry.oldPath + ' → ' + entry.path;
  }
  return entry.status + ' ' + entry.path;
}

module.exports = {
  parseSummary,
  rootFileset,
  describeEntry,
  shellFamily,
  quoteShellArg,
  PALETTE_PREFIX,
  commandIds,
  paletteCommands,
  generatedIds,
  applyPaletteCommands,
  CHANGE_TEMPLATE,
  DEFAULT_CHANGE_REVSET,
  splitArgs,
  normalizeArgs,
  findPlaceholders,
  substitute,
  parseChanges,
  summarizeOutput,
  firstLines,
  displayArgs,
};
