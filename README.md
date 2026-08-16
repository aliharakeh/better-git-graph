# Git Merge Timeline

Desktop app that plots a Git repository as a **network timeline**: one swimlane per branch, commits on a time axis, and merge/PR flow drawn between lanes.

Built with [Wails](https://wails.io) (Go + React). Requires `git` on your `PATH`.

The app is **read-only** except for **fetch**, which updates remote-tracking refs (`refs/remotes`) and does not change your working tree.

## Features

### Open a repository

- Type a folder path and press Enter, or click **Load repository**
- **Browse** opens a native folder dialog
- Resolves the Git toplevel (works from a subdirectory)
- Rejects missing paths and non-Git folders

### Local git

Inspects the repo on disk. None of these write to git.

- Confirm the folder is a git repo (`rev-parse --show-toplevel`)
- List **local branches** and tip dates (`for-each-ref refs/heads`)
- List **remote-tracking branches** already fetched (`for-each-ref refs/remotes`)
- List **tags** on commits (`for-each-ref refs/tags`)
- Load commit history for selected branches (`git log`, first-parent, time window)
- Recover names for deleted merge sources (`name-rev`, merge-message parse)
- Read `origin` (or the first remote) URL and build a web link
- Open a commit in the browser (GitHub / GitLab / Bitbucket URL)

### Remote git

Talks to the server only through **fetch**.

- Shows the remote name, URL, and clickable repo link
- **Fetch origin** — `git fetch --prune` (60s timeout)
  - SSH remotes use your SSH keys
  - HTTPS uses a saved PAT if present, otherwise Git Credential Manager
- Save or clear a **PAT per host** (`github.com`, `gitlab.com`, `bitbucket.org`, …) in app config (`auth.json`), not in the git repo
- After fetch, the branch list and graph reload so recently updated remote tips can rank first

Token usernames: GitHub `x-access-token`, GitLab `oauth2`, Bitbucket `x-token-auth`.

### Branch swimlanes

- One colored lane per branch
- Local heads plus remotes (`origin` / `upstream` prefixes are stripped when they match a local name)
- **By updated** sorts by the tip’s later of author date and committer date (newest first); **A–Z** is alphabetical
- Default visible set is the top 5 by that sort
- Deleted source branches keep their name when it can be recovered from the merge message or `git name-rev`
- Unrecoverable sources show as `lost/<short-hash>`

### Time-based graph

- Commits placed by author date
- Initial window is the last 5 months (at least 7 days); pan/zoom loads more history in chunks
- Adaptive time axis: months → weeks → days → hours → 15-minute ticks as you zoom
- **Scroll** to zoom, **drag** to pan, **double-click** to reset
- Commits on the same branch and calendar day are **clustered** (count badge, up to `99+`)
- Hover tooltip lists up to 8 messages in a cluster
- **Refresh** reloads the current branch set without resetting the catalog

### Merge and PR flow

- Merge commits (2+ parents) become curves from source lane to target lane
- Same-lane merges draw a loop
- Gradient stroke + directional arrows
- GitHub (`Merge pull request #N from …`) and Bitbucket (`Merged in … (pull request #N)`) subjects are classified as **PR**
- Also parses `Merge branch '…'`, `Merge tag '…'`, and remote-tracking merge messages
- Each merge reports how many exclusive commits it brought in

### Filters

- **Visible branches** — slider / number for top N, All / None, per-branch checkboxes
- **Sort** — last updated or A–Z
- **Search branches** — filter the list; a unique match highlights that lane
- **Focus** a branch to dim unrelated lanes (keeps merge partners visible)
- **Authors** — search, toggle, All / None
- **Search commits** — filter by subject or tag; next/previous match
- **Kind toggles** — PR / Merge / Normal, and Feature / Hotfix / Epic / Others
- Header badges: visible/total branches, merge count, commit count

### Inspector

Click a node to open a sliding panel:

- **Commit** — hash, message, branch, time, author, tags, link to the remote commit
- **Merge** — source/target branches, exclusive commit count, plus the fields above
- **Cluster** — that day’s commits with time and author chips

### Not included

No clone, pull, push, checkout, commit, merge, rebase, stash, branch create/delete, tagging, GitHub/GitLab API, PR list, or OAuth login.

## Development

```bash
wails dev
```

Hot-reloads the frontend. A browser debug server is also available at http://localhost:34115.

```bash
wails build
```

Produces a redistributable in `build/bin`.

## License

MIT
