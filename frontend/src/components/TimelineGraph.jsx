import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { branchColor } from "../lib/utils";

const LANE_H = 88
const DEFAULT_COL_W = 200
const START_R = 18
const MARGIN = { top: 48, right: 56, bottom: 36, left: 36 }

function viewAt(width, height, x, y) {
  const ty = y > height - LANE_H ? height / 2 - y : 0
  return d3.zoomIdentity.translate(width - MARGIN.right - x, ty)
}

function laneName(name) {
  return String(name || "").replace(/^refs\/(heads|remotes|tags)\//, "").replace(/^(origin|upstream)\//, "")
}

function localDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function clusterKey(branch, ts) {
  return `${branch}\0${localDay(ts)}`
}

function nodeId(g) {
  if (!g) return ""
  if (g.isSingleMerge) return `m\0${g.hash}`
  const base = clusterKey(g.branch, g.timestamp)
  return g._seg != null ? `c\0${base}\0${g._seg}` : `c\0${base}`
}

function clusterByDay(commits, collapseDay = false) {
  const map = new Map()
  if (collapseDay) {
    // Single node per (branch, day): merges + normal commits together.
    const byDay = new Map()
    for (const c of commits) {
      const key = clusterKey(c.branch, c.timestamp)
      let arr = byDay.get(key)
      if (!arr) {
        arr = []
        byDay.set(key, arr)
      }
      arr.push(c)
    }
    for (const [key, arr] of byDay.entries()) {
      const sorted = arr.slice().sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp) || String(a.hash).localeCompare(String(b.hash)))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const g = {
        ...first,
        hash: last.hash,
        timestamp: last.timestamp,
        subject: last.subject,
        author: last.author,
        count: sorted.length,
        commits: sorted,
        merges: [],
        tags: [...new Set(sorted.flatMap((c) => c.tags || []))],
        isMerge: sorted.some((c) => c.isMerge),
        isSingleMerge: false,
      }
      // A multi-commit day represents the whole lane: keep lane color.
      // Only a lone merge keeps its source-branch color.
      if (sorted.length > 1) delete g.sourceBranch
      map.set(`c\0${key}`, g)
    }
    for (const g of map.values()) {
      g._slot = 0
      g._slots = 1
      g._center = 0
    }
    return map
  }
  const mergesByDay = new Map()
  const normalsByDay = new Map()
  for (const c of commits) {
    const key = clusterKey(c.branch, c.timestamp)
    if (c.isMerge) {
      let arr = mergesByDay.get(key)
      if (!arr) {
        arr = []
        mergesByDay.set(key, arr)
      }
      arr.push(c)
    } else {
      let arr = normalsByDay.get(key)
      if (!arr) {
        arr = []
        normalsByDay.set(key, arr)
      }
      arr.push(c)
    }
  }
  // Merge commits always get their own individual node — never clustered.
  for (const arr of mergesByDay.values()) {
    for (const c of arr) {
      const key = `m\0${c.hash}`
      if (!map.has(key)) {
        map.set(key, { ...c, count: 1, commits: [c], merges: [], tags: [...(c.tags || [])], isSingleMerge: true, isMerge: true })
      }
    }
  }
  // Normal commits are clustered by branch + day, but split into
  // before / between / after segments around that day's merges so the
  // left-to-right time sequence stays correct.
  for (const [dayKey, arr] of normalsByDay.entries()) {
    const dayMerges = (mergesByDay.get(dayKey) || [])
      .slice()
      .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp) || String(a.hash).localeCompare(String(b.hash)))
    const sorted = arr.slice().sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp) || String(a.hash).localeCompare(String(b.hash)))
    // Bucket each normal commit by how many of the day's merges precede it.
    const segments = dayMerges.length ? Array.from({ length: dayMerges.length + 1 }, () => []) : [[]]
    if (!dayMerges.length) {
      segments[0] = sorted
    } else {
      const mergeTimes = dayMerges.map((m) => +new Date(m.timestamp))
      for (const c of sorted) {
        const t = +new Date(c.timestamp)
        let seg = 0
        while (seg < mergeTimes.length && mergeTimes[seg] <= t) seg++
        segments[seg].push(c)
      }
    }
    segments.forEach((bucket, segIdx) => {
      if (!bucket.length) return
      const key = dayMerges.length ? `c\0${dayKey}\0${segIdx}` : `c\0${dayKey}`
      let g = map.get(key)
      if (!g) {
        const first = bucket[0]
        g = { ...first, count: 0, commits: [], merges: [], tags: [] }
        if (dayMerges.length) g._seg = segIdx
        map.set(key, g)
      }
      for (const c of bucket) {
        g.commits.push(c)
        g.count++
        for (const t of c.tags || []) {
          if (!g.tags.includes(t)) g.tags.push(t)
        }
        if (+new Date(c.timestamp) >= +new Date(g.timestamp)) {
          g.hash = c.hash
          g.timestamp = c.timestamp
          g.subject = c.subject
          g.author = c.author
        }
      }
    })
  }
  for (const g of map.values()) {
    g.commits.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
  }
  // Assign intra-day x offsets in true time order. Nodes sharing a
  // (branch, day) column are sorted by timestamp left-to-right; when the
  // group contains merge(s), the merge time-center is pinned to the day's
  // vertical line (offset 0) so before-clusters sit left and after-clusters
  // sit right — keeping the time sequence correct.
  const groups = new Map()
  for (const g of map.values()) {
    const key = clusterKey(g.branch, g.timestamp)
    let arr = groups.get(key)
    if (!arr) {
      arr = []
      groups.set(key, arr)
    }
    arr.push(g)
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp) || String(a.hash).localeCompare(String(b.hash)))
    const n = arr.length
    const mergeIdx = arr.map((g, i) => (g.isSingleMerge ? i : -1)).filter((i) => i >= 0)
    const center = mergeIdx.length ? mergeIdx.reduce((s, i) => s + i, 0) / mergeIdx.length : (n - 1) / 2
    arr.forEach((g, i) => {
      g._slot = i
      g._slots = n
      g._center = center
    })
  }
  return map
}

function fmtDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function addMonths(ms, n) {
  const d = new Date(ms)
  d.setMonth(d.getMonth() + n)
  return +d
}

function shorten(x1, y1, x2, y2, a, b) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  return {
    x1: x1 + (dx / len) * a,
    y1: y1 + (dy / len) * a,
    x2: x2 - (dx / len) * b,
    y2: y2 - (dy / len) * b,
  }
}

function signedTrack(t) {
  if (!t) return 0
  return (t % 2 === 1 ? 1 : -1) * Math.ceil(t / 2)
}

function nodeColor(d) {
  // Merge nodes sit on the target lane but represent the incoming (source)
  // branch, so they take the source branch color.
  if (d?.isMerge) return branchColor(d.sourceBranch || d.branch)
  return branchColor(d.branch)
}

function edgeCurve(x1, y1, x2, y2, bend = 0) {
  const dx = x2 - x1
  const dy = y2 - y1
  if (Math.abs(dy) < 6) {
    // Same-lane hump must respect the track offset, otherwise all parallel
    // same-lane edges draw the identical hump and overlap exactly.
    const dir = dx >= 0 ? -1 : 1
    const h = dir * (bend ? Math.min(Math.abs(bend), 52) : 26)
    return `M ${x1} ${y1} C ${x1 + dx / 3} ${y1 + h}, ${x1 + (2 * dx) / 3} ${y2 + h}, ${x2} ${y2}`
  }
  const mx = (x1 + x2) / 2 + bend
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

function xOverlap(a, b, pad = 4) {
  const a0 = Math.min(a.x1, a.x2) - pad, a1 = Math.max(a.x1, a.x2) + pad
  const b0 = Math.min(b.x1, b.x2) - pad, b1 = Math.max(b.x1, b.x2) + pad
  return a0 < b1 && b0 < a1
}

function yOverlap(a, b, pad = 8) {
  const a0 = Math.min(a.y1, a.y2) - pad, a1 = Math.max(a.y1, a.y2) + pad
  const b0 = Math.min(b.y1, b.y2) - pad, b1 = Math.max(b.y1, b.y2) + pad
  return a0 < b1 && b0 < a1
}

function yTracks(pts, colW) {
  const track = Array(pts.length).fill(0)
  // Cross-lane edges: conflict when y-spans overlap and x-midpoints are close.
  const cross = pts.map((_, i) => i).filter((i) => Math.abs(pts[i].y2 - pts[i].y1) >= 6 && Math.abs(pts[i].x2 - pts[i].x1) >= 6)
  cross.sort((i, j) => pts[i].x1 + pts[i].x2 - (pts[j].x1 + pts[j].x2))
  for (let a = 0; a < cross.length; a++) {
    const i = cross[a]
    const used = new Set()
    for (let b = 0; b < a; b++) {
      const j = cross[b]
      const am = (pts[i].x1 + pts[i].x2) / 2
      const bm = (pts[j].x1 + pts[j].x2) / 2
      if (Math.abs(am - bm) >= colW / 2) continue
      if (yOverlap(pts[i], pts[j])) used.add(track[j])
    }
    let t = 0
    while (used.has(t)) t++
    track[i] = t
  }
  // Same-lane edges: previously all got track 0 (identical humps / collinear
  // straight lines). Conflict when on the same lane and x-spans overlap.
  const same = pts.map((_, i) => i).filter((i) => Math.abs(pts[i].y2 - pts[i].y1) < 6 && Math.abs(pts[i].x2 - pts[i].x1) >= 6)
  same.sort((i, j) => Math.min(pts[i].x1, pts[i].x2) - Math.min(pts[j].x1, pts[j].x2))
  for (let a = 0; a < same.length; a++) {
    const i = same[a]
    const used = new Set()
    for (let b = 0; b < a; b++) {
      const j = same[b]
      if (Math.abs(pts[i].y1 - pts[j].y1) >= 6) continue
      if (xOverlap(pts[i], pts[j])) used.add(track[j])
    }
    let t = 0
    while (used.has(t)) t++
    track[i] = t
  }
  return track
}

function clipLabel(s, n = 28) {
  s = String(s || "")
  return s.length > n ? `${s.slice(0, n - 2)}…` : s
}

function diamondPath(r) {
  return `M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`
}

function branchStartKeys(clusters, branches) {
  const keys = new Set()
  for (const name of branches) {
    // Branch start marker goes on the earliest *normal* day-cluster, never on
    // a standalone merge node, so merges keep their merge styling.
    let best = null
    let bestT = Infinity
    for (const g of clusters) {
      if (g.branch !== name || g.isSingleMerge) continue
      const t = +new Date(g.commits[0]?.timestamp || g.timestamp)
      if (t < bestT) {
        bestT = t
        best = g
      }
    }
    if (!best) {
      for (const g of clusters) {
        if (g.branch !== name) continue
        const t = +new Date(g.commits[0]?.timestamp || g.timestamp)
        if (t < bestT) {
          bestT = t
          best = g
        }
      }
    }
    if (best) keys.add(nodeId(best))
  }
  return keys
}

function addEdge(edges, src, dst, names, commit) {
  if (!src || !dst || src === dst) return
  const key = `${nodeId(src)}->${nodeId(dst)}`
  let e = edges.get(key)
  if (!e) {
    e = { src, dst, branches: new Set(), commits: [] }
    edges.set(key, e)
  }
  for (const n of names) {
    if (n) e.branches.add(n)
  }
  const extra = commit?.commits || (commit ? [commit] : [])
  for (const c of extra) {
    if (c?.hash && !e.commits.some((x) => x.hash === c.hash)) e.commits.push(c)
  }
}

function buildEdges(clusters, commits, branches, merges) {
  const byKey = new Map()
  for (const g of clusters) {
    const k = clusterKey(g.branch, g.timestamp)
    // Multiple nodes (merges + day cluster) can share a day column; keep the earliest.
    if (!byKey.has(k)) byKey.set(k, g)
  }
  const byHash = new Map()
  for (const g of clusters) {
    for (const c of g.commits) {
      if (!byHash.has(c.hash)) byHash.set(c.hash, g)
    }
  }
  const allow = new Set(branches)
  const edges = new Map()
  let linked = false
  for (const c of commits) {
    const dst = byHash.get(c.hash)
    const parents = c.parents || []
    for (let i = 0; i < parents.length; i++) {
      const src = byHash.get(parents[i])
      if (!src || !dst) continue
      linked = true
      const names = (c.on || [c.branch]).filter((n) => allow.has(n))
      if (!names.length) continue
      addEdge(edges, src, dst, names, c)
    }
  }
  if (!linked) {
    d3.group(clusters, (c) => c.branch).forEach((nodes) => {
      nodes.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
      for (let i = 1; i < nodes.length; i++) addEdge(edges, nodes[i - 1], nodes[i], [nodes[i].branch], nodes[i])
    })
    for (const m of merges) {
      if (!allow.has(m.sourceBranch) || !allow.has(m.targetBranch)) continue
      addEdge(
        edges,
        byKey.get(clusterKey(m.sourceBranch, m.timestamp)) || byHash.get(m.sourceHash),
        byKey.get(clusterKey(m.targetBranch, m.timestamp)) || byHash.get(m.hash),
        [m.sourceBranch, m.targetBranch],
        m,
      )
    }
  }
  return [...edges.values()].map((e) => ({ ...e, branches: [...e.branches].sort() }))
}

// For self-branch merges (merge node + all incoming edges on the same lane),
// the two parent edges overlap on one lane. Drop the visually longest one to
// reduce clutter. Runs on laid-out points so "longest" is screen distance.
function pruneLongSelfMergeEdges(pts) {
  const byDst = new Map()
  pts.forEach((p, i) => {
    const key = nodeId(p?.e?.dst)
    if (!key) return
    let arr = byDst.get(key)
    if (!arr) {
      arr = []
      byDst.set(key, arr)
    }
    arr.push(i)
  })
  const drop = new Set()
  const survivorByDst = new Map()
  for (const idxs of byDst.values()) {
    if (idxs.length < 2) continue
    const dst = pts[idxs[0]].e.dst
    if (!dst?.isMerge) continue
    if (!idxs.every((i) => pts[i].e.src.branch === dst.branch)) continue
    let longest = idxs[0]
    let longestLen = -1
    for (const i of idxs) {
      const p = pts[i]
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1)
      if (len > longestLen) {
        longestLen = len
        longest = i
      }
    }
    drop.add(longest)
    survivorByDst.set(nodeId(dst), idxs.filter((i) => i !== longest))
  }
  if (!drop.size) return pts
  // Fold dropped edges' branches/commits into a survivor so author/related
  // filtering still sees them.
  for (const [dstKey, survivors] of survivorByDst.entries()) {
    void dstKey
    if (!survivors.length) continue
    const keep = pts[survivors[0]].e
    for (const i of [...drop]) {
      const e = pts[i]?.e
      if (!e || nodeId(e.dst) !== nodeId(keep.dst)) continue
      for (const b of e.branches || []) {
        if (b && !keep.branches.includes(b)) keep.branches.push(b)
      }
      for (const c of e.commits || []) {
        if (c?.hash && !keep.commits.some((x) => x.hash === c.hash)) keep.commits.push(c)
      }
    }
  }
  return pts.filter((_, i) => !drop.has(i))
}

