import { ChevronLeft, ChevronRight, ExternalLink, Filter, FolderOpen, GitBranch, GitMerge, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListBranches, LoadRepo, SelectRepo } from "../wailsjs/go/main/App";
import { BrowserOpenURL } from "../wailsjs/runtime/runtime";
import { TimelineGraph } from "./components/TimelineGraph";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
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

const BRANCH_OPTS = [
  { id: "feature", label: "Feature" },
  { id: "hotfix", label: "Hotfix" },
  { id: "epic", label: "Epic" },
  { id: "others", label: "Others" },
]

const ALL_KINDS = KIND_OPTS.map((k) => k.id)
const ALL_BRANCH_KINDS = BRANCH_OPTS.map((k) => k.id)

function branchKind(name) {
  const n = laneName(name).toLowerCase()
  if (/^(feature|feat)([/-]|$)/.test(n)) return "feature"
  if (/^hotfix([/-]|$)/.test(n)) return "hotfix"
  if (/^epic([/-]|$)/.test(n)) return "epic"
  return "others"
}

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

function localDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function wailsError(err) {
  if (!err) return "unknown error"
  if (typeof err === "string") return err
  return err.message || String(err)
}

function lanesByUpdated(list) {
  const latest = new Map()
  for (const b of list || []) {
    const name = laneName(b.name)
    const t = b.updated ? +new Date(b.updated) : 0
    if (!latest.has(name) || t > latest.get(name)) latest.set(name, t)
  }
  return [...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a))
}

const CHUNK_MONTHS = 5

