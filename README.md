# jj-palette

[Jujutsu](https://github.com/jj-vcs/jj) commands in the VS Code Command Palette.

| Entry | Action |
| --- | --- |
| `jj describe`, `jj commit` | Run the command; the message opens as an editor tab (`JJ_EDITOR=code --wait`), like `git commit`. |
| `jj diff` | Open the working-copy changes in VS Code's split diff editor. Several files: picker with `All changes` (multi-file editor) and one entry per file. |
| `jj edit` | Pick a change from a searchable list and run `jj edit` on it. |
| `jj <name>` | One entry per custom command in the user settings. |
| `jj custom...` | Picker over all custom commands, plus one-off arguments. |
| `jj add custom command...` | Add a custom command to the user settings. |
| `jj diagnose` | Report loaded manifest, registered settings and environment (output channel and clipboard). |

Requires VS Code 1.80+ and `jj` (tested with 0.45.1) on the `PATH` seen by VS Code, or `jjPalette.jjPath`. The repository is taken from the active file, else the workspace folder (a picker appears for multi-root).

## Custom commands

```jsonc
"jjPalette.customCommands": [
  { "name": "show change", "args": "show --git ${revision}", "mode": "document", "language": "diff" },
  { "name": "abandon", "args": "abandon ${revision}" },
  { "name": "new with message", "args": ["new", "-m", "${input}"] },
  { "name": "pm", "mode": "terminal",
    "args": ["util", "exec", "--", "sh", "-c",
             "jj bookmark set master -r 'latest(::@ ~ empty())' --allow-backwards -B master && jj git push -b master"] }
]
```

- `args`: string (quotes understood) or array; a leading `jj` is ignored.
- `${revision}` opens the change picker (commit ID is substituted); `${input}` asks for text. Cancelling runs nothing.
- `mode`:
  - `auto` (default): background; short output as notification, long output in a tab.
  - `document`: background; output always in a tab (`language` sets its language id).
  - `editor`: task with `JJ_EDITOR` set, for commands that open a message editor.
  - `terminal`: typed into an integrated terminal (one per repository), as if run by hand. Exit-code warning and graph refresh need shell integration (VS Code 1.93+).
- Background modes have no terminal and stop after `jjPalette.timeoutSeconds`.
- In `editor` and `terminal` modes, arguments are quoted for `vscode.env.shell` (POSIX shells, PowerShell, cmd). Other task shells may mismatch.
- User, workspace and folder entries are merged; narrower scopes win by name.

### Palette entries

VS Code reads palette titles from the manifest only, so entries for user-level custom commands are written into the extension's installed `package.json`. After changing them, reload the window (a notification offers it). Workspace and folder commands get no entry; use `jj custom...`. If the folder is not writable, a warning appears and the picker still works.

### Keybinding

```json
{ "key": "ctrl+alt+a", "command": "jjPalette.custom", "args": "abandon" }
```

## Settings

| Setting | Default |
| --- | --- |
| `jjPalette.editor` | `code --wait` (`JJ_EDITOR` for editor modes; must block until the tab closes) |
| `jjPalette.jjPath` | `jj` |
| `jjPalette.diffMode` | `split` (`split`, or `text` for a diff-highlighted tab; merge changes always use `text`) |
| `jjPalette.diffArgs` | `["--git"]` (`text` mode only) |
| `jjPalette.changeRevset` | `ancestors(visible_heads(), 50) ~ root()` (change picker) |
| `jjPalette.customCommands` | `[]` |
| `jjPalette.adhocMode` | `auto` (`auto`, `document`, `terminal`) |
| `jjPalette.timeoutSeconds` | `60` |
| `jjPalette.refreshJjx` | `true` (refresh the Jujutsu X graph after commands) |

Every jj invocation is logged in the `JJ Palette` output channel.

## Troubleshooting

- `Cannot run 'jj'`: set `jjPalette.jjPath`.
- Message editor fails: `jjPalette.editor` must include `--wait`, and the `code` launcher must be on the `PATH`.
- `jj edit` shows an input box: `jjPalette.changeRevset` is invalid or matches nothing.
- "Unknown Configuration Setting": run `jj diagnose` and compare the loaded manifest with the one on disk.
- No palette entry for a custom command: reload the window; the command must be in the user settings.

## Development

```
node --test test/lib.test.js test/shell.test.js
npx @vscode/vsce package --allow-missing-repository --no-dependencies
```

Tested with a mocked `vscode` API against a real jj repository, not in a real VS Code window.

MIT license.