export function TimelineGraph({ graph, focused, onSelect, selectedHash, matchHashes, selectedAuthors, jumpTo, showTags, rangeStart, rangeEnd, onViewChange, fitKey, colW = DEFAULT_COL_W, hideLongSelfEdge = true, collapseDay = true, hideOrphanMerges = true }) {
  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const zoomRef = useRef(d3.zoomIdentity)
  const zoomKeyRef = useRef("")
  const anchorRef = useRef(null)
  const jumpKeyRef = useRef("")
  const viewCb = useRef(onViewChange)
  viewCb.current = onViewChange
  const rangeRef = useRef({ start: rangeStart, end: rangeEnd })
  rangeRef.current = { start: rangeStart, end: rangeEnd }
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [tip, setTip] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width < 80 || height < 80) return
      setSize((prev) => (Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const related = useMemo(() => {
    if (!focused || !graph) return null
    const set = new Set([focused])
    for (const m of graph.merges || []) {
      const src = laneName(m.sourceBranch)
      const dst = laneName(m.targetBranch)
      if (src === focused) set.add(dst)
      if (dst === focused) set.add(src)
    }
    return set
  }, [focused, graph])

  useEffect(() => {
    const svgEl = svgRef.current
    const svg = d3.select(svgEl)
    svg.selectAll("*").remove()
    if (!graph?.branches?.length || size.w < 80 || size.h < 80) return

    const branches = [...new Set(graph.branches.map(laneName))]
    let commits = graph.commits.map((c) => ({ ...c, branch: laneName(c.branch), on: (c.on || [c.branch]).map(laneName) })).filter((c) => branches.includes(c.branch))
    let merges = (graph.merges || []).map((m) => ({ ...m, sourceBranch: laneName(m.sourceBranch), targetBranch: laneName(m.targetBranch) }))
    if (hideOrphanMerges) {
      // Same orphan rule as the sidebar counts: a merge with no parent in the
      // loaded set and no loaded child pointing at it has no drawable edge
      // (typically the merged branch was deleted).
      const hashSet = new Set(commits.map((c) => c.hash))
      const hasChild = new Set()
      for (const c of commits) {
        for (const p of c.parents || []) {
          if (hashSet.has(p)) hasChild.add(p)
        }
      }
      const orphan = new Set(
        commits.filter((c) => c.isMerge && !(c.parents || []).some((p) => hashSet.has(p)) && !hasChild.has(c.hash)).map((c) => c.hash),
      )
      if (orphan.size) {
        commits = commits.filter((c) => !orphan.has(c.hash))
        merges = merges.filter((m) => !orphan.has(m.hash))
      }
    }
    const clusterMap = clusterByDay(commits, collapseDay)
    const clusters = [...clusterMap.values()]
    const mergeNodeByHash = new Map()
    const dayClusterByKey = new Map()
    for (const g of clusters) {
      if (g.isSingleMerge) {
        if (!mergeNodeByHash.has(g.hash)) mergeNodeByHash.set(g.hash, g)
      } else if (!dayClusterByKey.has(clusterKey(g.branch, g.timestamp))) {
        // A day may now hold several before/after segments; keep the earliest
        // for legacy merge-event fallback lookups.
        dayClusterByKey.set(clusterKey(g.branch, g.timestamp), g)
      }
    }
    for (const m of merges) {
      if (m.kind === "branch") continue
      const target =
        mergeNodeByHash.get(m.hash) ||
        dayClusterByKey.get(clusterKey(m.targetBranch, m.timestamp)) ||
        dayClusterByKey.get(clusterKey(m.sourceBranch, m.timestamp))
      target?.merges.push(m)
    }
    const edges = buildEdges(clusters, commits, branches, merges)
    const startKeys = branchStartKeys(clusters, branches)
    const isStart = (d) => startKeys.has(nodeId(d))

    const dayMin = new Map()
    for (const g of clusters) {
      const k = localDay(g.timestamp)
      const t = +new Date(g.timestamp)
      if (!dayMin.has(k) || t < dayMin.get(k).t) dayMin.set(k, { t, ts: g.timestamp })
    }
    const days = [...dayMin.entries()].sort((a, b) => a[1].t - b[1].t)
    const dayIndex = new Map(days.map(([k], i) => [k, i]))

    const width = size.w
    const height = size.h
    const cw = Number(colW) || DEFAULT_COL_W
    const yOf = (name) => {
      const i = branches.indexOf(name)
      return i < 0 ? undefined : MARGIN.top + i * LANE_H + LANE_H / 2
    }
    const xBase = (ts) => MARGIN.left + (dayIndex.get(localDay(ts)) ?? 0) * cw
    // Merge nodes sit exactly on the day's vertical line (offset 0);
    // before/after commit segments are offset left/right in time order.
    // _slot/_center are time-order ranks within the (branch, day) group.
    const slotOffset = (d) => {
      const n = d?._slots || 1
      if (n < 2) return 0
      const step = Math.min(44, Math.max(32, (cw - 80) / (n - 1)))
      const center = d?._center ?? (n - 1) / 2
      return ((d._slot || 0) - center) * step
    }
    const xOfNode = (d) => xBase(d.timestamp) + slotOffset(d)
    const plotBottom = MARGIN.top + Math.max(branches.length, 1) * LANE_H
    const dim = (branch) => (related && !related.has(branch) ? 0.12 : 1)
    const firstX = MARGIN.left
    const lastX = MARGIN.left + Math.max(days.length - 1, 0) * cw
    let latest = clusters[0]
    for (const g of clusters) {
      if (+new Date(g.timestamp) > +new Date(latest.timestamp)) latest = g
    }
    const latestView = latest
      ? viewAt(width, height, xOfNode(latest), yOf(latest.branch) ?? height / 2)
      : d3.zoomIdentity

    if (zoomKeyRef.current !== fitKey) {
      zoomRef.current = latestView
      zoomKeyRef.current = fitKey
      anchorRef.current = null
    } else if (anchorRef.current) {
      const { key, k, y, sx } = anchorRef.current
      const i = days.findIndex(([d]) => d === key)
      if (i >= 0) {
        const wx = MARGIN.left + i * cw
        zoomRef.current = d3.zoomIdentity.translate(sx - wx * k, y).scale(k)
      }
    }

    svg.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`).style("cursor", "grab")

    const defs = svg.append("defs")
    defs.append("clipPath").attr("id", "net-clip").append("rect").attr("width", width).attr("height", height)
    defs.append("style").text(`
      @keyframes merge-dash { to { stroke-dashoffset: -14; } }
      @keyframes fork-dash { to { stroke-dashoffset: -24; } }
      .merge-edge { stroke-dasharray: 8 6; animation: merge-dash 0.55s linear infinite; }
      .fork-edge { stroke-dasharray: 18 6; animation: fork-dash 0.7s linear infinite; }
    `)

    svg.append("rect").attr("width", width).attr("height", height).attr("fill", "#0b1220")
    const world = svg.append("g").attr("clip-path", "url(#net-clip)").append("g")

    days.forEach(([, info], i) => {
      const x = MARGIN.left + i * cw
      world.append("line")
        .attr("x1", x).attr("x2", x)
        .attr("y1", MARGIN.top)
        .attr("y2", plotBottom)
        .attr("stroke", "#334155")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4 6")
      world.append("text")
        .attr("x", x)
        .attr("y", MARGIN.top - 14)
        .attr("text-anchor", "middle")
        .attr("fill", "#94a3b8")
        .attr("font-size", 10)
        .text(fmtDay(info.ts))
    })

    const pts = edges.map((e) => {
      const s = { x: xOfNode(e.src), y: yOf(e.src.branch) }
      const d = { x: xOfNode(e.dst), y: yOf(e.dst.branch) }
      if (s.y == null || d.y == null) return null
      const fork = isStart(e.dst) && e.src.branch !== e.dst.branch
      const r1 = isStart(e.src) ? START_R : e.src.count > 1 ? 11 : 7
      const r2 = isStart(e.dst) ? START_R : e.dst.count > 1 ? 11 : 7
      return { e, fork, x1: s.x, y1: s.y, x2: d.x, y2: d.y, r1, r2 }
    }).filter(Boolean)
    const visiblePts = hideLongSelfEdge ? pruneLongSelfMergeEdges(pts) : pts
    const tracks = yTracks(visiblePts, cw)
    const laid = visiblePts.map((p, i) => {
      const sameDay = localDay(p.e.src.timestamp) === localDay(p.e.dst.timestamp)
      const merge = !p.fork && p.e.src.branch !== p.e.dst.branch
      const sameLane = Math.abs(p.y2 - p.y1) < 6
      const bend = 26 + signedTrack(tracks[i]) * 16
      const q = shorten(p.x1, p.y1, p.x2, p.y2, p.r1, p.r2)
      let d
      if (p.fork) {
        d = `M ${q.x1} ${q.y1} L ${q.x2} ${q.y2}`
      } else if (sameDay && !merge) {
        // Collinear same-lane same-day edges overlap exactly when straight;
        // lift conflicting ones into a shallow hump via their track offset.
        d = tracks[i] > 0 && sameLane
          ? edgeCurve(q.x1, q.y1, q.x2, q.y2, bend)
          : `M ${q.x1} ${q.y1} L ${q.x2} ${q.y2}`
      } else {
        d = edgeCurve(q.x1, q.y1, q.x2, q.y2, bend)
      }
      return {
        kind: "edge",
        ...p.e,
        fork: p.fork,
        merge,
        len: Math.hypot(p.x2 - p.x1, p.y2 - p.y1),
        d,
        stroke: p.fork ? branchColor(p.e.dst.branch) : branchColor(p.e.src.branch !== p.e.dst.branch && !p.e.dst.isMerge ? p.e.dst.branch : p.e.src.branch),
        op: (!related || p.e.branches.some((b) => related.has(b))) && (!selectedAuthors || p.e.commits?.some((c) => selectedAuthors.has(c.author || "(unknown)"))) ? 1 : 0.12,
      }
    })

    // Paint longest edges first so short local edges sit on top.
    laid.sort((a, b) => b.len - a.len)

    const showTip = (event, d) => {
      const [px, py] = d3.pointer(event, wrapRef.current)
      setTip({ x: px + 12, y: py + 12, d })
    }
    const moveTip = (event) => {
      const [px, py] = d3.pointer(event, wrapRef.current)
      setTip((t) => t && { ...t, x: px + 12, y: py + 12 })
    }

    const edgeG = world.append("g").selectAll("g").data(laid).join("g")
      .attr("opacity", (d) => d.op)
    edgeG.append("path")
      .attr("d", (d) => d.d)
      .attr("class", (d) => (d.fork ? "fork-edge" : d.merge ? "merge-edge" : null))
      .attr("fill", "none")
      .attr("stroke", (d) => d.stroke)
      .attr("stroke-width", (d) => (d.fork ? 3 : 2))
      .attr("pointer-events", "none")
    const isSelected = (d) => d.hash === selectedHash || d.commits?.some((c) => c.hash === selectedHash)
    const matchSet = new Set(matchHashes || [])
    const isSearchHit = (d) => matchSet.has(d.hash) || d.commits?.some((c) => matchSet.has(c.hash))
    const isAuthorHit = (d) => !selectedAuthors || selectedAuthors.has(d.author || "(unknown)") || d.commits?.some((c) => selectedAuthors.has(c.author || "(unknown)"))
    const isHit = (d) => (!matchSet.size || isSearchHit(d)) && isAuthorHit(d)
    const filterOn = matchSet.size || selectedAuthors
    const innerR = (d) => (d.count > 1 ? 9 : 5) + (isSelected(d) ? 2 : 0)

    const commitDots = world.append("g").selectAll("g").data(clusters).join("g")
      .attr("transform", (d) => `translate(${xOfNode(d)},${yOf(d.branch)})`)
      .attr("opacity", (d) => (filterOn && !isHit(d) ? 0.2 : 0.9) * dim(d.branch))
      .style("cursor", "pointer")
      .on("pointerenter", (event, d) => showTip(event, d))
      .on("pointermove", moveTip)
      .on("pointerleave", () => setTip(null))
      .on("click", (event, d) => {
        event.stopPropagation()
        // Each merge commit is its own node — open the merge inspector directly.
        if (d.isSingleMerge) {
          const m = d.merges?.find((x) => x.hash === d.hash && x.kind !== "branch") || d.merges?.[0]
          if (m) {
            onSelect({ kind: "merge", ...m, tags: d.tags })
            return
          }
          onSelect({ kind: "commit", ...d })
          return
        }
        onSelect({ kind: d.count > 1 ? "cluster" : "commit", ...d })
      })
      .on("dblclick", (event) => event.stopPropagation())
    commitDots.append("circle").attr("r", (d) => (isStart(d) ? START_R + 6 : 14)).attr("fill", "transparent")
    commitDots.filter((d) => d.isMerge && !isStart(d)).append("circle")
      .attr("r", (d) => innerR(d) + 6)
      .attr("fill", "#0b1220")
      .attr("stroke", (d) => nodeColor(d))
      .attr("stroke-width", 2.5)
    commitDots.filter((d) => !isStart(d)).append("circle")
      .attr("r", innerR)
      .attr("fill", (d) => nodeColor(d))
      .attr("stroke", (d) => (isSelected(d) ? "#fff" : "transparent"))
      .attr("stroke-width", 2)
    commitDots.filter(isStart).append("path")
      .attr("d", diamondPath(START_R))
      .attr("fill", (d) => branchColor(d.branch))
      .attr("stroke", (d) => (isSelected(d) ? "#fff" : "#0b1220"))
      .attr("stroke-width", 2)
    commitDots.filter((d) => d.count > 1).append("text")
      .attr("y", 3)
      .attr("text-anchor", "middle")
      .attr("fill", "#0b1220")
      .attr("font-size", 9)
      .attr("font-weight", 700)
      .attr("pointer-events", "none")
      .text((d) => (d.count > 99 ? "99+" : d.count))
    commitDots.filter((d) => showTags && d.tags?.length).append("text")
      .attr("y", (d) => (isStart(d) ? START_R : innerR(d)) + (d.isMerge ? 16 : 14))
      .attr("text-anchor", "middle")
      .attr("fill", "#fbbf24")
      .attr("stroke", "#0b1220")
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("font-size", 10)
      .attr("font-weight", 700)
      .attr("pointer-events", "none")
      .text((d) => clipLabel(d.tags.join(" · ")))
    commitDots.filter(isStart).append("text")
      .attr("x", START_R + 8)
      .attr("y", 4)
      .attr("fill", (d) => branchColor(d.branch))
      .attr("stroke", "#0b1220")
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("font-size", 10)
      .attr("font-weight", 700)
      .attr("pointer-events", "none")
      .text((d) => clipLabel(d.branch, 32))

    const oldest = rangeRef.current.start ?? days[0]?.[1]?.t
    const newest = rangeRef.current.end ?? days[days.length - 1]?.[1]?.t
    function reportView(t) {
      if (!viewCb.current || oldest == null || newest == null) return
      const screenFirst = firstX * t.k + t.x
      const screenLast = lastX * t.k + t.x
      let from = oldest
      let to = newest
      if (screenFirst > 48) from = addMonths(oldest, -3)
      if (screenLast < width - 48 && screenLast < lastX * t.k - 24) to = Math.min(Date.now(), addMonths(newest, 3))
      if (from === oldest && to === newest) return
      viewCb.current(from, to)
    }

    const zoom = d3.zoom()
      .scaleExtent([0.25, 6])
      .clickDistance(6)
      .on("start", () => svg.style("cursor", "grabbing"))
      .on("end", () => svg.style("cursor", "grab"))
      .on("zoom", (event) => {
        zoomRef.current = event.transform
        world.attr("transform", event.transform)
        const t = event.transform
        const wx = (width / 2 - t.x) / t.k
        let i = Math.round((wx - MARGIN.left) / cw)
        if (days.length) i = Math.max(0, Math.min(days.length - 1, i))
        if (days[i]) {
          const colX = MARGIN.left + i * cw
          anchorRef.current = { key: days[i][0], k: t.k, y: t.y, sx: colX * t.k + t.x }
        }
        if (event.sourceEvent) reportView(event.transform)
      })

    svg.call(zoom)
    svg.on("dblclick.zoom", null)
    svg.on("dblclick", () => {
      zoomRef.current = latestView
      svg.transition().duration(200).call(zoom.transform, latestView)
    })
    const jumpKey = jumpTo?.hash ? `${jumpTo.hash}:${jumpTo.n}` : ""
    if (!jumpKey) jumpKeyRef.current = ""
    if (jumpKey && jumpKey !== jumpKeyRef.current) {
      jumpKeyRef.current = jumpKey
      const hit = clusters.find((d) => d.hash === jumpTo.hash || d.commits?.some((c) => c.hash === jumpTo.hash))
      if (hit) {
        const k = zoomRef.current.k
        zoomRef.current = d3.zoomIdentity
          .translate(width / 2 - k * xOfNode(hit), height / 2 - k * yOf(hit.branch))
          .scale(k)
      }
    }
    svg.call(zoom.transform, zoomRef.current)

    return () => {
      d3.select(svgEl).on(".zoom", null).on("dblclick", null)
    }
  }, [graph, related, size, selectedHash, matchHashes, selectedAuthors, jumpTo, onSelect, showTags, fitKey, colW, hideLongSelfEdge, collapseDay, hideOrphanMerges])

  const branches = graph?.branches || []

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <svg ref={svgRef} className="absolute inset-0 block h-full w-full touch-none" />
      {branches.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-3 flex max-w-[80%] flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {branches.map((name) => (
            <span key={name} className="inline-flex items-center gap-1.5 font-medium" style={{ color: branchColor(laneName(name)) }}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: branchColor(laneName(name)) }} />
              {name}
            </span>
          ))}
        </div>
      )}
      {tip && (
        <div
          className="pointer-events-none absolute z-20 w-80 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg"
          style={{
            left: tip.x,
            top: tip.y,
            transform: `translate(max(${8 - tip.x}px, min(0px, calc(${size.w - 8}px - 100% - ${tip.x}px))), max(${8 - tip.y}px, min(0px, calc(${size.h - 8}px - 100% - ${tip.y}px))))`,
          }}
        >
          <TipBody d={tip.d} />
        </div>
      )}
    </div>
  )
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function TimeChip({ ts, withDate }) {
  const text = withDate
    ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : fmtTime(ts)
  return (
    <span className="inline-flex shrink-0 items-center rounded-md bg-amber-400 px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-slate-950">
      {text}
    </span>
  )
}

function TipBody({ d }) {
  if (!d) return null
  const items = d.commits?.length ? d.commits : [d]
  const extra = items.length > 8 ? items.length - 8 : 0
  return (
    <div className="space-y-1.5">
      {items.length > 1 && (
        <div className="text-[11px] text-muted-foreground">
          {items.length} commits · {new Date(d.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </div>
      )}
      {items.slice(0, 8).map((c, i) => (
        <div key={c.hash || i} className="flex items-start gap-2">
          <TimeChip ts={c.timestamp} withDate={items.length === 1} />
          <span
            className={`min-w-0 break-words ${c.isMerge || c.sourceBranch ? "font-medium" : "text-foreground"}`}
            style={c.isMerge || c.sourceBranch ? { color: branchColor(c.sourceBranch) } : undefined}
          >
            {c.subject || c.hash}
            {c.tags?.length ? <span className="ml-1 font-semibold text-amber-400">{c.tags.join(" · ")}</span> : null}
          </span>
        </div>
      ))}
      {extra > 0 && <div className="text-[11px] text-muted-foreground">+{extra} more</div>}
    </div>
  )
}
