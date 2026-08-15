# Git Merge Timeline

Desktop app that plots a Git repository as a **network timeline**: one swimlane per branch, commits on a time axis, and merge/PR flow drawn between lanes.

Built with [Wails](https://wails.io) (Go + React). Requires `git` on your `PATH`.

## Features

### Open a repository

- Type a folder path and press Enter, or click **Load repository**
- **Browse** opens a native folder dialog
- Resolves the Git toplevel (works from a subdirectory)
- Rejects missing paths and non-Git folders

### Branch swimlanes

- One colored lane per branch
- Local heads plus remotes (`origin` / `upstream` prefixes are stripped when they match a local name)
- Default sort prefers `main`, `master`, `trunk`, `develop`, `dev`
- Deleted source branches keep their name when it can be recovered from the merge message or `git name-rev`
- Unrecoverable sources show as `lost/<short-hash>`

### Time-based graph

- Commits placed by author date
- Default window is the current month (at least 7 days)
- Adaptive time axis: months → weeks → days → hours → 15-minute ticks as you zoom
- **Scroll** to zoom, **drag** to pan, **double-click** to reset
- Commits on the same branch and calendar day are **clustered** (count badge, up to `99+`)
- Hover tooltip lists up to 8 messages in a cluster

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
- **Search commits** — filter by subject
- **Kind toggles** — PR / Merge / Normal
- Header badges: visible/total branches, merge count, commit count

### Inspector

Click a node to open a sliding panel:

- **Commit** — hash, message, branch, time, author
- **Merge** — source/target branches, exclusive commit count, plus the fields above
- **Cluster** — that day’s commits with time and author chips

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
