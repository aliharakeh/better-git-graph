import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { branchColor } from "../lib/utils";

const LANE_H = 88
const COL_W = 148
const START_R = 18
const MARGIN = { top: 48, right: 56, bottom: 36, left: 36 }

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

function clusterByDay(commits) {
  const map = new Map()
  for (const c of commits) {
    const key = clusterKey(c.branch, c.timestamp)
    let g = map.get(key)
    if (!g) {
      g = { ...c, count: 0, commits: [], merges: [], tags: [] }
      map.set(key, g)
    }
    g.commits.push(c)
    g.count++
    g.isMerge = g.isMerge || c.isMerge
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
  for (const g of map.values()) {
    g.commits.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
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

function edgeCurve(x1, y1, x2, y2, bend = 0) {
  const dx = x2 - x1
  const dy = y2 - y1
  if (Math.abs(dy) < 6) {
    const h = (dx >= 0 ? -1 : 1) * 26
    return `M ${x1} ${y1} C ${x1 + dx / 3} ${y1 + h}, ${x1 + (2 * dx) / 3} ${y2 + h}, ${x2} ${y2}`
  }
  const mx = (x1 + x2) / 2 + bend
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

function yTracks(pts) {
  const track = Array(pts.length).fill(0)
  const idx = pts.map((_, i) => i).filter((i) => Math.abs(pts[i].y2 - pts[i].y1) >= 6 && Math.abs(pts[i].x2 - pts[i].x1) >= 6)
  idx.sort((i, j) => pts[i].x1 + pts[i].x2 - (pts[j].x1 + pts[j].x2))
  for (let a = 0; a < idx.length; a++) {
    const i = idx[a]
    const used = new Set()
    for (let b = 0; b < a; b++) {
      const j = idx[b]
      const am = (pts[i].x1 + pts[i].x2) / 2
      const bm = (pts[j].x1 + pts[j].x2) / 2
      if (Math.abs(am - bm) >= COL_W / 2) continue
      const ay0 = Math.min(pts[i].y1, pts[i].y2), ay1 = Math.max(pts[i].y1, pts[i].y2)
      const by0 = Math.min(pts[j].y1, pts[j].y2), by1 = Math.max(pts[j].y1, pts[j].y2)
      if (ay0 < by1 - 8 && by0 < ay1 - 8) used.add(track[j])
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
    let best = null
    let bestT = Infinity
    for (const g of clusters) {
      if (g.branch !== name) continue
      const t = +new Date(g.commits[0]?.timestamp || g.timestamp)
      if (t < bestT) {
        bestT = t
        best = g
      }
    }
    if (best) keys.add(clusterKey(best.branch, best.timestamp))
  }
  return keys
}

function addEdge(edges, src, dst, names, commit) {
  if (!src || !dst || src === dst) return
  const key = `${clusterKey(src.branch, src.timestamp)}->${clusterKey(dst.branch, dst.timestamp)}`
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
  const byKey = new Map(clusters.map((g) => [clusterKey(g.branch, g.timestamp), g]))
  const byHash = new Map()
  for (const g of clusters) {
    for (const c of g.commits) byHash.set(c.hash, g)
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
      if (c.isMerge && i === 0 && src.branch !== dst.branch) {
        addEdge(edges, src, dst, names, { hash: c.hash, subject: `Branch from ${src.branch}`, branch: dst.branch })
        continue
      }
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

export function TimelineGraph({ graph, focused, onSelect, selectedHash, matchHashes, jumpTo, showTags, rangeStart, rangeEnd, onViewChange }) {
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
  const [size, setSize] = useState({ w: 900, h: 480 })
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
    if (!graph?.branches?.length) return

    const branches = [...new Set(graph.branches.map(laneName))]
    const commits = graph.commits.map((c) => ({ ...c, branch: laneName(c.branch), on: (c.on || [c.branch]).map(laneName) })).filter((c) => branches.includes(c.branch))
    const clusterMap = clusterByDay(commits)
    const clusters = [...clusterMap.values()]
    const merges = (graph.merges || []).map((m) => ({ ...m, sourceBranch: laneName(m.sourceBranch), targetBranch: laneName(m.targetBranch) }))
    for (const m of merges) {
      (clusterMap.get(clusterKey(m.targetBranch, m.timestamp)) || clusterMap.get(clusterKey(m.sourceBranch, m.timestamp)))?.merges.push(m)
    }
    const edges = buildEdges(clusters, commits, branches, merges)
    const startKeys = branchStartKeys(clusters, branches)
    const isStart = (d) => startKeys.has(clusterKey(d.branch, d.timestamp))

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
    const yOf = (name) => {
      const i = branches.indexOf(name)
      return i < 0 ? undefined : MARGIN.top + i * LANE_H + LANE_H / 2
    }
    const xOf = (ts) => MARGIN.left + (dayIndex.get(localDay(ts)) ?? 0) * COL_W
    const plotBottom = MARGIN.top + Math.max(branches.length, 1) * LANE_H
    const dim = (branch) => (related && !related.has(branch) ? 0.12 : 1)

    const graphKey = graph.path || ""
    if (zoomKeyRef.current !== graphKey) {
      zoomRef.current = d3.zoomIdentity
      zoomKeyRef.current = graphKey
      anchorRef.current = null
    } else if (anchorRef.current) {
      const { key, k, y, sx } = anchorRef.current
      const i = days.findIndex(([d]) => d === key)
      if (i >= 0) {
        const wx = MARGIN.left + i * COL_W
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
      const x = MARGIN.left + i * COL_W
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
      const s = { x: xOf(e.src.timestamp), y: yOf(e.src.branch) }
      const d = { x: xOf(e.dst.timestamp), y: yOf(e.dst.branch) }
      if (s.y == null || d.y == null) return null
      const fork = isStart(e.dst) && e.src.branch !== e.dst.branch
      const r1 = isStart(e.src) ? START_R : e.src.count > 1 ? 11 : 7
      const r2 = isStart(e.dst) ? START_R : e.dst.count > 1 ? 11 : 7
      return { e, fork, x1: s.x, y1: s.y, x2: d.x, y2: d.y, r1, r2 }
    }).filter(Boolean)
    const tracks = yTracks(pts)
    const laid = pts.map((p, i) => {
      const sameDay = Math.abs(p.x1 - p.x2) < 6
      const merge = !p.fork && p.e.src.branch !== p.e.dst.branch
      const q = shorten(p.x1, p.y1, p.x2, p.y2, p.r1, p.r2)
      return {
        kind: "edge",
        ...p.e,
        fork: p.fork,
        merge,
        d: p.fork || (sameDay && !merge)
          ? `M ${q.x1} ${q.y1} L ${q.x2} ${q.y2}`
          : edgeCurve(q.x1, q.y1, q.x2, q.y2, 26 + signedTrack(tracks[i]) * 16),
        stroke: p.fork ? branchColor(p.e.dst.branch) : branchColor(p.e.src.branch !== p.e.dst.branch && !p.e.dst.isMerge ? p.e.dst.branch : p.e.src.branch),
        op: !related || p.e.branches.some((b) => related.has(b)) ? 1 : 0.12,
      }
    })

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
    const isHit = (d) => matchSet.has(d.hash) || d.commits?.some((c) => matchSet.has(c.hash))
    const innerR = (d) => (d.count > 1 ? 9 : 5) + (isSelected(d) ? 2 : 0)

    const commitDots = world.append("g").selectAll("g").data(clusters).join("g")
      .attr("transform", (d) => `translate(${xOf(d.timestamp)},${yOf(d.branch)})`)
      .attr("opacity", (d) => (matchSet.size && !isHit(d) ? 0.2 : 0.9) * dim(d.branch))
      .style("cursor", "pointer")
      .on("pointerenter", (event, d) => showTip(event, d))
      .on("pointermove", moveTip)
      .on("pointerleave", () => setTip(null))
      .on("click", (event, d) => {
        event.stopPropagation()
        if (d.count === 1 && d.merges?.length === 1) {
          onSelect({ kind: "merge", ...d.merges[0], tags: d.tags })
          return
        }
        onSelect({ kind: d.count > 1 ? "cluster" : "commit", ...d })
      })
      .on("dblclick", (event) => event.stopPropagation())
    commitDots.append("circle").attr("r", (d) => (isStart(d) ? START_R + 6 : 14)).attr("fill", "transparent")
    commitDots.filter((d) => matchSet.size && isHit(d)).append("circle")
      .attr("r", (d) => (isStart(d) ? START_R : innerR(d)) + 7)
      .attr("fill", "none")
      .attr("stroke", "#fbbf24")
      .attr("stroke-width", 2.5)
    commitDots.filter((d) => d.isMerge && !isStart(d)).append("circle")
      .attr("r", (d) => innerR(d) + 6)
      .attr("fill", "#0b1220")
      .attr("stroke", (d) => branchColor(d.branch))
      .attr("stroke-width", 2.5)
    commitDots.filter((d) => !isStart(d)).append("circle")
      .attr("r", innerR)
      .attr("fill", (d) => branchColor(d.branch))
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

    const firstX = MARGIN.left
    const lastX = MARGIN.left + Math.max(days.length - 1, 0) * COL_W
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
        let i = Math.round((wx - MARGIN.left) / COL_W)
        if (days.length) i = Math.max(0, Math.min(days.length - 1, i))
        if (days[i]) {
          const colX = MARGIN.left + i * COL_W
          anchorRef.current = { key: days[i][0], k: t.k, y: t.y, sx: colX * t.k + t.x }
        }
        if (event.sourceEvent) reportView(event.transform)
      })

    svg.call(zoom)
    svg.on("dblclick.zoom", null)
    svg.on("dblclick", () => {
      zoomRef.current = d3.zoomIdentity
      svg.transition().duration(200).call(zoom.transform, d3.zoomIdentity)
    })
    const jumpKey = jumpTo?.hash ? `${jumpTo.hash}:${jumpTo.n}` : ""
    if (!jumpKey) jumpKeyRef.current = ""
    if (jumpKey && jumpKey !== jumpKeyRef.current) {
      jumpKeyRef.current = jumpKey
      const hit = clusters.find((d) => d.hash === jumpTo.hash || d.commits?.some((c) => c.hash === jumpTo.hash))
      if (hit) {
        const k = zoomRef.current.k
        zoomRef.current = d3.zoomIdentity
          .translate(width / 2 - k * xOf(hit.timestamp), height / 2 - k * yOf(hit.branch))
          .scale(k)
      }
    }
    svg.call(zoom.transform, zoomRef.current)

    return () => {
      d3.select(svgEl).on(".zoom", null).on("dblclick", null)
    }
  }, [graph, related, size, selectedHash, matchHashes, jumpTo, onSelect, showTags])

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
