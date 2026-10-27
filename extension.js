'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

let log;
let reloadPromptOpen = false;
const registeredIds = new Set();

const BUILTIN = {
  describe: { name: 'describe', args: ['describe'], mode: 'editor' },
  commit: { name: 'commit', args: ['commit'], mode: 'editor' },
};

function cfg() {
  return vscode.workspace.getConfiguration('jjPalette');
}

// ---------------------------------------------------------------------------
// Repository selection
// ---------------------------------------------------------------------------

async function pickFolder() {
  const active = vscode.window.activeTextEditor;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (folder) {
      return folder;
    }
  }
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage('jj: no workspace folder is open.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the repository to run jj in' });
}

// ---------------------------------------------------------------------------
// Running jj
// ---------------------------------------------------------------------------

/** Run jj and capture its output. Never rejects. */
function execJj(folder, args) {
  const c = cfg();
  const jjPath = c.get('jjPath') || 'jj';
  const timeoutMs = Math.max(1, Number(c.get('timeoutSeconds')) || 60) * 1000;
  log.appendLine('$ ' + jjPath + ' ' + args.join(' ') + '   (cwd: ' + folder.uri.fsPath + ')');
  return new Promise((resolve) => {
    const child = cp.execFile(
      jjPath,
      args,
      { cwd: folder.uri.fsPath, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let code = 0;
        let message = stderr;
        if (err) {
          if (err.code === 'ENOENT') {
            code = -1;
            message = "Cannot run '" + jjPath + "'. Install jj or set jjPalette.jjPath.";
          } else if (err.killed) {
            code = -1;
            message = 'Timed out after ' + timeoutMs / 1000 + ' s (jjPalette.timeoutSeconds). ' + stderr;
          } else {
            code = typeof err.code === 'number' ? err.code : 1;
          }
        }
        log.appendLine('  exit ' + code + (message ? '\n' + message.trimEnd() : ''));
        resolve({ code, stdout, stderr: message });
      }
    );
    if (child.stdin) {
      child.stdin.end();
    }
  });
}

/** Run jj as a VS Code task, so interactive editors and terminal programs work. */
async function runTask(folder, label, args, { withEditor, visible }) {
  const c = cfg();
  const jjPath = c.get('jjPath') || 'jj';
  // Tasks write to a terminal that closes or stays open on its own; a pager would wait for 'q'.
  // JJ_PAGER is inherited by jj processes started from custom commands (e.g. via `jj util exec`).
  const env = { JJ_PAGER: 'cat' };
  const editor = c.get('editor');
  if (withEditor && editor) {
    env.JJ_EDITOR = editor;
  }
  // Quote for the shell that runs the task; see lib.quoteShellArg.
  const family = lib.shellFamily(vscode.env.shell);
  const quotedArgs = args.map((a) => lib.quoteShellArg(a, family));
  log.appendLine(
    'task: ' + jjPath + ' ' + quotedArgs.join(' ') + '   (shell: ' + (vscode.env.shell || 'default') + ')' +
      (env.JJ_EDITOR ? '   (JJ_EDITOR=' + env.JJ_EDITOR + ')' : '')
  );

  const task = new vscode.Task(
    { type: 'shell', jjPalette: label },
    folder,
    'jj ' + label,
    'jj-palette',
    new vscode.ShellExecution(jjPath, quotedArgs, { cwd: folder.uri.fsPath, env }),
    []
  );
  task.presentationOptions = visible
    ? {
        reveal: vscode.TaskRevealKind.Always,
        focus: true,
        echo: true,
        clear: false,
        close: false,
        showReuseMessage: true,
        panel: vscode.TaskPanelKind.Dedicated,
      }
    : {
        reveal: vscode.TaskRevealKind.Silent,
        focus: false,
        echo: false,
        clear: false,
        close: true,
        showReuseMessage: false,
        panel: vscode.TaskPanelKind.Dedicated,
      };

  const listener = vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution.task.source === 'jj-palette' && e.execution.task.name === task.name) {
      listener.dispose();
      if (e.exitCode !== undefined && e.exitCode !== 0) {
        vscode.window.showWarningMessage('jj ' + label + ' exited with code ' + e.exitCode + '.');
      }
      refreshJjx();
    }
  });
  try {
    await vscode.tasks.executeTask(task);
  } catch (err) {
    listener.dispose();
    vscode.window.showErrorMessage('jj ' + label + ' failed to start: ' + err);
  }
}

