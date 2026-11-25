# dsh-vcs-panel

English | [中文](README.zh.md)

Version control in the DeepSeek Harness right Sidebar.
Adds a `VCS` tab to inspect working changes, syntax-highlighted diffs, and commit history with a lane graph,
for both **Git** and **Jujutsu** repositories—and to act on Git branches, remote branches, tags,
and commits in one place: check out, rename, delete, merge into the current branch,
rebase the current branch onto another, push a branch, check out or delete a remote branch,
merge or pull it into the current branch, delete or push a tag, tag a commit, branch from it, check it out,
cherry-pick, revert, drop, merge, rebase, or reset to it, stash changes and apply, recover, or drop a stash,
or sync with the upstream.

## Features

- **In the Sidebar.** The panel lives in a `VCS` tab beside files and terminals, with a card on the Sidebar guide.
  The Turn banner and the shortcut open the same tab.
  A header toggle shows the timeline beside the changes, or one column at a time
  so a wide Sidebar gives the diff its full width.
- **Timeline & lane graph.** Browse working changes and topological commit history together,
  with branches, bookmarks, and tags.
  The timeline shows one repository at a time, named on the leftmost header button.
- **Overview and repository switching.** The repository button pushes in an overview
  of every repository's branches, detached checkouts, and stashes, each counted against its own trunk
  and colored by what needs attention: unsaved changes, commits only this machine has,
  divergence, falling behind, merged, stashed, or an operation in progress.
  Click a repository to read its timeline, even while its pointers are still loading, or click a pointer to jump to it.
  The gear in the overview header opens **Manage repositories**, where you preview and add a folder of repositories
  or register a specific nested repository, and pick Git or Jujutsu for a repository that carries both markers.
  Discovery rules are saved relative to the session directory in `.dsh/vcs-panel.json`.
  Repositories under the session folder that discovery leaves out are listed and can be added in one step.
- **Tiled repositories.** The tile half of the repository button (`T`) lays every repository out
  as a column of pointers, ordered by attention or by folder; `1`–`7` step through one state,
  and `Enter` opens the focused pointer in the timeline.
- **All repositories.** The pinned row at the top of the overview turns the timeline
  into one read-only history of every repository, grouped by day.
  The same commit message landing in several repositories within half an hour folds into one row,
  and a repository's commits less than 45 minutes apart fold into one burst of work; expand either in place.
  Select a row to read its changes, and press `o`, double-click it, or use the repository button
  in the detail toolbar to open the same commit or stash in its own repository, where the menus act on it.
- **Worktrees on one graph.** In **Worktrees**, check Git worktrees or Jujutsu workspaces
  and switch **Commits** between **All** (default) and **Selected** in the menu header;
  in single-worktree Git, the branch menu header offers the same synced **All** / **HEAD** switch.
  Narrowing the history shows one compact filter indicator on the branch button (single-worktree Git)
  or **Worktrees** button (multi-worktree or Jujutsu).
  The session worktree is selected by default.
  Git shows a changes row for each selected worktree; Jujutsu marks each selected working-copy commit with `name@`.
  Checking a worktree leaves the session directory and checkouts in place.
- **Create and remove working copies.** Use **+ New** in the worktree menu header
  to create a Git worktree or Jujutsu workspace.
  A destination such as `../topic` creates a checkout beside the current repository.
  Git can create a branch, check out an available local branch, or detach `HEAD`.
  Jujutsu creates a working-copy commit on the chosen parent revision.
  Use a row's **…** menu to remove an eligible Git worktree while keeping its branch.
  Jujutsu can detach the workspace and any colocated Git worktree while keeping the working files,
  or remove the directory on versions that support `jj workspace remove`.
- **Inline change tree.** Browse changed files as a collapsible list, or expand any file to read its diff
  in place with sticky headers, unified or split view, and line wrapping (on by default).
- **Git & Jujutsu native.** Shows staged and unstaged groups (untracked items marked `U`,
  new additions `A`) and ahead/behind in Git.
  The visible panel follows local Git changes and updates status and history independently.
  Jujutsu shows change IDs and bookmarks.
  Use Refresh to snapshot checked workspaces after external file edits.
- **Git staging.** Point at or focus a row to show its command in the staging column at the left edge:
  `+` stages a row under **Unstaged**, and `−` unstages a row under **Staged**.
  A half-filled dot marks a file that has changes in both groups; its command stages the remaining changes
  from **Unstaged** or unstages all staged changes from **Staged**.
  Folder and group rows stage or unstage every file below them in one step,
  including untracked folders, and one undo restores them.
  Press `s` to stage or `u` to unstage the row under the cursor.
  Expand a supported text diff to stage or unstage an individual addition or deletion directly
  from its checkbox in either layout, or use the checkbox in a hunk header for the whole hunk;
  a mixed hunk checkbox stages its remaining changes.
  Staging is available when only the repository's default Git worktree is selected.
  It updates the index and preserves working file contents.
  Use the list icon in the Git worktree toolbar to switch between the default merged view (one row per file)
  and separate Staged/Unstaged groups, where each file and folder in the merged view shows a checkbox:
  empty for unstaged, a check for staged, and a dash for partially staged.
  In the merged view, clicking a dash stages the remaining changes,
  and the file’s **…** menu can unstage all staged changes.
