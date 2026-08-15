import { FolderOpen, GitBranch, GitMerge, Loader2, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { LoadRepo, SelectRepo } from "../wailsjs/go/main/App";
import { TimelineGraph } from "./components/TimelineGraph";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";

function laneName(name) {
  return String(name || "").replace(/^(origin|upstream)\//, "")
}

function authorName(c) {
  return c.author || "(unknown)"
}

function isPrSubject(subject) {
  const s = String(subject || "")
  return /^Merge pull request #\d+/i.test(s) || /^Merged in \S+ \(pull request #\d+\)/i.test(s)
}

function commitKind(c) {
  if (!c.isMerge) return "normal"
  return isPrSubject(c.subject) ? "pr" : "merge"
}

const KIND_OPTS = [
  { id: "pr", label: "PR" },
  { id: "merge", label: "Merge" },
  { id: "normal", label: "Normal" },
]

function fmt(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function wailsError(err) {
  if (!err) return "unknown error"
  if (typeof err === "string") return err
  return err.message || String(err)
}

export default function App() {
  const [path, setPath] = useState("")
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [msgQuery, setMsgQuery] = useState("")
  const [authorQuery, setAuthorQuery] = useState("")
  const [focused, setFocused] = useState("")
  const [selected, setSelected] = useState(null)
  const [branchLimit, setBranchLimit] = useState(5)
  const [branchSort, setBranchSort] = useState("updated")
  const [visible, setVisible] = useState(() => new Set())
  const [authors, setAuthors] = useState(() => new Set())
  const [kinds, setKinds] = useState(() => new Set(["pr", "merge", "normal"]))

  async function load(nextPath) {
    const target = (nextPath ?? path).trim()
    if (!target) {
      setError("Enter a repository path")
      return
    }
    setLoading(true)
    setError("")
    setSelected(null)
    setFocused("")
    try {
      const data = await LoadRepo(target)
      setGraph(data)
      setPath(data.path || target)
      const names = [...new Set((data.branches || []).map(laneName))]
      const latest = {}
      for (const c of data.commits || []) {
        const t = +new Date(c.timestamp)
        const b = laneName(c.branch)
        if (latest[b] == null || t > latest[b]) latest[b] = t
      }
      names.sort((a, b) => (latest[b] || 0) - (latest[a] || 0))
      const n = Math.min(5, names.length)
      setBranchLimit(n || 1)
      setVisible(new Set(names.slice(0, n)))
      setMsgQuery("")
      setAuthorQuery("")
      setKinds(new Set(["pr", "merge", "normal"]))
      setAuthors(new Set((data.commits || []).map(authorName)))
    } catch (err) {
      setGraph(null)
      setError(wailsError(err))
    } finally {
      setLoading(false)
    }
  }

  async function browse() {
    try {
      const dir = await SelectRepo()
      if (!dir) return
      setPath(dir)
      await load(dir)
    } catch (err) {
      setError(wailsError(err))
    }
  }

  const rankedBranches = useMemo(() => {
    if (!graph) return []
    const names = [...new Set((graph.branches || []).map(laneName))]
    if (branchSort === "alpha") return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    const latest = {}
    for (const c of graph.commits || []) {
      const t = +new Date(c.timestamp)
      const b = laneName(c.branch)
      if (latest[b] == null || t > latest[b]) latest[b] = t
    }
    return names.sort((a, b) => (latest[b] || 0) - (latest[a] || 0))
  }, [graph, branchSort])

  const branches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rankedBranches.filter((b) => b.toLowerCase().includes(q)) : rankedBranches
  }, [rankedBranches, query])

  const highlight = useMemo(() => {
    if (focused) return focused
    const q = query.trim().toLowerCase()
    if (!q) return ""
    const exact = rankedBranches.find((b) => b.toLowerCase() === q)
    if (exact) return exact
    return branches.length === 1 ? branches[0] : ""
  }, [focused, query, rankedBranches, branches])

  const authorList = useMemo(() => {
    if (!graph) return []
    return [...new Set((graph.commits || []).map(authorName))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  }, [graph])

  const shownAuthors = useMemo(() => {
    const q = authorQuery.trim().toLowerCase()
    return q ? authorList.filter((a) => a.toLowerCase().includes(q)) : authorList
  }, [authorList, authorQuery])

  const visibleGraph = useMemo(() => {
    if (!graph) return null
    const names = rankedBranches.filter((b) => visible.has(b))
    const shown = new Set(names)
    const msg = msgQuery.trim().toLowerCase()
    const match = (c, kind) => authors.has(authorName(c)) && kinds.has(kind) && (!msg || String(c.subject || "").toLowerCase().includes(msg))
    return {
      ...graph,
      branches: names,
      commits: (graph.commits || []).map((c) => ({ ...c, branch: laneName(c.branch) })).filter((c) => shown.has(c.branch) && match(c, commitKind(c))),
      merges: (graph.merges || []).map((m) => ({
        ...m,
        sourceBranch: laneName(m.sourceBranch),
        targetBranch: laneName(m.targetBranch),
      })).filter((m) => shown.has(m.sourceBranch) && shown.has(m.targetBranch) && match(m, isPrSubject(m.subject) ? "pr" : "merge")),
    }
  }, [graph, rankedBranches, visible, authors, kinds, msgQuery])

  function showTop(n) {
    const count = Math.min(Math.max(n, 0), rankedBranches.length)
    setBranchLimit(count)
    setVisible(new Set(rankedBranches.slice(0, count)))
  }

  function toggleIn(setter, value) {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="drag flex h-11 items-center border-b border-border px-4">
        <GitMerge className="mr-2 size-4 text-primary" />
        <span className="text-sm font-semibold">Git Merge Timeline</span>
        <span className="ml-2 text-xs text-muted-foreground">Network history of branch merges</span>
      </header>

      <div className="no-drag flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Repository</label>
            <div className="flex gap-2">
              <Input
                value={path}
                placeholder="C:\\path\\to\\repo"
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && load()}
              />
              <Button variant="outline" size="icon" onClick={browse} title="Browse">
                <FolderOpen />
              </Button>
            </div>
            <Button className="w-full" onClick={() => load()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <GitBranch />}
              {loading ? "Loading…" : "Load repository"}
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          {graph?.branches?.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Visible branches</label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {visible.size} / {graph.branches.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={graph.branches.length}
                  value={Math.min(branchLimit, graph.branches.length)}
                  onChange={(e) => showTop(Number(e.target.value))}
                  className="h-2 w-full accent-primary"
                  title="Show top N by current sort"
                />
                <Input
                  type="number"
                  min={0}
                  max={graph.branches.length}
                  value={Math.min(branchLimit, graph.branches.length)}
                  onChange={(e) => showTop(Number(e.target.value) || 0)}
                  className="h-8 w-16 px-2 text-center"
                />
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={() => showTop(rankedBranches.length)}>
                  All
                </Button>
                <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={() => showTop(0)}>
                  None
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground">Branch highlight</label>
              <select
                value={branchSort}
                onChange={(e) => setBranchSort(e.target.value)}
                className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground"
              >
                <option value="updated">By updated</option>
                <option value="alpha">A–Z</option>
              </select>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-8 pr-8" value={query} placeholder="Search branches…" onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button className="absolute right-2 top-2 text-muted-foreground" onClick={() => setQuery("")}>
                  <X className="size-4" />
                </button>
              )}
            </div>
            <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {branches.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No branches loaded</p>}
              {branches.map((name) => (
                <div
                  key={name}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                    highlight === name ? "bg-primary/20 text-foreground" : "hover:bg-muted"
                  } ${!visible.has(name) ? "opacity-40" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={visible.has(name)}
                    onChange={() => toggleIn(setVisible, name)}
                    className="size-3.5 shrink-0 accent-primary"
                    title={visible.has(name) ? "Hide branch" : "Show branch"}
                  />
                  <button
                    onClick={() => setFocused(highlight === name ? "" : name)}
                    className="flex min-w-0 flex-1 items-center justify-between text-left"
                  >
                    <span className="truncate font-medium">{name}</span>
                    {highlight === name && <Badge>focus</Badge>}
                  </button>
                </div>
              ))}
            </div>
            {highlight && (
              <Button variant="ghost" size="sm" className="w-full" onClick={() => { setFocused(""); setQuery("") }}>
                Clear highlight
              </Button>
            )}
          </div>

          {graph && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Authors</label>
                <span className="font-mono text-[11px] text-muted-foreground">{authors.size} / {authorList.length}</span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input className="pl-8 pr-8" value={authorQuery} placeholder="Search authors…" onChange={(e) => setAuthorQuery(e.target.value)} />
                {authorQuery && (
                  <button className="absolute right-2 top-2 text-muted-foreground" onClick={() => setAuthorQuery("")}>
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={() => setAuthors(new Set(authorList))}>All</Button>
                <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={() => setAuthors(new Set())}>None</Button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-1">
                {shownAuthors.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No authors</p>}
                {shownAuthors.map((name) => (
                  <label key={name} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted ${!authors.has(name) ? "opacity-40" : ""}`}>
                    <input
                      type="checkbox"
                      checked={authors.has(name)}
                      onChange={() => toggleIn(setAuthors, name)}
                      className="size-3.5 shrink-0 accent-primary"
                    />
                    <span className="truncate">{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Inspector</CardTitle>
              <CardDescription>Click a commit or merge node</CardDescription>
            </CardHeader>
            <CardContent>
              {!selected ? (
                <p className="text-xs text-muted-foreground">Nothing selected.</p>
              ) : selected.kind === "merge" ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Merge commit" value={selected.hash} mono />
                  <Row label="Message" value={selected.subject || "—"} />
                  <Row label="Source branch" value={selected.sourceBranch} />
                  <Row label="Target branch" value={selected.targetBranch} />
                  <Row label="Timestamp" value={<TimeChip ts={selected.timestamp} withDate />} />
                  <Row label="Author" value={selected.author} />
                  <Row label="Commit count" value={String(selected.commitCount)} />
                </dl>
              ) : selected.kind === "cluster" ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Branch" value={selected.branch} />
                  <Row label="Date" value={new Date(selected.timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} />
                  <Row label="Commits" value={String(selected.count)} />
                  <div className="space-y-2">
                    {(selected.commits || []).map((c) => (
                      <div key={c.hash} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <TimeChip ts={c.timestamp} />
                          <AuthorChip name={authorName(c)} />
                        </div>
                        <dd className="min-w-0 break-words font-medium">
                          {c.subject || c.hash}
                          {c.isMerge ? <span className="ml-1 text-muted-foreground">merge</span> : null}
                        </dd>
                      </div>
                    ))}
                  </div>
                </dl>
              ) : (
                <dl className="space-y-2 text-xs">
                  <Row label="Commit" value={selected.hash} mono />
                  <Row label="Message" value={selected.subject || "—"} />
                  <Row label="Branch" value={selected.branch} />
                  <Row label="Timestamp" value={<TimeChip ts={selected.timestamp} withDate />} />
                  <Row label="Author" value={selected.author} />
                </dl>
              )}
            </CardContent>
          </Card>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <div className="min-w-0 shrink">
              <div className="text-sm font-medium">Network timeline</div>
              <div className="truncate text-[11px] text-muted-foreground">Scroll to zoom · drag to pan · double-click to reset</div>
            </div>
            {graph && (
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <div className="relative w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
                  <Input className="h-8 pl-8 pr-8 text-xs" value={msgQuery} placeholder="Search commits…" onChange={(e) => setMsgQuery(e.target.value)} />
                  <button
                    className={`absolute right-2 top-1.5 text-muted-foreground ${msgQuery ? "" : "invisible"}`}
                    onClick={() => setMsgQuery("")}
                    tabIndex={msgQuery ? 0 : -1}
                    aria-hidden={!msgQuery}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="flex gap-1">
                  {KIND_OPTS.map((k) => (
                    <Button
                      key={k.id}
                      variant="outline"
                      size="sm"
                      className={`h-8 w-[4.5rem] ${kinds.has(k.id) ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                      onClick={() => toggleIn(setKinds, k.id)}
                    >
                      {k.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2 tabular-nums">
                  <Badge variant="outline" className="w-[7.5rem] justify-center">{visibleGraph.branches.length}/{graph.branches.length} branches</Badge>
                  <Badge variant="outline" className="w-[6.25rem] justify-center">{visibleGraph.merges.length} merges</Badge>
                  <Badge variant="outline" className="w-[6.75rem] justify-center">{visibleGraph.commits.length} commits</Badge>
                </div>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1">
            {!graph ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <GitMerge className="size-10 opacity-40" />
                <p className="text-sm">Open a git repository to plot merge flow across branch swimlanes.</p>
              </div>
            ) : (
              <TimelineGraph
                graph={visibleGraph}
                focused={highlight}
                selectedHash={selected?.hash}
                onSelect={setSelected}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function Row({ label, value, mono }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-[11px]" : "break-words font-medium"}>{value}</dd>
    </div>
  )
}

function TimeChip({ ts, withDate }) {
  const text = withDate ? fmt(ts) : fmtTime(ts)
  return (
    <span className="inline-flex shrink-0 items-center rounded-md bg-amber-400 px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-slate-950">
      {text}
    </span>
  )
}

function AuthorChip({ name }) {
  return (
    <span className="inline-flex max-w-[8rem] shrink-0 items-center truncate rounded-md bg-sky-400 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-950" title={name}>
      {name}
    </span>
  )
}