/** Ask the Jujutsu X extension (if installed) to refresh its graph. */
async function refreshJjx() {
  if (!cfg().get('refreshJjx')) {
    return;
  }
  try {
    const available = await vscode.commands.getCommands(true);
    for (const id of ['jj.refreshGraphWebview', 'jj.refresh']) {
      if (available.includes(id)) {
        await vscode.commands.executeCommand(id);
      }
    }
  } catch (err) {
    log.appendLine('refresh of Jujutsu X failed: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Presenting results
// ---------------------------------------------------------------------------

async function showDocument(content, language) {
  const doc = await vscode.workspace.openTextDocument({ content, language: language || 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** mode: "auto" (short output as notification, long output in a tab) or "document". */
async function present(title, res, mode, language) {
  if (res.code !== 0) {
    const detail = lib.firstLines(res.stderr || res.stdout, 6, 500);
    vscode.window.showErrorMessage('jj ' + title + ' failed (exit ' + res.code + ')' + (detail ? ':\n' + detail : ''));
    return false;
  }
  const combined = [res.stdout, res.stderr].filter((s) => s && s.trim() !== '').join('\n');
  if (mode === 'document') {
    if (combined === '') {
      vscode.window.showInformationMessage('jj ' + title + ': no output.');
    } else {
      await showDocument(res.stdout.trim() !== '' ? res.stdout : res.stderr, language);
    }
    return true;
  }
  const summary = lib.summarizeOutput(combined, 8, 600);
  if (summary.kind === 'empty') {
    vscode.window.showInformationMessage('jj ' + title + ': done.');
  } else if (summary.kind === 'short') {
    vscode.window.showInformationMessage('jj ' + title + ': ' + summary.text);
  } else {
    await showDocument(summary.text, language);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Picking a change
// ---------------------------------------------------------------------------

/** Returns a revision string, or undefined if the user cancelled. */
async function pickChange(folder, placeHolder) {
  const revset = cfg().get('changeRevset') || lib.DEFAULT_CHANGE_REVSET;
  const res = await execJj(folder, ['log', '--no-graph', '-r', revset, '-T', lib.CHANGE_TEMPLATE]);
  const changes = res.code === 0 ? lib.parseChanges(res.stdout) : [];

  if (changes.length === 0) {
    const reason =
      res.code !== 0 ? lib.firstLines(res.stderr, 1, 200) : 'jjPalette.changeRevset matched no changes';
    const typed = await vscode.window.showInputBox({
      prompt: 'Could not list changes (' + reason + '). Enter a revision or revset:',
      ignoreFocusOut: true,
    });
    return typed && typed.trim() !== '' ? typed.trim() : undefined;
  }

  const items = changes.map((ch) => ({
    label: ch.change + '  ' + (ch.description || '(no description)'),
    description: [ch.flags, ch.bookmarks].filter(Boolean).join('  '),
    revision: ch.commit,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeHolder || 'Select a change',
    matchOnDescription: true,
  });
  return picked ? picked.revision : undefined;
}

// ---------------------------------------------------------------------------
// Custom commands
// ---------------------------------------------------------------------------

function isValidSpec(s) {
  return (
    s &&
    typeof s === 'object' &&
    typeof s.name === 'string' &&
    s.name.trim() !== '' &&
    (typeof s.args === 'string' || Array.isArray(s.args))
  );
}

/** Custom commands from user, workspace and folder settings. Later scopes override earlier ones by name. */
function getCustomSpecs() {
  const inspected = cfg().inspect('customCommands') || {};
  const layers = [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue];
  const byName = new Map();
  for (const layer of layers) {
    if (!Array.isArray(layer)) {
      continue;
    }
    for (const s of layer) {
      if (isValidSpec(s)) {
        byName.set(s.name, s);
      } else {
        log.appendLine('ignored invalid entry in jjPalette.customCommands: ' + JSON.stringify(s));
      }
    }
  }
  return Array.from(byName.values());
}

async function runSpec(folder, spec) {
  let args;
  try {
    args = lib.normalizeArgs(spec.args);
  } catch (err) {
    vscode.window.showErrorMessage("jj '" + spec.name + "': " + err.message);
    return;
  }

  const needed = lib.findPlaceholders(args);
  const values = {};
  if (needed.has('revision')) {
    values.revision = await pickChange(folder, 'jj ' + spec.name + ': select a change');
    if (values.revision === undefined) {
      return;
    }
  }
  if (needed.has('input')) {
    values.input = await vscode.window.showInputBox({
      prompt: 'jj ' + spec.name + ': value for ${input}',
      ignoreFocusOut: true,
    });
    if (values.input === undefined) {
      return;
    }
  }
  args = lib.substitute(args, values);

  const mode = spec.mode || 'auto';
  if (mode === 'editor') {
    await runTask(folder, spec.name, args, { withEditor: true, visible: false });
  } else if (mode === 'terminal') {
    await runTask(folder, spec.name, args, { withEditor: false, visible: true });
  } else {
    const res = await execJj(folder, args);
    const ok = await present(spec.name, res, mode, spec.language);
    if (ok) {
      refreshJjx();
    }
  }
}

// ---------------------------------------------------------------------------
// Palette commands
// ---------------------------------------------------------------------------

async function cmdBuiltin(key) {
  const folder = await pickFolder();
  if (folder) {
    await runSpec(folder, BUILTIN[key]);
  }
}

// ---------------------------------------------------------------------------
// jj diff in VS Code's split diff editor
//
// Left side: the file as it is in the parent change (@-), served by a virtual document provider
// that runs `jj file show`. Right side: the real file in the working copy, which stays editable.
// ---------------------------------------------------------------------------

const BASE_SCHEME = 'jj-palette-base';

function baseUri(root, rev, relPath) {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + relPath, query: JSON.stringify({ root, rev }) });
}

function emptyUri(relPath) {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + relPath, query: JSON.stringify({ empty: true }) });
}

const baseContentProvider = {
  async provideTextDocumentContent(uri) {
    let q;
    try {
      q = JSON.parse(uri.query);
    } catch (err) {
      return '';
    }
    if (q.empty) {
      return '';
    }
    const relPath = uri.path.replace(/^\//, ''); // uri.path is already decoded
    const res = await execJj({ uri: vscode.Uri.file(q.root) }, ['file', 'show', '-r', q.rev, lib.rootFileset(relPath)]);
    if (res.code !== 0) {
      return '(could not read ' + relPath + ' at ' + q.rev + ')\n' + res.stderr;
    }
    return res.stdout.includes('\u0000') ? '(binary file)' : res.stdout;
  },
};

function fileDiffUris(root, baseRev, entry) {
  const left = entry.status === 'A' ? emptyUri(entry.path) : baseUri(root, baseRev, entry.oldPath || entry.path);
  const right = entry.status === 'D' ? emptyUri(entry.path) : vscode.Uri.file(path.join(root, entry.path));
  return { left, right };
}

function diffTitle(entry) {
  const name = entry.oldPath && entry.oldPath !== entry.path ? entry.oldPath + ' → ' + entry.path : entry.path;
  return name + ' (parent ↔ working copy)';
}

/**
 * Open the working-copy change in VS Code's diff editor.
 * Returns false if the text diff should be used instead (the change has several parents).
 */
async function openSplitDiff(folder) {
  const rootRes = await execJj(folder, ['workspace', 'root']);
  if (rootRes.code !== 0) {
    await present('diff', rootRes, 'document');
    return true;
  }
  const root = rootRes.stdout.trim();
  const rootFolder = { uri: vscode.Uri.file(root) };

  const sumRes = await execJj(rootFolder, ['diff', '--summary']);
  if (sumRes.code !== 0) {
    await present('diff', sumRes, 'document');
    return true;
  }
  const entries = lib.parseSummary(sumRes.stdout);
  if (entries.length === 0) {
    vscode.window.showInformationMessage('jj diff: the working-copy change has no modifications.');
    return true;
  }

  const parentRes = await execJj(rootFolder, ['log', '--no-graph', '-r', '@-', '-T', 'commit_id ++ "\\n"']);
  const parents = parentRes.code === 0 ? parentRes.stdout.split('\n').filter((l) => l.trim() !== '') : [];
  if (parents.length !== 1) {
    log.appendLine('diff: the working-copy change has ' + parents.length + ' parents; using the text diff');
    return false;
  }
  const baseRev = parents[0].trim();

  const openOne = (entry) => {
    const { left, right } = fileDiffUris(root, baseRev, entry);
    return vscode.commands.executeCommand('vscode.diff', left, right, diffTitle(entry), { preview: true });
  };

  if (entries.length === 1) {
    await openOne(entries[0]);
    return true;
  }

  const ALL = { label: '$(files) All changes (' + entries.length + ' files)', alwaysShow: true, all: true };
  const items = [ALL, ...entries.map((e) => ({ label: lib.describeEntry(e), entry: e }))];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'jj diff: select a file to compare with its parent',
  });
  if (!picked) {
    return true;
  }
  if (picked.all) {
    const resources = entries.map((e) => {
      const { left, right } = fileDiffUris(root, baseRev, e);
      return [e.status === 'D' ? left : right, left, right];
    });
    try {
      await vscode.commands.executeCommand('vscode.changes', 'jj diff: working copy vs parent', resources);
    } catch (err) {
      vscode.window.showErrorMessage('jj diff: the multi-file diff editor could not be opened (' + err + ').');
    }
    return true;
  }
  await openOne(picked.entry);
  return true;
}

async function cmdDiff() {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  if ((cfg().get('diffMode') || 'split') === 'split' && (await openSplitDiff(folder))) {
    return;
  }
  const extra = cfg().get('diffArgs');
  const args = ['diff', ...(Array.isArray(extra) ? extra.map(String) : ['--git'])];
  const res = await execJj(folder, args);
  if (res.code !== 0) {
    await present('diff', res, 'document');
    return;
  }
  if (res.stdout.trim() === '') {
    vscode.window.showInformationMessage('jj diff: the working-copy change has no modifications.');
    return;
  }
  await showDocument(res.stdout, args.includes('--git') ? 'diff' : 'plaintext');
}

async function cmdEdit() {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const revision = await pickChange(folder, 'jj edit: select the change to edit');
  if (revision === undefined) {
    return;
  }
  const res = await execJj(folder, ['edit', revision]);
  if (await present('edit', res, 'auto')) {
    refreshJjx();
  }
}

async function cmdCustom(nameArg) {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const specs = getCustomSpecs();

  if (typeof nameArg === 'string') {
    const spec = specs.find((s) => s.name === nameArg);
    if (!spec) {
      vscode.window.showErrorMessage("jj: no custom command named '" + nameArg + "' in jjPalette.customCommands.");
      return;
    }
    await runSpec(folder, spec);
    return;
  }

  const items = [
    ...specs.map((s) => ({
      label: s.name,
      description: 'jj ' + lib.displayArgs(s.args),
      detail: s.mode || 'auto',
      spec: s,
    })),
    { label: '$(terminal) Run with arguments...', description: 'one-off jj command', alwaysShow: true, action: 'adhoc' },
    { label: '$(add) Add custom command...', description: 'save a command for reuse', alwaysShow: true, action: 'add' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: specs.length === 0 ? 'No custom commands yet' : 'Select a custom jj command',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (picked.action === 'add') {
    await cmdAddCustom();
    return;
  }
  if (picked.action === 'adhoc') {
    const text = await vscode.window.showInputBox({
      prompt: 'Arguments for jj (without the leading "jj")',
      placeHolder: 'log -r @- --limit 5',
      ignoreFocusOut: true,
    });
    if (text === undefined || text.trim() === '') {
      return;
    }
    await runSpec(folder, { name: text.trim(), args: text, mode: cfg().get('adhocMode') || 'auto' });
    return;
  }
  await runSpec(folder, picked.spec);
}

async function cmdAddCustom() {
  const existing = getCustomSpecs().map((s) => s.name);

  const name = await vscode.window.showInputBox({
    prompt: 'Name of the custom command (shown in the picker)',
    placeHolder: 'log recent',
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim() === '' ? 'Enter a name' : existing.includes(v.trim()) ? 'A command with this name exists' : undefined,
  });
  if (name === undefined) {
    return;
  }

  const argsText = await vscode.window.showInputBox({
    prompt: 'Arguments for jj. Use ${revision} to pick a change, ${input} to type a value.',
    placeHolder: 'log -r ${revision} --limit 5',
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        lib.normalizeArgs(v);
        return undefined;
      } catch (err) {
        return err.message;
      }
    },
  });
  if (argsText === undefined) {
    return;
  }

  const modePick = await vscode.window.showQuickPick(
    [
      { label: 'auto', description: 'background; short output as notification, long output in a tab' },
      { label: 'document', description: 'background; output always opens in a tab' },
      { label: 'editor', description: 'jj opens its message editor as a VS Code tab (like describe / commit)' },
      { label: 'terminal', description: 'run visibly in the terminal panel (interactive commands)' },
    ],
    { placeHolder: 'How should the command run?', ignoreFocusOut: true }
  );
  if (!modePick) {
    return;
  }

  const spec = { name: name.trim(), args: argsText.trim(), mode: modePick.label };
  const inspected = cfg().inspect('customCommands') || {};
  const current = Array.isArray(inspected.globalValue) ? inspected.globalValue : [];
  // The change listener in activate() registers the new command and offers the window reload
  // that makes its Command Palette entry appear.
  await cfg().update('customCommands', [...current, spec], vscode.ConfigurationTarget.Global);
}

// ---------------------------------------------------------------------------
// Direct Command Palette entries for custom commands
//
// VS Code reads Command Palette titles from the extension manifest only. To give each custom command
// its own palette entry, the commands from the user-level setting are written into this extension's
// installed package.json. They show up after the next window reload. Workspace-level custom commands
// are not written, so the palette does not change between workspaces; they stay available through
// 'jj custom...'.
// ---------------------------------------------------------------------------

function globalSpecs() {
  const inspected = cfg().inspect('customCommands') || {};
  return Array.isArray(inspected.globalValue) ? inspected.globalValue.filter(isValidSpec) : [];
}

function nameForPaletteId(id) {
  for (const [name, mapped] of lib.commandIds(globalSpecs().map((s) => s.name))) {
    if (mapped === id) {
      return name;
    }
  }
  return undefined;
}

async function runPaletteEntry(id) {
  const name = nameForPaletteId(id);
  if (name === undefined) {
    vscode.window.showErrorMessage(
      "jj: this custom command is no longer in the user setting 'jjPalette.customCommands'. Reload the window to remove it from the Command Palette."
    );
    return;
  }
  await cmdCustom(name);
}

function registerPaletteHandlers(context, extraIds) {
  const ids = new Set([...lib.commandIds(globalSpecs().map((s) => s.name)).values(), ...(extraIds || [])]);
  for (const id of ids) {
    if (!registeredIds.has(id)) {
      registeredIds.add(id);
      context.subscriptions.push(vscode.commands.registerCommand(id, () => runPaletteEntry(id)));
    }
  }
}

/** Write the palette entries into the installed manifest. Returns true if the manifest changed. */
function syncPaletteManifest(context) {
  const file = path.join(context.extensionPath, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.appendLine('cannot read ' + file + ': ' + err);
    return false;
  }
  const desired = lib.paletteCommands(globalSpecs().map((s) => s.name));
  const result = lib.applyPaletteCommands(manifest, desired);
  if (!result.changed) {
    return false;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(result.manifest, null, 2) + '\n');
  } catch (err) {
    log.appendLine('cannot write ' + file + ': ' + err);
    vscode.window.showWarningMessage(
      "jj: could not update the extension's Command Palette entries (" +
        (err.code || err.message) +
        "). Custom commands remain available through 'jj custom...' and keybindings."
    );
    return false;
  }
  log.appendLine('updated Command Palette entries in ' + file + ': ' + desired.map((d) => d.title).join(', '));
  promptReload();
  return true;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function shorten(value, max) {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Compare what VS Code loaded for this extension with what is on disk and in the settings registry. */
async function cmdDiagnose(context) {
  const lines = ['JJ Palette diagnostics'];
  const add = (s) => lines.push(s);

  const loaded = context.extension && context.extension.packageJSON;
  let disk;
  try {
    disk = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8'));
  } catch (err) {
    add('manifest on disk: unreadable (' + err + ')');
  }
  const settingKeys = (m) =>
    m && m.contributes && m.contributes.configuration ? Object.keys(m.contributes.configuration.properties || {}) : [];

  add('extension: ' + (context.extension ? context.extension.id : '?') + ', version loaded by VS Code: ' + (loaded ? loaded.version : '?') + ', version on disk: ' + (disk ? disk.version : '?'));
  add('extension path: ' + context.extensionPath);
  add(
    'VS Code ' + vscode.version + ' (' + vscode.env.appName + '), remote: ' + (vscode.env.remoteName || 'none') +
      ', workspace trusted: ' + vscode.workspace.isTrusted
  );
  add('settings in the manifest VS Code loaded: ' + (settingKeys(loaded).join(', ') || 'none'));
  add('settings in the manifest on disk:        ' + (settingKeys(disk).join(', ') || 'none'));
  add('palette entries in the loaded manifest: ' + (lib.generatedIds(loaded).join(', ') || 'none'));
  add('palette entries in the manifest on disk: ' + (lib.generatedIds(disk).join(', ') || 'none'));

  const c = cfg();
  for (const key of new Set([...settingKeys(loaded), ...settingKeys(disk)])) {
    const short = key.replace(/^jjPalette\./, '');
    const info = c.inspect(short);
    add(
      key + ': registered in VS Code = ' + Boolean(info && info.defaultValue !== undefined) +
        ', user value = ' + shorten(info && info.globalValue, 100) +
        ', workspace value = ' + shorten(info && info.workspaceValue, 100)
    );
  }

  const text = lines.join('\n');
  lines.forEach((l) => log.appendLine(l));
  log.show(true);
  try {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('jj diagnostics copied to the clipboard and written to the "JJ Palette" output channel.');
  } catch (err) {
    vscode.window.showInformationMessage('jj diagnostics written to the "JJ Palette" output channel.');
  }
}

function promptReload() {
  if (reloadPromptOpen) {
    return;
  }
  reloadPromptOpen = true;
  Promise.resolve(
    vscode.window.showInformationMessage(
      'Custom jj commands changed. Reload the window to update their Command Palette entries.',
      'Reload Window'
    )
  ).then((choice) => {
    reloadPromptOpen = false;
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function activate(context) {
  log = vscode.window.createOutputChannel('JJ Palette');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('jjPalette.describe', () => cmdBuiltin('describe')),
    vscode.commands.registerCommand('jjPalette.commit', () => cmdBuiltin('commit')),
    vscode.commands.registerCommand('jjPalette.diff', cmdDiff),
    vscode.commands.registerCommand('jjPalette.edit', cmdEdit),
    vscode.commands.registerCommand('jjPalette.custom', cmdCustom),
    vscode.commands.registerCommand('jjPalette.addCustom', cmdAddCustom),
    vscode.commands.registerCommand('jjPalette.diagnose', () => cmdDiagnose(context)),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContentProvider)
  );
  log.appendLine(
    'JJ Palette ' + (context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : '?') +
      ' activated (' + context.extensionPath + ')'
  );

  // Handlers for the generated palette entries: current settings, plus whatever the manifest
  // still lists (so a removed command reports a helpful message instead of "command not found").
  let manifestIds = [];
  try {
    manifestIds = lib.generatedIds(JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')));
  } catch (err) {
    log.appendLine('cannot read the extension manifest: ' + err);
  }
  registerPaletteHandlers(context, manifestIds);
  syncPaletteManifest(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jjPalette.customCommands')) {
        registerPaletteHandlers(context);
        syncPaletteManifest(context);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