- **Undo and redo staging.** Use the curved arrows in the worktree detail toolbar to undo
  or redo whole-file and selected-line staging actions made in the panel.
  Hover or focus an arrow to see the file and scope.
  If the affected index entries or `HEAD` have changed, the panel keeps the current changes and reports the conflict.
  A new staging action after undo clears redo history.
  Restarting DSH clears the history.
- **Turn banner & shortcut.** File-changing turns end with a compact VCS banner showing that turn's branch (or `@`),
  changed-file count, and `+` / `−` line totals in place of Chat's changed-files card.
  Open the Sidebar tab from anywhere with `⌘⇧G` / `Ctrl+Shift+G`, and press it again to slide back to the conversation.
- **One-click sync.** The button beside the Git branch shows ahead/behind counts;
  clicking it fetches the upstream, then fast-forwards or pushes.
  A diverged branch, a fast-forward that would overwrite local edits, or a branch
  without an upstream is left untouched with a note on what to do next.
  Every Git repository row in the overview carries the same button for its checked-out branch,
  so you can sync any repository in place and read the result under its row.
- **Branch switching.** The branch name opens the repository's local branches; picking one checks it out.
  Only local branches are listed—no implicit remote-tracking branches;
  remote branches are checked out explicitly from their history badges.
  Git refuses when local changes would be overwritten, so nothing is stashed, discarded, or forced.
- **Branch actions.** Right-click the current branch, any branch in the list, a branch badge in the history timeline,
  or click/activate a branch badge in the commit detail header (or press `Shift+F10` on the branch control)
  for checkout, rename, delete, merge into the current branch, rebase the current branch onto it, and push.
  The checked-out branch offers rename and push only (with `Push` disabled and explained
  when no upstream is configured).
  Rename, delete, merge, and rebase state what will happen before they run; an unmerged delete needs a second,
  explicit confirmation; a conflicting merge or rebase is aborted and leaves the branch unchanged.
  Push sends exactly the named branch to its configured upstream and never forces.
- **Remote branch actions.** Right-click a remote branch badge in history or click/activate it
  in the commit detail header (such as `origin/topic`) for Checkout Branch, Delete Remote Branch,
  Merge into current branch, and Pull into current branch.
  Checkout asks for the local name, creates a branch that tracks the remote, and checks it out.
  Delete removes the branch on its remote after confirmation and drops the stale tracking ref.
  Merge and pull use the same conflict-abort rules as local merges;
  pull fetches the named remote branch first, then merges it.
  Merge and pull are omitted on a detached HEAD.
- **Tag actions.** Right-click a tag badge in the history timeline or click/activate it
  in the commit detail header for `Delete Tag…` and `Push Tag…`.
  Delete removes only the local tag and states that a remote copy stays;
  push sends exactly that tag to a chosen configured remote and never forces,
  so a tag already on the remote with a different object is refused rather than moved.
  The push dialog loads the repository's remotes and says so when there are none.
- **Commit actions.** Right-click a commit row (or focus it and press `Shift+F10`) for Add Tag,
  Create Branch (with an option to check it out immediately), Checkout, Cherry Pick, Revert, Drop,
  Merge into current branch, Rebase current branch on this Commit, and Reset current branch to this Commit.
  Every history write opens a dialog that names the commit and what will change;
  a conflict aborts the operation and restores the branch.
  Actions known from loaded history to be inapplicable on or off the current branch are pruned automatically,
  and Drop is further checked on the Host; Reset chooses Soft, Mixed, or Hard,
  and only Hard discards staged and unstaged changes.
  Timeline rows summarize more than three refs with `+N`, while the commit detail header keeps every ref clickable.
- **Stashes.** **Stash Changes…** in the working-tree toolbar stashes every change, untracked files included by default.
  Each stash appears in the timeline just above the commit it was made on;
  select it to read its changes against that base.
  Right-click a stash row (or press `Shift+F10`), its badge in the detail header, or its overview pointer
  to Apply (optionally restoring the staged state and dropping the stash afterwards), Create Branch from Stash, or Drop.
  Before applying, the Host checks that the stash applies cleanly; a conflict,
  unstaged changes it would overwrite, or untracked files already in place leave everything untouched,
  and a conflicting stash can be recovered on a new branch at its base instead.
