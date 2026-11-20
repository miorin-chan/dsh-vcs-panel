# dsh-vcs-panel

English | [中文](README.zh.md)

Version control in the DeepSeek Harness right Sidebar.
Adds a `VCS` tab to inspect working changes, syntax-highlighted diffs, and commit history with a lane graph,
for both **Git** and **Jujutsu** repositories—and to act on Git branches, remote branches, tags,
and commits in one place: check out, rename, delete, merge into the current branch,
rebase the current branch onto another, push a branch, check out or delete a remote branch,
merge or pull it into the current branch, delete or push a tag, tag a commit, branch from it, check it out,
cherry-pick, revert, drop, merge, rebase, or reset to it, or sync with the upstream.

## Features

- **In the Sidebar.** The panel lives in a `VCS` tab beside files and terminals, with a card on the Sidebar guide.
  The Turn banner and the shortcut open the same tab.
  A header toggle shows the timeline beside the changes, or one column at a time
  so a wide Sidebar gives the diff its full width.
- **Timeline & lane graph.** Browse working changes and topological commit history together,
  with branches, bookmarks, and tags.
  Click the repository name in the header to switch repositories.
- **Worktrees on one graph.** In **Worktrees**, check Git worktrees or Jujutsu workspaces
  and switch **Commits** between **All** (default) and **Selected** in the menu header;
  in single-worktree Git, the branch menu header offers the same synced **All** / **HEAD** switch.
  Narrowing the history shows one compact filter indicator on the branch button (single-worktree Git)
  or **Worktrees** button (multi-worktree or Jujutsu).
  The session worktree is selected by default.
  Git shows a changes row for each selected worktree; Jujutsu marks each selected working-copy commit with `name@`.
  Checking a worktree leaves the session directory and checkouts in place.
- **Inline change tree.** Browse changed files as a collapsible list, or expand any file to read its diff
  in place with sticky headers, unified or split view, and line wrapping (on by default).
- **Git & Jujutsu native.** Shows staged and unstaged groups (untracked items marked `U`,
  new additions `A`) and ahead/behind in Git.
  Jujutsu shows change IDs and bookmarks; refreshing snapshots the checked workspaces
  so their working-copy diffs reflect the files on disk.
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
- **Writes stay explicit.** Git writes start from a staging, sync, branch, remote-branch, tag, or commit action.
  A conflicting merge, pull, pick, revert, drop, or rebase is aborted;
  pushes and remote deletions never force anything; Jujutsu only snapshots the working copy on read.
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
| `↑` `↓`, `Home` `End` | Move inside an open repository, worktree, branch, or actions menu; `Esc` closes it |
| Right-click / `Shift+F10` | Right-click or activate a branch, remote-branch, or tag badge for its actions; press `Shift+F10` on the branch control for branch actions or on a commit row for commit actions |
| `Enter`, `Esc` | Confirm or cancel a branch, remote-branch, tag, or commit action dialog |
| `[` / `]` | Move to the previous / next tree row, skipping hunk headers |

Clicking toolbar buttons or switching back to the window keeps keyboard focus ready on the active timeline
or diff stop without interrupting active inputs or dialogs.

## Install

Requires **DSH 0.2.2-rc.3+** (Desktop or Web) with the right-Sidebar tab and navigation APIs,
and `git` or `jj` on `PATH`.
Discovering Jujutsu sibling workspaces requires **jj 0.47+** and recorded workspace paths.
The current workspace remains available without them.

- **In DSH:** Open **Plugins → Add plugin**, select this directory, and restart DSH.
- **Via CLI:**
  ```sh
  dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
  ```
Restart DSH after adding. Disable or uninstall in **Plugins** at any time (restores Chat's default changed-files card).

## Development

```sh
npm install          # install esbuild
npm run build        # build client.js from src/client/
npm run check        # run node --test and verify client.js is current
npm pack --dry-run   # verify package contents
```

Edit `src/client/` and run `npm run build` to update generated `client.js`.
Run `dsh plugin` lifecycle checks against a temporary `DSH_HOME` to keep your real profile untouched.
To check the panel in a running DSH Web, create the Git fixture with `node scripts/fixture.mjs <dir>`
and follow the steps in [`TODO.md`](TODO.md).

Design: [`DESIGN.md`](DESIGN.md) · Implementation & limits: [`IMPLEMENTATION.md`](IMPLEMENTATION.md) · Changelog:
[`CHANGELOG.md`](CHANGELOG.md) · License: MIT ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE))
