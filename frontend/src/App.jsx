import { Bug, ChevronLeft, ChevronRight, CloudDownload, ExternalLink, FolderOpen, GitBranch, GitMerge, Loader2, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FetchRemote, GetAIConfig, GetRemote, ListBranches, LoadRepo, SaveRemoteToken, SelectRepo } from "../wailsjs/go/main/App";
import { BrowserOpenURL } from "../wailsjs/runtime/runtime";
import { AIConfigDialog } from "./components/AIConfigDialog";
import { CommitChatDialog } from "./components/CommitChatDialog";
import { TimelineGraph } from "./components/TimelineGraph";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { branchColor, wailsError } from "./lib/utils";

function laneName(name) {
  return String(name || "").replace(/^refs\/(heads|remotes|tags)\//, "").replace(/^(origin|upstream)\//, "")
}

function authorName(c) {
  return c.author || "(unknown)"
}

// A compact, human-readable list of the commits in scope, passed to the AI so
// it knows which hashes the get_commit_diff tool may be asked about.
function commitChatContext(inspect) {
  const items = inspect?.kind === "cluster" ? inspect.commits || [] : inspect ? [inspect] : []
  return items
    .map((c) => {
      const meta = [c.hash, c.branch, authorName(c), c.timestamp ? new Date(c.timestamp).toISOString() : ""].filter(Boolean).join(" ")
      const merge = c.isMerge || c.sourceBranch ? " [merge]" : ""
      return `- ${meta}${merge} — ${c.subject || ""}${c.tags?.length ? ` (${c.tags.join(", ")})` : ""}`
    })
    .join("\n")
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

function lanesByUpdated(list) {
  const latest = new Map()
  for (const b of list || []) {
    const name = laneName(b.name)
    const t = b.updated ? +new Date(b.updated) : 0
    if (!latest.has(name) || t > latest.get(name)) latest.set(name, t)
  }
  return [...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a))
}

const CHUNK_MONTHS = 3

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
  const [remote, setRemote] = useState(null)
  const [token, setToken] = useState("")
  const [fetching, setFetching] = useState(false)
  const [remoteMsg, setRemoteMsg] = useState("")
  const [query, setQuery] = useState("")
  const [msgQuery, setMsgQuery] = useState("")
  const [hitIndex, setHitIndex] = useState(-1)
  const [jumpTo, setJumpTo] = useState(null)
  const [fitKey, setFitKey] = useState(0)
  const [colW, setColW] = useState(200)
  const [hideLongSelfEdge, setHideLongSelfEdge] = useState(false)
  const [collapseDay, setCollapseDay] = useState(false)
  const [authorQuery, setAuthorQuery] = useState("")
  const [focused, setFocused] = useState("")
  const [selected, setSelected] = useState(null)
  const lastSelected = useRef(null)
  if (selected) lastSelected.current = selected
  const inspect = selected || lastSelected.current
  const [catalog, setCatalog] = useState([])
  const [axisRange, setAxisRange] = useState(null)
  const [visible, setVisible] = useState(() => new Set())
  const [authors, setAuthors] = useState(() => new Set())
  const [historyLeft, setHistoryLeft] = useState(0)
  const [aiOpen, setAiOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [aiInfo, setAiInfo] = useState(null)
  const [showDebug, setShowDebug] = useState(false)
  const pathRef = useRef(path)
  pathRef.current = path
  const loadSeq = useRef(0)
  const loadedRef = useRef({ from: 0, to: 0, branches: "", pastDone: false, futureDone: false })
  const wantRef = useRef({ from: 0, to: 0 })
  const filling = useRef(false)
  async function refreshAI() {
    try {
      setAiInfo(await GetAIConfig())
    } catch {
      setAiInfo(null)
    }
  }

  useEffect(() => {
    refreshAI()
  }, [])

  async function load(nextPath) {
    const target = (nextPath ?? path).trim()
    if (!target) {
      setError("Enter a repository path")
      return
    }
    const gen = ++loadSeq.current
    setLoading(true)
    setError("")
    setSelected(null)
    setFocused("")
    try {
      const list = await ListBranches(target)
      if (gen !== loadSeq.current) return
      setCatalog(list)
      setVisible(new Set(lanesByUpdated(list).slice(0, 10)))
      setMsgQuery("")
      setAuthorQuery("")
      const now = Date.now()
      const from = addMonths(now, -CHUNK_MONTHS)
      const to = now
      setAxisRange([from, to])
      wantRef.current = { from, to }
      filling.current = false
      const data = await LoadRepo(target, [], iso(from), iso(to))
      if (gen !== loadSeq.current) return
      loadedRef.current = { from, to, pastDone: false, futureDone: false }
      setGraph(data)
      setFitKey((n) => n + 1)
      setPath(data.path || target)
      try {
        setRemote(await GetRemote(data.path || target))
      } catch {
        setRemote(null)
      }
      setAuthors(new Set((data.commits || []).map(authorName)))
    } catch (err) {
      if (gen !== loadSeq.current) return
      setGraph(null)
      setCatalog([])
      setRemote(null)
      setError(wailsError(err))
    } finally {
      if (gen === loadSeq.current) setLoading(false)
    }
  }

  function applyVisible(next) {
    setVisible(next)
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
    const loaded = loadedRef.current
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
        if (viewCovered(cur, want.from, want.to) || !queued) break
        const target = pathRef.current.trim()
        if (!target) break
        if (cur.from > want.from && !cur.pastDone) {
          const until = cur.from
          const since = addMonths(until, -CHUNK_MONTHS)
          const chunk = await LoadRepo(target, [], iso(since), iso(until))
          if (gen !== loadSeq.current) return
          const empty = chunkEmpty(chunk)
          if (!empty) {
            setGraph((prev) => mergeGraphs(prev, chunk))
            addAuthors(chunk?.commits)
          }
          loadedRef.current = { ...loadedRef.current, from: since, pastDone: empty }
          setAxisRange([since, loadedRef.current.to])
          continue
        }
        if (cur.to < want.to && !cur.futureDone) {
          const since = cur.to
          const until = Math.min(addMonths(since, CHUNK_MONTHS), Date.now())
          if (until <= since) {
            loadedRef.current = { ...loadedRef.current, futureDone: true }
            break
          }
          const chunk = await LoadRepo(target, [], iso(since), iso(until))
          if (gen !== loadSeq.current) return
          const empty = chunkEmpty(chunk)
          if (!empty) {
            setGraph((prev) => mergeGraphs(prev, chunk))
            addAuthors(chunk?.commits)
          }
          loadedRef.current = { ...loadedRef.current, to: until, futureDone: empty }
          setAxisRange([loadedRef.current.from, until])
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

  async function saveAuth() {
    if (!remote?.host) return
    try {
      await SaveRemoteToken(remote.host, token)
      setToken("")
      setRemoteMsg(token.trim() ? `Saved token for ${remote.host}` : `Removed token for ${remote.host}`)
      setRemote(await GetRemote(path))
    } catch (err) {
      setError(wailsError(err))
    }
  }

  async function fetchNow() {
    setFetching(true)
    setRemoteMsg("")
    try {
      await FetchRemote(path)
      setRemoteMsg(`Fetched ${remote?.name || "origin"}`)
      await load(path)
    } catch (err) {
      setError(wailsError(err))
    } finally {
      setFetching(false)
    }
  }

  const rankedBranches = useMemo(() => lanesByUpdated(catalog), [catalog])

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
    const merges = (graph.merges || []).map((m) => ({
      ...m,
      sourceBranch: laneName(m.sourceBranch),
      targetBranch: laneName(m.targetBranch),
    })).filter((m) => {
      const hidden = (n) => rankedBranches.includes(n) && !shown.has(n)
      if (hidden(m.targetBranch) || hidden(m.sourceBranch)) return false
      if (!(shown.has(m.targetBranch) || shown.has(m.sourceBranch))) return false
      return true
    })
    const srcByHash = new Map()
    // Look up source from all merges first so merge nodes keep their source
    // color even when the source branch lane is hidden.
    for (const m of graph.merges || []) {
      const src = laneName(m.sourceBranch)
      if (src && !srcByHash.has(m.hash)) srcByHash.set(m.hash, src)
    }
    for (const m of merges) {
      if (m.sourceBranch && !srcByHash.has(m.hash)) srcByHash.set(m.hash, m.sourceBranch)
    }
    return {
      ...graph,
      branches: names,
      commits: (graph.commits || []).map((c) => ({
        ...c,
        branch: laneName(c.branch),
        on: (c.on || [c.branch]).map(laneName),
        sourceBranch: c.isMerge ? srcByHash.get(c.hash) : undefined,
      })).filter((c) => shown.has(c.branch)),
      merges,
    }
  }, [graph, rankedBranches, visible])

  const searchHits = useMemo(() => {
    const msg = msgQuery.trim().toLowerCase()
    if (!msg || !visibleGraph) return []
    return visibleGraph.commits
      .filter((c) => String(c.subject || "").toLowerCase().includes(msg) || (c.tags || []).some((t) => String(t).toLowerCase().includes(msg)))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
  }, [visibleGraph, msgQuery])
  const matchHashes = useMemo(() => searchHits.map((c) => c.hash), [searchHits])
  const curHit = hitIndex >= 0 && hitIndex < searchHits.length ? hitIndex : -1
  const graphByHash = useMemo(() => new Map((graph?.commits || []).map((c) => [c.hash, c])), [graph])

  function setCommitSearch(value) {
    setMsgQuery(value)
    setHitIndex(-1)
  }

  function goHit(dir) {
    const n = searchHits.length
    if (!n) return
    const i = curHit < 0 ? (dir > 0 ? 0 : n - 1) : (curHit + dir + n) % n
    const c = searchHits[i]
    setHitIndex(i)
    // Collapsed mode shows one node per branch+day — select that whole day.
    if (collapseDay) {
      const day = localDay(c.timestamp)
      const commits = visibleGraph.commits
        .filter((x) => x.branch === c.branch && localDay(x.timestamp) === day)
        .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
      setSelected(commits.length > 1 ? { kind: "cluster", ...c, count: commits.length, commits } : { kind: "commit", ...c })
      setJumpTo({ hash: c.hash, n: (jumpTo?.n || 0) + 1 })
      return
    }
    // Merge commits are standalone nodes — select them individually.
    if (c.isMerge) {
      setSelected({ kind: "commit", ...c })
      setJumpTo({ hash: c.hash, n: (jumpTo?.n || 0) + 1 })
      return
    }
    // Normal commits cluster by branch+day, split into before/after segments
    // around that day's merges — select only the segment holding this hit.
    const day = localDay(c.timestamp)
    const dayMerges = visibleGraph.commits
      .filter((x) => x.isMerge && x.branch === c.branch && localDay(x.timestamp) === day)
      .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
    const segOf = (t) => {
      let seg = 0
      while (seg < dayMerges.length && +new Date(dayMerges[seg].timestamp) <= t) seg++
      return seg
    }
    const hitSeg = segOf(+new Date(c.timestamp))
    const commits = visibleGraph.commits
      .filter((x) => !x.isMerge && x.branch === c.branch && localDay(x.timestamp) === day && segOf(+new Date(x.timestamp)) === hitSeg)
      .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
    setSelected(commits.length > 1 ? { kind: "cluster", ...c, count: commits.length, commits } : { kind: "commit", ...c })
    setJumpTo({ hash: c.hash, n: (jumpTo?.n || 0) + 1 })
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
        <span className="ml-2 text-xs text-muted-foreground">Commit network by day</span>
        <div className="no-drag ml-auto flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => setAiOpen(true)}
            title={aiInfo?.provider ? `AI provider: ${aiInfo.provider}${aiInfo.model ? ` · ${aiInfo.model}` : ""}` : "Configure AI provider"}
          >
            <Sparkles />
            AI
            <span className={`size-1.5 rounded-full ${aiInfo?.provider ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
          </Button>
        </div>
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

          {remote && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Remote</label>
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-muted-foreground">{remote.name}</span>
                {remote.web ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 truncate text-left text-xs text-primary hover:underline"
                    title={remote.url}
                    onClick={() => BrowserOpenURL(remote.web)}
                  >
                    <span className="truncate">{remote.web.replace(/^https:\/\//, "")}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </button>
                ) : (
                  <span className="truncate font-mono text-[11px]">{remote.url}</span>
                )}
              </div>
              <Button className="w-full" variant="outline" onClick={fetchNow} disabled={fetching || loading} title={remote.ssh ? "Uses your SSH keys" : remote.hasToken ? `Uses saved token for ${remote.host}` : "Uses git credentials"}>
                {fetching ? <Loader2 className="animate-spin" /> : <CloudDownload />}
                {fetching ? "Fetching…" : `Fetch ${remote.name}`}
              </Button>
              {remote.host && (
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    placeholder={remote.hasToken ? "Token saved — paste to replace" : "PAT / access token"}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveAuth()}
                  />
                  <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={saveAuth} disabled={!token.trim() && !remote.hasToken}>
                    {token.trim() ? "Save" : "Clear"}
                  </Button>
                </div>
              )}
              {remote.ssh && (
                <p className="text-[11px] text-muted-foreground">Fetch uses SSH keys. A token is stored for this host for HTTPS/API later.</p>
              )}
              {remoteMsg && <p className="text-[11px] text-muted-foreground">{remoteMsg}</p>}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Branches</label>
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
                  <span className="size-2 shrink-0 rounded-full" style={{ background: branchColor(name) }} />
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
                <div className="text-sm font-medium">Commit network</div>
                <div className="truncate text-[11px] text-muted-foreground">Equal day columns · pan past an end to load more · scroll to zoom · double-click to reset</div>
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
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
                  title="For merges where both parents are on the same branch, hide the longer of the two parent edges"
                >
                  <input
                    type="checkbox"
                    checked={hideLongSelfEdge}
                    onChange={(e) => setHideLongSelfEdge(e.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Trim self-merges
                </label>
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
                  title="Collapse merges and commits into a single node per branch per day"
                >
                  <input
                    type="checkbox"
                    checked={collapseDay}
                    onChange={(e) => setCollapseDay(e.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  One cluster/day
                </label>
                <div className="flex items-center gap-2" title="Day column spacing (x-axis gap)">
                  <span className="text-[11px] text-muted-foreground">X-gap</span>
                  <input
                    type="range"
                    min={100}
                    max={320}
                    step={4}
                    value={colW}
                    onChange={(e) => setColW(Number(e.target.value))}
                    className="w-24 accent-primary"
                  />
                  <Input
                    className="h-8 w-16 px-2 text-xs tabular-nums"
                    type="number"
                    min={60}
                    max={400}
                    step={4}
                    value={colW}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isNaN(v)) setColW(Math.min(400, Math.max(60, Math.round(v))))
                    }}
                  />
                </div>
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
                <div className="flex gap-2 tabular-nums">
                  <Badge variant="outline" className="w-[7.5rem] justify-center">{visibleGraph.branches.length} branches</Badge>
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
                <p className="text-sm">Open a git repository to plot the last 3 months as a commit network.</p>
              </div>
            ) : (
              <TimelineGraph
                graph={visibleGraph}
                focused={highlight}
                selectedAuthors={authors.size < authorList.length ? authors : null}
                selectedHash={selected?.hash}
                matchHashes={matchHashes}
                jumpTo={msgQuery.trim() ? jumpTo : null}
                onSelect={setSelected}
                showTags
                rangeStart={axisRange?.[0]}
                rangeEnd={axisRange?.[1]}
                onViewChange={onViewChange}
                fitKey={fitKey}
                colW={colW}
                hideLongSelfEdge={hideLongSelfEdge}
                collapseDay={collapseDay}
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
              <div className="mb-3 flex items-center justify-between gap-1">
                <h3 className="text-sm font-semibold">Inspector</h3>
                <div className="flex items-center gap-1">
                  {aiInfo?.provider && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setChatOpen(true)}
                      title="Ask the AI about these commits"
                    >
                      <Sparkles />
                      Ask AI
                    </Button>
                  )}
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)} title="Close">
                    <X className="size-4" />
                  </button>
                </div>
              </div>
              <label className="mb-2 flex cursor-pointer items-center justify-between rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Bug className="size-3.5" />
                  Debug parents
                </span>
                <input
                  type="checkbox"
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                  className="size-3.5 accent-primary"
                />
              </label>
              {inspect.kind === "merge" ? (
                <dl className="space-y-2 text-xs">
                  <Row label="Merge commit" value={inspect.hash} mono action={<CommitLink prefix={graph?.commitUrl} hash={inspect.hash} />} />
                  <Row label="Message" value={<span className="font-medium" style={{ color: branchColor(inspect.sourceBranch) }}>{inspect.subject || "—"}</span>} />
                  {showDebug && <DebugParents commitHash={inspect.hash} fallbackParents={inspect.parents} extraHash={inspect.sourceHash} byHash={graphByHash} />}
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
                        <dd className="min-w-0 break-words font-medium" style={c.isMerge ? { color: branchColor(c.sourceBranch) } : undefined}>
                          {c.subject || c.hash}
                          {c.isMerge ? <span className="ml-1 opacity-70">merge</span> : null}
                          {c.tags?.length ? <span className="ml-1 text-amber-400">{c.tags.join(" · ")}</span> : null}
                        </dd>
                        {showDebug && <DebugParents commitHash={c.hash} fallbackParents={c.parents} byHash={graphByHash} />}
                      </div>
                    ))}
                  </div>
                </dl>
              ) : (
                <dl className="space-y-2 text-xs">
                  <Row label="Commit" value={inspect.hash} mono action={<CommitLink prefix={graph?.commitUrl} hash={inspect.hash} />} />
                  <Row label="Message" value={inspect.isMerge ? <span className="font-medium" style={{ color: branchColor(inspect.sourceBranch) }}>{inspect.subject || "—"}</span> : (inspect.subject || "—")} />
                  {showDebug && <DebugParents commitHash={inspect.hash} fallbackParents={inspect.parents} byHash={graphByHash} />}
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

      {aiOpen && (
        <AIConfigDialog
          onClose={() => {
            setAiOpen(false)
            refreshAI()
          }}
          onSaved={refreshAI}
        />
      )}
      {chatOpen && inspect && (
        <CommitChatDialog path={graph?.path || path} context={commitChatContext(inspect)} onClose={() => setChatOpen(false)} />
      )}
    </div>
  )
}

function DebugParents({ commitHash, fallbackParents, extraHash, byHash }) {
  const full = byHash?.get(commitHash)
  const parents = full?.parents?.length ? full.parents : fallbackParents || []
  const allParents = [...parents]
  if (extraHash && !allParents.includes(extraHash)) allParents.push(extraHash)
  return (
    <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
      <div className="break-all" title={commitHash}>
        commit {commitHash}
      </div>
      {!allParents.length && <div>no parents (root or unloaded)</div>}
      {allParents.map((p, i) => {
        const n = byHash?.get(p)
        const branches = n ? [...new Set((n.on?.length ? n.on : n.branch ? [n.branch] : []).map(laneName))] : null
        return (
          <div key={`${commitHash}:${p}`} className="break-all" title={p}>
            P{i + 1} {String(p).slice(0, 7)} · {branches ? (branches.length ? branches.join(", ") : "(no branch)") : "outside loaded range"}
          </div>
        )
      })}
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
