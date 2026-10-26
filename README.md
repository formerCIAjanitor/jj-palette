# jj-palette

A small VS Code extension that puts [Jujutsu](https://github.com/jj-vcs/jj) commands in the Command Palette, where they can be fuzzy-searched:

| Palette entry | What it does |
| --- | --- |
| `jj describe` | Runs `jj describe`. |
| `jj commit` | Runs `jj commit`. |
| `jj diff` | Opens the diff of the working-copy change in an editor tab with diff highlighting. |
| `jj edit` | Lists recent changes in a searchable picker and runs `jj edit` on the selected one. |
| `jj <name>` | One entry per custom command saved in the user settings, for example `jj pm`. See [Direct palette entries](#direct-palette-entries). |
| `jj custom...` | A picker over all custom commands (user, workspace, folder), plus a one-off command with arguments typed on the spot. |
| `jj add custom command...` | Saves a new custom command to the user settings. |
| `jj diagnose` | Writes a report to the `JJ Palette` output channel and the clipboard: the manifest VS Code loaded versus the one on disk, which settings are registered, and the environment. For problem reports. |

## Requirements

- VS Code 1.80 or newer.
- `jj` reachable from VS Code, or its path set in `jjPalette.jjPath`. Tested with jj 0.45.1.
- For `describe`, `commit`, and custom commands in mode `editor`: the `code` launcher reachable from the shell VS Code uses for tasks, or `jjPalette.editor` set to a command that blocks until the message file is closed.
- A workspace folder that is a Jujutsu repository.

## Commands

### jj describe and jj commit

`jj` is started with `JJ_EDITOR` set to `code --wait`, so the message opens as a tab in the current window.

### jj diff

Runs `jj diff --git` and opens the result in an editor tab with the `diff` language mode. If the working-copy change has no modifications, a notification says so. Change the arguments with `jjPalette.diffArgs`, for example `["--git", "-r", "@-"]` for the parent change, or `["--stat"]`.

### jj edit

Lists the changes matched by `jjPalette.changeRevset` (default: the 50 newest ancestors of all visible heads, without the root). Each entry shows the change ID and first description line.
The description column shows `@` for the working copy, `empty` for empty changes, and bookmarks.
The picker searches all of this.
The selected change is passed to `jj edit` by commit ID, which also works for divergent changes.

If the list cannot be produced (for example because of an invalid revset), an input box accepts a revision typed by hand.

### jj custom...

Opens a picker with the saved custom commands and two fixed entries:

- `Run with arguments...` asks for arguments and runs them once (for example `log -r @- --limit 5`).
The result is shown according to `jjPalette.adhocMode`.
- `Add custom command...` starts the wizard described below.

## Custom commands

A custom command is an entry in `jjPalette.customCommands`:

```json
"jjPalette.customCommands": [
  { "name": "log recent",  "args": "log --limit 10", "mode": "document" },
  { "name": "show change", "args": "show --git ${revision}", "mode": "document", "language": "diff" },
  { "name": "abandon",     "args": "abandon ${revision}" },
  { "name": "new with message", "args": ["new", "-m", "${input}"] },
  {
    "name": "pm",
    "args": ["util", "exec", "--", "sh", "-c",
             "jj bookmark set master -r 'latest(::@ ~ empty())' --allow-backwards -B master && jj git push -b master"],
    "mode": "terminal"
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | Name in the picker. Also the key for keybindings. |
| `args` | Arguments for `jj`, as a string (quotes are understood) or as an array. A leading `jj` is ignored. |
| `mode` | How the command runs. Default `auto`. |
| `language` | Language id for the output tab, for example `diff`. Default: plain text. |

Placeholders in `args`:

- `${revision}`: opens the same change picker as `jj edit`; the selected commit ID is substituted.
- `${input}`: asks for a text value.

If the picker or input is cancelled, nothing runs.

Modes:

| Mode | Behavior |
| --- | --- |
| `auto` | Runs in the background. Output of at most 8 lines and 600 characters is shown as a notification, longer output in an editor tab. |
| `document` | Runs in the background. Output always opens in an editor tab. |
| `editor` | Runs as a task with `JJ_EDITOR` set. `jj` opens its message editor as a VS Code tab, as with `describe` and `commit`. Use for commands that ask for a message without `-m`. |
| `terminal` | Runs visibly in the terminal panel. Use for interactive commands. |

Background commands (`auto`, `document`, `jj diff`, `jj edit`) have no terminal.
They are stopped after `jjPalette.timeoutSeconds` (default 60), and a command that waits for an editor fails or times out in these modes.
Use mode `editor` for those.

### Adding a command

Either edit the setting directly, or run `jj add custom command...` from the palette.
The wizard asks for a name, the arguments, and the mode, then appends the entry to the user settings.
Entries from user, workspace, and folder settings are combined; an entry in a narrower scope replaces an entry of the same name.

### Direct palette entries

Each custom command in the **user** settings gets its own Command Palette entry titled `jj <name>`, so `jj pm` is one step: open the palette, type, Enter.

VS Code reads palette titles from the extension manifest only, so the extension writes these entries into its own installed `package.json`.
Consequences:

- After adding, renaming, or removing a custom command, a notification offers `Reload Window`. The palette entry appears (or disappears) after the reload. Until then, the command already runs through `jj custom...` and keybindings.
- Only the user-level setting is written. Workspace and folder commands do not get palette entries, so the palette is the same in every window. They stay available in `jj custom...`.
- The entry runs the command with the name it had when the entry was written. A leftover entry for a removed command shows an explanatory message.
- If the extension folder is not writable, a warning says so, and `jj custom...` and keybindings keep working.
- Reinstalling the extension resets the manifest; it is regenerated at the next start, followed by the reload notification.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `jjPalette.editor` | `code --wait` | Value of `JJ_EDITOR` for `describe`, `commit`, and custom commands in mode `editor`. Must block until the tab is closed. Examples: `code-insiders --wait`, `codium --wait`. Empty keeps the editor from the jj config. |
| `jjPalette.jjPath` | `jj` | Path to the `jj` executable. |
| `jjPalette.diffArgs` | `["--git"]` | Arguments appended to `jj diff`. |
| `jjPalette.changeRevset` | `ancestors(visible_heads(), 50) ~ root()` | Revset for the change picker. |
| `jjPalette.customCommands` | `[]` | Custom commands, see above. |
| `jjPalette.adhocMode` | `auto` | Result display for `Run with arguments...`: `auto`, `document`, or `terminal`. |
| `jjPalette.timeoutSeconds` | `60` | Time limit for background commands. |
| `jjPalette.refreshJjx` | `true` | After a command, ask the Jujutsu X extension (if installed) to refresh its graph. |

`JJ_EDITOR` is set for the started process only.
The jj configuration and the environment of other terminals are not modified.

## Logs

The output channel `JJ Palette` (View → Output) lists every jj invocation with its working directory, exit code, and error text.

## Build from source

Requires Node.js. The extension has no dependencies.

```
npx @vscode/vsce package --allow-missing-repository --no-dependencies
```

Run the unit tests for the helper functions:

```
node --test test/lib.test.js
```

Run without packaging:

```
code --extensionDevelopmentPath=/path/to/jj-palette
```

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Manifest: commands, settings, activation events. |
| `extension.js` | Command handlers, process and task handling, pickers. |
| `lib.js` | Pure helpers (argument parsing, placeholders, output parsing). No `vscode` import. |
| `test/lib.test.js` | Unit tests for `lib.js`. |
| `.gitignore` | Excludes tests and build artifacts from the packaged extension. |
| `LICENSE` | MIT license text. |

## Limitations

- Palette entries for custom commands appear only after a window reload, and only for commands in the user settings.
- `jj diff` shows the working-copy change unless `jjPalette.diffArgs` selects another revision.
- `jj split`, `jj squash -i` and other commands that open an interactive diff editor need a terminal; define them in mode `terminal`.

## License

MIT. See `LICENSE`.