- **Writes stay explicit.** Writes start from a worktree, staging, sync, branch,
  remote-branch, tag, commit, or stash action.
  A conflicting merge, pull, pick, revert, drop, or rebase is aborted, and a stash
  that would conflict is not applied; pushes and remote deletions never force anything.
  Jujutsu snapshots the working copy on manual refresh or after an Agent turn with changes.
  Follows DSH themes and all 8 UI languages, and loads large histories and diffs on demand.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘⇧G` / `Ctrl+Shift+G` | Open the `VCS` tab in the right Sidebar, or collapse the Sidebar when it is showing (rebind in **Settings → Shortcuts**) |
| `↑` `↓` or `j` `k` | Move through commits or one vertical list of tree rows and hunk headers of open diffs (returns to commit header at row 0) |
| `s` / `u` | Stage or unstage the file, folder, or group under the cursor in a Git working tree |
| `Tab`, `↑` `↓`, `Space` | Tab to a diff staging checkbox, use `↑` / `↓` to move between diff checkboxes, and press `Space` to stage or unstage. |
| `PageUp` `PageDown`, `Home` `End` | Page through or jump to the ends of the timeline or change tree |
| `←` `→` or `h` `l` | Enter the change tree, expand a row, or step into an open file's first hunk; `←` / `h` closes an open file first, then returns to the timeline |
| `Enter`, `Space`, `Esc` | Fold/expand the focused row or activate a ref badge in the detail header; `Esc` returns to the timeline |
| `↑` `↓`, `Home` `End` | Move inside an open worktree, branch, or actions menu; `Esc` closes it |
| Right-click / `Shift+F10` | Right-click or activate a branch, remote-branch, tag, or stash badge for its actions; press `Shift+F10` on the branch control for branch actions, on a commit row for commit actions, or on a stash row for stash actions |
| `Enter`, `Esc` | Confirm or cancel a branch, remote-branch, tag, commit, or stash action dialog |
| `[` / `]` | Move to the previous / next tree row, skipping hunk headers |
| `T`, `/` | Tile the repositories or return to the timeline; search the open overview (both commands can be bound in **Settings → Shortcuts**) |
| `Space`, `o` | In **All repositories**, expand or fold the burst or shared change under the cursor; open the selected row in its repository |
| `1`–`7`, `n`, `Esc` | While tiled, step to the next pointer of a state (`Shift` steps back), continue with `n`; `Esc` clears the step, then returns to the timeline |

Clicking toolbar buttons or switching back to the window keeps keyboard focus ready on the active timeline
or diff stop without interrupting active inputs or dialogs.

## Install

Requires **DSH 0.2.2-rc.3+** (Desktop or Web) with the right-Sidebar tab and navigation APIs,
and `git` or `jj` on `PATH`.
Discovering and managing Jujutsu sibling workspaces requires **jj 0.47+** and recorded workspace paths.
The current workspace remains available for browsing without them.

Run `pnpm install --frozen-lockfile` in a fresh checkout to install dependencies and build the plugin.
Then add the directory using either of these methods.

- **In DSH:** Open **Plugins → Add plugin** and select the directory.
- **Via CLI:**
  ```sh
  dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
  ```
Restart DSH after adding. Disable or uninstall in **Plugins** at any time (restores Chat's default changed-files card).

## Development

Use Node.js 22.18 or a later release with native TypeScript stripping to run `test/*.test.mts`.

```sh
pnpm install --frozen-lockfile # install dependencies and build the artifacts
npm test                     # rebuild and run tests
npm run check                # tests, typecheck, artifact freshness, pinned type packages
npm pack --dry-run            # preview package contents
```

The plugin sources live in `src/host/`, `src/lib/`, and `src/client/`.
Build tools live in `scripts/*.mts`.
Git ignores the generated `index.js`, `client.js`, `lib/`, and `scripts/*.mjs`.
The npm package includes both entries and `lib/`, including the `lib/client/` modules used by Node tests.
Install dependencies before running `npm run check` on a fresh checkout.
Use `npm run build` to refresh the artifacts after editing the sources.
Types are used only with `import type`, so no artifact imports `@deepseek-ai/*` at runtime.
Run `dsh plugin` lifecycle checks against a temporary `DSH_HOME` to keep your real profile untouched.
To check the panel in a running DSH Web, create the Git fixture with `node scripts/fixture.mts <dir>`
and follow the steps in [`TODO.md`](TODO.md).

Design: [`DESIGN.md`](DESIGN.md) · Implementation & limits: [`IMPLEMENTATION.md`](IMPLEMENTATION.md) · Changelog:
[`CHANGELOG.md`](CHANGELOG.md) · License: MIT ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE))