function addMonths(ms, n) {
  const d = new Date(ms)
  d.setMonth(d.getMonth() + n)
  return +d
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function mergeGraphs(prev, chunk) {
  if (!prev) return chunk
  if (!chunk) return prev
  const seen = new Set((prev.commits || []).map((c) => c.hash))
  const commits = [...(prev.commits || [])]
  for (const c of chunk.commits || []) {
    if (!seen.has(c.hash)) commits.push(c)
  }
  const mseen = new Set((prev.merges || []).map((m) => `${m.hash}:${m.sourceHash}`))
  const merges = [...(prev.merges || [])]
  for (const m of chunk.merges || []) {
    const k = `${m.hash}:${m.sourceHash}`
    if (!mseen.has(k)) merges.push(m)
  }
  const bseen = new Set(prev.branches || [])
  const branches = [...(prev.branches || [])]
  for (const b of chunk.branches || []) {
    if (!bseen.has(b)) branches.push(b)
  }
  return { ...prev, branches, commits, merges }
}

function branchKey(names) {
  return [...names].sort().join("\n")
}

function chunkEmpty(chunk) {
  return !(chunk?.commits?.length || chunk?.merges?.length)
}

function viewCovered(loaded, from, to) {
  if (!loaded.from && !loaded.to) return false
  const slack = 1000
  return (from >= loaded.from - slack || loaded.pastDone) && (to <= loaded.to + slack || loaded.futureDone)
}

function monthQueue(loaded, want) {
  let n = 0
  if (!loaded.pastDone) {
    for (let t = loaded.from, i = 0; t > want.from && i < 200; i++) {
      t = addMonths(t, -CHUNK_MONTHS)
      n++
    }
  }
  const cap = Math.min(want.to, Date.now())
  if (!loaded.futureDone) {
    for (let t = loaded.to, i = 0; t < cap && i < 200; i++) {
      t = addMonths(t, CHUNK_MONTHS)
      n++
    }
  }
  return n
}

export default function App() {
  const [path, setPath] = useState("")
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [msgQuery, setMsgQuery] = useState("")
  const [hitIndex, setHitIndex] = useState(-1)
  const [jumpTo, setJumpTo] = useState(null)
  const [authorQuery, setAuthorQuery] = useState("")
  const [focused, setFocused] = useState("")
  const [selected, setSelected] = useState(null)
  const lastSelected = useRef(null)
  if (selected) lastSelected.current = selected
  const inspect = selected || lastSelected.current
  const [catalog, setCatalog] = useState([])
  const [axisRange, setAxisRange] = useState(null)
  const [branchLimit, setBranchLimit] = useState(5)
  const [branchSort, setBranchSort] = useState("updated")
  const [visible, setVisible] = useState(() => new Set())
  const [authors, setAuthors] = useState(() => new Set())
  const [kinds, setKinds] = useState(() => new Set(ALL_KINDS))
  const [branchKinds, setBranchKinds] = useState(() => new Set(ALL_BRANCH_KINDS))
  const [historyLeft, setHistoryLeft] = useState(0)
  const filterRef = useRef(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const pathRef = useRef(path)
  pathRef.current = path
  const loadSeq = useRef(0)
  const reloadTimer = useRef(0)
  const loadedRef = useRef({ from: 0, to: 0, branches: "", pastDone: false, futureDone: false, emptyPast: 0, emptyFuture: 0 })
  const wantRef = useRef({ from: 0, to: 0 })
  const filling = useRef(false)
  useEffect(() => {
    const close = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) filterRef.current.open = false
    }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [])

  async function load(nextPath, { reset = true, branches } = {}) {
    const target = (nextPath ?? path).trim()
    if (!target) {
      setError("Enter a repository path")
      return
    }
    const gen = ++loadSeq.current
    setLoading(true)
    setError("")
    if (reset) {
      setSelected(null)
      setFocused("")
    }
    try {
      let selected = branches
      if (reset) {
        const list = await ListBranches(target)
        if (gen !== loadSeq.current) return
        setCatalog(list)
        const names = lanesByUpdated(list)
        const n = Math.min(5, names.length)
        selected = names.slice(0, n)
        setBranchLimit(n || 1)
        setVisible(new Set(selected))
        setMsgQuery("")
        setAuthorQuery("")
        setKinds(new Set(ALL_KINDS))
        setBranchKinds(new Set(ALL_BRANCH_KINDS))
      } else if (!selected) {
        selected = [...visibleRef.current]
      }
      const now = Date.now()
      const viewTo = now
      const viewFrom = addMonths(now, -CHUNK_MONTHS)
      const from = reset || !loadedRef.current.from ? addMonths(now, -CHUNK_MONTHS) : loadedRef.current.from
      const to = reset || !loadedRef.current.to ? now : loadedRef.current.to
      if (reset || !loadedRef.current.from) {
        setAxisRange([viewFrom, viewTo])
        wantRef.current = { from: viewFrom, to: viewTo }
      }
      const data = await LoadRepo(target, selected, iso(from), iso(to))
      if (gen !== loadSeq.current) return
      loadedRef.current = { from, to, branches: branchKey(selected), pastDone: false, futureDone: false, emptyPast: 0, emptyFuture: 0 }
      setGraph(data)
      setPath(data.path || target)
      if (reset) {
        setAuthors(new Set((data.commits || []).map(authorName)))
      } else {
        setAuthors((prev) => {
          const next = new Set(prev)
          for (const c of data.commits || []) next.add(authorName(c))
          return next
        })
      }
    } catch (err) {
      if (gen !== loadSeq.current) return
      if (reset) {
        setGraph(null)
        setCatalog([])
      }
      setError(wailsError(err))
    } finally {
      if (gen === loadSeq.current) setLoading(false)
    }
  }

  function applyVisible(next, { debounce = false } = {}) {
    setVisible(next)
    window.clearTimeout(reloadTimer.current)
    const run = () => load(path, { reset: false, branches: [...next] })
    if (debounce) reloadTimer.current = window.setTimeout(run, 150)
    else run()
  }

  function addAuthors(commits) {
    setAuthors((prev) => {
      const next = new Set(prev)
      for (const c of commits || []) next.add(authorName(c))
      return next
    })
  }

  async function ensureRange(viewFrom, viewTo) {
    if (filling.current) return
    const selected = [...visibleRef.current]
    const key = branchKey(selected)
    const loaded = loadedRef.current
    if (loaded.branches && loaded.branches !== key) return
    wantRef.current = { from: viewFrom, to: viewTo }
    const left = monthQueue(loaded, wantRef.current)
    if (viewCovered(loaded, viewFrom, viewTo)) {
      if (!filling.current) setHistoryLeft(0)
      return
    }
    setHistoryLeft(left)
    filling.current = true
    const gen = loadSeq.current
    try {
      while (gen === loadSeq.current) {
        const cur = loadedRef.current
        const want = wantRef.current
        const queued = monthQueue(cur, want)
        setHistoryLeft(queued)
        if (cur.branches !== key || viewCovered(cur, want.from, want.to) || !queued) break
        const target = pathRef.current.trim()
        if (!target || !selected.length) break
        if (cur.from > want.from && !cur.pastDone) {
          const until = cur.from
          const since = addMonths(until, -CHUNK_MONTHS)
          const chunk = await LoadRepo(target, selected, iso(since), iso(until))
          if (gen !== loadSeq.current) return
          const empty = chunkEmpty(chunk)
          const emptyPast = empty ? cur.emptyPast + 1 : 0
          if (!empty) {
            setGraph((prev) => mergeGraphs(prev, chunk))
            addAuthors(chunk?.commits)
          }
          loadedRef.current = { ...loadedRef.current, from: since, emptyPast, pastDone: emptyPast >= 3 }
          continue
        }
        if (cur.to < want.to && !cur.futureDone) {
          const since = cur.to
          const until = Math.min(addMonths(since, CHUNK_MONTHS), Date.now())
          if (until <= since) {
            loadedRef.current = { ...loadedRef.current, futureDone: true }
            break
          }
          const chunk = await LoadRepo(target, selected, iso(since), iso(until))
          if (gen !== loadSeq.current) return
          const empty = chunkEmpty(chunk)
          const emptyFuture = empty ? cur.emptyFuture + 1 : 0
          if (!empty) {
            setGraph((prev) => mergeGraphs(prev, chunk))
            addAuthors(chunk?.commits)
          }
          loadedRef.current = { ...loadedRef.current, to: until, emptyFuture, futureDone: emptyFuture >= 3 }
          continue
        }
        break
      }
    } catch (err) {
      if (gen === loadSeq.current) setError(wailsError(err))
    } finally {
      filling.current = false
      setHistoryLeft(0)
    }
  }

  function onViewChange(from, to) {
    wantRef.current = { from, to }
    if (filling.current) return
    ensureRange(from, to)
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
    const names = lanesByUpdated(catalog)
    if (branchSort === "alpha") return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    return names
  }, [catalog, branchSort])

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
    const names = rankedBranches.filter((b) => visible.has(b) && branchKinds.has(branchKind(b)))
    const shown = new Set(names)
    const match = (c, kind) => authors.has(authorName(c)) && kinds.has(kind)
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
  }, [graph, rankedBranches, visible, authors, kinds, branchKinds])

  const searchHits = useMemo(() => {
    const msg = msgQuery.trim().toLowerCase()
    if (!msg || !visibleGraph) return []
    return visibleGraph.commits
      .filter((c) => String(c.subject || "").toLowerCase().includes(msg) || (c.tags || []).some((t) => String(t).toLowerCase().includes(msg)))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
  }, [visibleGraph, msgQuery])
  const matchHashes = useMemo(() => searchHits.map((c) => c.hash), [searchHits])
  const curHit = hitIndex >= 0 && hitIndex < searchHits.length ? hitIndex : -1

  function setCommitSearch(value) {
    setMsgQuery(value)
    setHitIndex(-1)
  }

  function goHit(dir) {
    const n = searchHits.length
    if (!n) return
    const i = curHit < 0 ? (dir > 0 ? 0 : n - 1) : (curHit + dir + n) % n
    const c = searchHits[i]
    const day = localDay(c.timestamp)
    const commits = visibleGraph.commits
      .filter((x) => x.branch === c.branch && localDay(x.timestamp) === day)
      .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
    setHitIndex(i)
    setSelected(commits.length > 1 ? { kind: "cluster", ...c, count: commits.length, commits } : { kind: "commit", ...c })
    setJumpTo({ hash: c.hash, n: (jumpTo?.n || 0) + 1 })
  }

  function showTop(n) {
    const count = Math.min(Math.max(n, 0), rankedBranches.length)
    setBranchLimit(count)
    applyVisible(new Set(rankedBranches.slice(0, count)), { debounce: true })
  }

  function toggleVisible(name) {
    const next = new Set(visible)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    applyVisible(next)
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

      <div className="no-drag relative flex min-h-0 flex-1 overflow-hidden">
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

          {rankedBranches.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Visible branches</label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {visible.size} / {rankedBranches.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={rankedBranches.length}
                  value={Math.min(branchLimit, rankedBranches.length)}
                  onChange={(e) => showTop(Number(e.target.value))}
                  className="h-2 w-full accent-primary"
                  title="Show top N by current sort"
                />
                <Input
                  type="number"
                  min={0}
                  max={rankedBranches.length}
                  value={Math.min(branchLimit, rankedBranches.length)}
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
                    onChange={() => toggleVisible(name)}
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
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <div className="flex min-w-0 items-end gap-2">
              <div className="min-w-0 shrink">
                <div className="text-sm font-medium">Network timeline</div>
                <div className="truncate text-[11px] text-muted-foreground">Scroll to zoom · drag to pan · double-click to reset</div>
              </div>
              {historyLeft > 0 && (
                <Badge className="mb-px shrink-0 gap-1.5 border-amber-400 bg-amber-400 text-slate-950">
                  <Loader2 className="size-3 animate-spin" />
                  Loading history…
                </Badge>
              )}
            </div>
            {graph && (
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <Button variant="outline" size="icon" className="size-8" onClick={() => load(path, { reset: false })} disabled={loading} title="Refresh graph">
                  <RefreshCw className={loading ? "animate-spin" : ""} />
                </Button>
                <div className="flex items-center gap-1">
                  <div className="relative w-52">
                    <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
                    <Input
                      className="h-8 pl-8 pr-8 text-xs"
                      value={msgQuery}
                      placeholder="Search commits…"
                      onChange={(e) => setCommitSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          goHit(e.shiftKey ? -1 : 1)
                        }
                      }}
                    />
                    <button
                      className={`absolute right-2 top-1.5 text-muted-foreground ${msgQuery ? "" : "invisible"}`}
                      onClick={() => setCommitSearch("")}
                      tabIndex={msgQuery ? 0 : -1}
                      aria-hidden={!msgQuery}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  {msgQuery.trim() ? (
                    <>
                      <span className="min-w-10 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
                        {searchHits.length ? (curHit < 0 ? searchHits.length : `${curHit + 1}/${searchHits.length}`) : "0"}
                      </span>
                      <Button variant="outline" size="icon" className="size-8" disabled={!searchHits.length} onClick={() => goHit(-1)} title="Previous match">
                        <ChevronLeft />
                      </Button>
                      <Button variant="outline" size="icon" className="size-8" disabled={!searchHits.length} onClick={() => goHit(1)} title="Next match">
                        <ChevronRight />
                      </Button>
                    </>
                  ) : null}
                </div>
                <details ref={filterRef} className="relative">
                  <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-border bg-transparent px-3 text-xs font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
                    <Filter className="size-4" />
                    Filters
                    <span className="tabular-nums text-muted-foreground">{kinds.size + branchKinds.size}/{ALL_KINDS.length + ALL_BRANCH_KINDS.length}</span>
                  </summary>
                  <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-border bg-card p-1 shadow-lg">
                    {KIND_OPTS.map((k) => (
                      <label key={k.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
                        <input
                          type="checkbox"
                          checked={kinds.has(k.id)}
                          onChange={() => toggleIn(setKinds, k.id)}
                          className="size-3.5 shrink-0 accent-primary"
                        />
                        {k.label}
                      </label>
                    ))}
                    <div className="my-1 border-t border-border" />
                    {BRANCH_OPTS.map((k) => (
                      <label key={k.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
                        <input
                          type="checkbox"
                          checked={branchKinds.has(k.id)}
                          onChange={() => toggleIn(setBranchKinds, k.id)}
                          className="size-3.5 shrink-0 accent-primary"
                        />
                        {k.label}
                      </label>
                    ))}
                  </div>
                </details>
                <div className="flex gap-2 tabular-nums">
                  <Badge variant="outline" className="w-[7.5rem] justify-center">{visibleGraph.branches.length}/{rankedBranches.length} branches</Badge>
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
                matchHashes={matchHashes}
                jumpTo={msgQuery.trim() ? jumpTo : null}
                onSelect={setSelected}
                rangeStart={axisRange?.[0]}
                rangeEnd={axisRange?.[1]}
                onViewChange={onViewChange}
              />
            )}
          </div>
        </main>

        <aside
          aria-hidden={!selected}
          className={`absolute inset-y-0 right-0 z-10 w-80 overflow-y-auto border-l border-border bg-background p-4 shadow-lg transition-transform duration-300 ease-out ${
            selected ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {inspect && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Inspector</h3>
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)} title="Close">
                  <X className="size-4" />
                </button>
              </div>
              {inspect.kind === "merge" ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Merge commit" value={inspect.hash} mono action={<CommitLink prefix={graph?.commitUrl} hash={inspect.hash} />} />
                  <Row label="Message" value={inspect.subject || "—"} />
                  {inspect.tags?.length ? <Row label="Tags" value={inspect.tags.join(" · ")} /> : null}
                  <Row label="Source branch" value={inspect.sourceBranch} />
                  <Row label="Target branch" value={inspect.targetBranch} />
                  <Row label="Timestamp" value={<TimeChip ts={inspect.timestamp} withDate />} />
                  <Row label="Author" value={inspect.author} />
                  <Row label="Commit count" value={String(inspect.commitCount)} />
                </dl>
              ) : inspect.kind === "cluster" ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Branch" value={inspect.branch} />
                  <Row label="Date" value={new Date(inspect.timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} />
                  <Row label="Commits" value={String(inspect.count)} />
                  <div className="space-y-2">
                    {(inspect.commits || []).map((c) => (
                      <div key={c.hash} className={`space-y-1 ${c.hash === inspect.hash ? "rounded-md bg-primary/15 p-1.5" : ""}`}>
                        <div className="flex items-center gap-2">
                          <TimeChip ts={c.timestamp} />
                          <AuthorChip name={authorName(c)} />
                          <CommitLink prefix={graph?.commitUrl} hash={c.hash} />
                        </div>
                        <dd className="min-w-0 break-words font-medium">
                          {c.subject || c.hash}
                          {c.isMerge ? <span className="ml-1 text-muted-foreground">merge</span> : null}
                          {c.tags?.length ? <span className="ml-1 text-amber-400">{c.tags.join(" · ")}</span> : null}
                        </dd>
                      </div>
                    ))}
                  </div>
                </dl>
              ) : (
                <dl className="space-y-2 text-xs">
                  <Row label="Commit" value={inspect.hash} mono action={<CommitLink prefix={graph?.commitUrl} hash={inspect.hash} />} />
                  <Row label="Message" value={inspect.subject || "—"} />
                  <Row label="Branch" value={inspect.branch} />
                  {inspect.tags?.length ? <Row label="Tags" value={inspect.tags.join(" · ")} /> : null}
                  <Row label="Timestamp" value={<TimeChip ts={inspect.timestamp} withDate />} />
                  <Row label="Author" value={inspect.author} />
                </dl>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function Row({ label, value, mono, action }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`flex items-start gap-1.5 ${mono ? "break-all font-mono text-[11px]" : "break-words font-medium"}`}>
        <span className="min-w-0">{value}</span>
        {action}
      </dd>
    </div>
  )
}

function CommitLink({ prefix, hash }) {
  if (!prefix || !hash) return null
  return (
    <button
      type="button"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title="Open commit"
      onClick={() => BrowserOpenURL(prefix + hash)}
    >
      <ExternalLink className="size-3.5" />
    </button>
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
