import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";

const LANE_H = 86
const MARGIN = { top: 18, right: 72, bottom: 44, left: 176 }
const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#f97316", "#84cc16", "#ec4899", "#6366f1"]
const ARROW_TS = [0.32, 0.68]
const dayMs = 86400000
const hourMs = 3600000

const minSpan = 7 * dayMs

function viewWindow(commits, rangeStart, rangeEnd) {
  if (rangeStart != null && rangeEnd != null && rangeEnd > rangeStart) {
    return [rangeStart, rangeEnd]
  }
  const times = commits.map((c) => +new Date(c.timestamp))
  const to = Math.min(times.length ? Math.max(...times) : Date.now(), Date.now())
  const d = new Date(to)
  const from = +new Date(d.getFullYear(), d.getMonth() - 5, d.getDate())
  return [from, to === from ? to + 1 : to]
}

function bez(p0, p1, p2, p3, t) {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

function dbez(p0, p1, p2, p3, t) {
  const mt = 1 - t
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2)
}

function laneName(name) {
  return String(name || "").replace(/^(origin|upstream)\//, "")
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
      g = { ...c, count: 0, commits: [], merges: [] }
      map.set(key, g)
    }
    g.commits.push(c)
    g.count++
    g.isMerge = g.isMerge || c.isMerge
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

export function TimelineGraph({ graph, focused, onSelect, selectedHash, rangeStart, rangeEnd, onViewChange }) {
  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const axisRef = useRef(null)
  const zoomRef = useRef(d3.zoomIdentity)
  const zoomKeyRef = useRef("")
  const viewCb = useRef(onViewChange)
  viewCb.current = onViewChange
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
    const axisEl = axisRef.current
    const svg = d3.select(svgEl)
    const axisSvg = d3.select(axisEl)
    if (!graph?.branches?.length) return
    svg.selectAll("*").remove()
    axisSvg.selectAll("*").remove()

    const branches = [...new Set(graph.branches.map(laneName))]
    const commits = graph.commits.map((c) => ({ ...c, branch: laneName(c.branch) })).filter((c) => branches.includes(c.branch))
    const clusterMap = clusterByDay(commits)
    const clusters = [...clusterMap.values()]
    const [winStart, winEnd] = viewWindow(commits, rangeStart, rangeEnd)
    const yOf = (name) => MARGIN.top + branches.indexOf(name) * LANE_H + LANE_H / 2
    const color = d3.scaleOrdinal(COLORS).domain(branches)
    const width = size.w
    const plotBottom = MARGIN.top + branches.length * LANE_H
    const clipH = Math.max(size.h - MARGIN.bottom, 1)
    const innerW = Math.max(width - MARGIN.left - MARGIN.right, 40)
    const minY = Math.min(0, clipH - plotBottom)
    const yOff = (t) => Math.max(minY, Math.min(0, t.y))

    const resetKey = `${winStart}:${winEnd}:${graph.path}:${branches.join("\n")}`
    if (zoomKeyRef.current !== resetKey) {
      zoomRef.current = d3.zoomIdentity
      zoomKeyRef.current = resetKey
    }

    svg.attr("width", width).attr("height", clipH).attr("viewBox", `0 0 ${width} ${clipH}`).style("cursor", "grab")
    axisSvg.attr("width", width).attr("height", MARGIN.bottom).attr("viewBox", `0 0 ${width} ${MARGIN.bottom}`)

    const x0 = d3.scaleTime().domain([new Date(winStart), new Date(winEnd)]).range([MARGIN.left, MARGIN.left + innerW])
    const dim = (branch) => (related && !related.has(branch) ? 0.12 : 1)
    const tickFmt = (xz) => {
      const span = +xz.domain()[1] - +xz.domain()[0]
      if (span > 40 * dayMs) return d3.timeFormat("%b %Y")
      if (span > 2 * dayMs) return d3.timeFormat("%a %b %d")
      if (span > 6 * hourMs) return d3.timeFormat("%b %d %H:%M")
      return d3.timeFormat("%H:%M")
    }
    const tickInterval = (xz) => {
      const span = +xz.domain()[1] - +xz.domain()[0]
      if (span > 40 * dayMs) return d3.timeMonth.every(1)
      if (span > 2 * dayMs) return d3.timeDay.every(1)
      if (span > 6 * hourMs) return d3.timeHour.every(1)
      return d3.timeMinute.every(15)
    }
    const mergeCurve = (m, xz) => {
      const srcC = clusterMap.get(clusterKey(m.sourceBranch, m.timestamp))
      const dstC = clusterMap.get(clusterKey(m.targetBranch, m.timestamp))
      const x1pos = xz(new Date(srcC?.timestamp || m.timestamp))
      const x2pos = xz(new Date(dstC?.timestamp || m.timestamp))
      const y1 = yOf(m.sourceBranch)
      const y2 = yOf(m.targetBranch)
      if (y1 === y2) {
        const w = 56
        const h = 44
        return {
          x1: x1pos, y1, cx1: x1pos - w, cy1: y1 - h, cx2: x2pos + w, cy2: y2 - h, x2: x2pos, y2,
          d: `M ${x1pos} ${y1} C ${x1pos - w} ${y1 - h}, ${x2pos + w} ${y2 - h}, ${x2pos} ${y2}`,
        }
      }
      const sign = y2 >= y1 ? -1 : 1
      const mag = 56 + Math.min(Math.abs(y2 - y1) * 0.14, 44)
      const x1 = x1pos + sign * 10
      const x2 = x2pos + sign * 10
      const cx = (x1 + x2) / 2 + sign * mag
      return {
        x1, y1, cx1: cx, cy1: y1, cx2: cx, cy2: y2, x2, y2,
        d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
      }
    }
    const defs = svg.append("defs")
    defs.append("clipPath").attr("id", "lane-clip").append("rect").attr("x", 0).attr("y", 0).attr("width", width).attr("height", clipH)
    defs.append("clipPath").attr("id", "plot-clip").append("rect").attr("x", MARGIN.left).attr("y", 0).attr("width", Math.max(width - MARGIN.left, 1)).attr("height", clipH)

    svg.append("rect").attr("width", width).attr("height", clipH).attr("fill", "#0b1220")
    axisSvg.append("rect").attr("width", width).attr("height", MARGIN.bottom).attr("fill", "#0b1220")

    const lanes = svg.append("g").attr("clip-path", "url(#lane-clip)")
    const bg = lanes.append("g")
    branches.forEach((name, i) => {
      bg.append("rect")
        .attr("x", 0)
        .attr("y", MARGIN.top + i * LANE_H)
        .attr("width", width)
        .attr("height", LANE_H)
        .attr("fill", i % 2 === 0 ? "#121a2b" : "#0e1626")
        .attr("opacity", dim(name))
    })

    const labels = lanes.append("g")
    branches.forEach((name) => {
      labels.append("text")
        .attr("x", 16)
        .attr("y", yOf(name))
        .attr("dominant-baseline", "middle")
        .attr("fill", color(name))
        .attr("font-size", 12)
        .attr("font-weight", 600)
        .attr("opacity", dim(name))
        .text(name.length > 22 ? `${name.slice(0, 20)}…` : name)
    })

    const plot = svg.append("g").attr("clip-path", "url(#plot-clip)").append("g")
    const laneLines = plot.append("g").selectAll("line").data(branches).join("line")
      .attr("x1", MARGIN.left)
      .attr("x2", MARGIN.left + innerW)
      .attr("y1", (name) => yOf(name))
      .attr("y2", (name) => yOf(name))
      .attr("stroke", (name) => color(name))
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", (name) => 0.25 * dim(name))

    const merges = graph.merges
      .map((m) => ({ ...m, sourceBranch: laneName(m.sourceBranch), targetBranch: laneName(m.targetBranch) }))
      .filter((m) => branches.includes(m.targetBranch) && branches.includes(m.sourceBranch))
    for (const m of merges) {
      clusterMap.get(clusterKey(m.targetBranch, m.timestamp))?.merges.push(m)
    }

    const branchLines = plot.append("g")
    d3.group(clusters, (c) => c.branch).forEach((nodes, name) => {
      nodes.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
      branchLines.append("path")
        .datum(nodes)
        .attr("fill", "none")
        .attr("stroke", color(name))
        .attr("stroke-width", 2)
        .attr("opacity", 0.45 * dim(name))
    })

    merges.forEach((m, i) => {
      const id = `grad-${m.hash}-${i}`
      const g = defs.append("linearGradient").attr("id", id).attr("gradientUnits", "userSpaceOnUse")
        .attr("y1", yOf(m.sourceBranch)).attr("y2", yOf(m.targetBranch))
      g.append("stop").attr("offset", "0%").attr("stop-color", color(m.sourceBranch))
      g.append("stop").attr("offset", "100%").attr("stop-color", color(m.targetBranch))
    })

    const mergeLinks = plot.append("g").selectAll("path").data(merges).join("path")
      .attr("class", "merge-flow")
      .attr("fill", "none")
      .attr("stroke", (d, i) => `url(#grad-${d.hash}-${i})`)
      .attr("stroke-width", 2.4)
      .attr("opacity", (d) => (!related || related.has(d.sourceBranch) || related.has(d.targetBranch) ? 0.95 : 0.1))

    const arrowData = merges.flatMap((m, i) => {
      const ts = m.sourceBranch === m.targetBranch ? [0.5] : ARROW_TS
      return ts.map((t, k) => ({ m, i, t, k, last: k === ts.length - 1 }))
    })
    const flowArrows = plot.append("g").selectAll("path").data(arrowData).join("path")
      .attr("d", "M -7 -5 L 10 0 L -7 5 Z")
      .attr("fill", (d) => (d.last ? color(d.m.targetBranch) : color(d.m.sourceBranch)))
      .attr("stroke", "#0b1220")
      .attr("stroke-width", 0.6)
      .attr("opacity", (d) => (!related || related.has(d.m.sourceBranch) || related.has(d.m.targetBranch) ? 1 : 0.12))

    const showTip = (event, d) => {
      const [px, py] = d3.pointer(event, wrapRef.current)
      setTip({ x: px + 12, y: py + 12, d })
    }
    const isSelected = (d) => d.hash === selectedHash || d.commits?.some((c) => c.hash === selectedHash)
    const innerR = (d) => (d.count > 1 ? 9 : 5) + (isSelected(d) ? 2 : 0)

    const commitDots = plot.append("g").selectAll("g").data(clusters).join("g")
      .attr("opacity", (d) => 0.9 * dim(d.branch))
      .style("cursor", "pointer")
      .on("pointerenter", (event, d) => showTip(event, d))
      .on("pointermove", (event) => {
        const [px, py] = d3.pointer(event, wrapRef.current)
        setTip((t) => t && { ...t, x: px + 12, y: py + 12 })
      })
      .on("pointerleave", () => setTip(null))
      .on("click", (event, d) => {
        event.stopPropagation()
        if (d.count === 1 && d.merges?.length === 1) {
          onSelect({ kind: "merge", ...d.merges[0] })
          return
        }
        onSelect({ kind: d.count > 1 ? "cluster" : "commit", ...d })
      })
      .on("dblclick", (event) => event.stopPropagation())
    commitDots.append("circle")
      .attr("r", 14)
      .attr("fill", "transparent")
    commitDots.filter((d) => d.isMerge).append("circle")
      .attr("r", (d) => innerR(d) + 6)
      .attr("fill", "#0b1220")
      .attr("stroke", (d) => color(d.branch))
      .attr("stroke-width", 2.5)
    commitDots.append("circle")
      .attr("r", innerR)
      .attr("fill", (d) => (d.merges?.length === 1 ? color(d.merges[0].sourceBranch) : color(d.branch)))
      .attr("stroke", (d) => (isSelected(d) ? "#fff" : "transparent"))
      .attr("stroke-width", 2)
    commitDots.filter((d) => d.count > 1).append("text")
      .attr("y", 3)
      .attr("text-anchor", "middle")
      .attr("fill", "#0b1220")
      .attr("font-size", 9)
      .attr("font-weight", 700)
      .attr("pointer-events", "none")
      .text((d) => (d.count > 99 ? "99+" : d.count))

    const srcNodes = plot.append("g").selectAll("circle")
      .data(merges.filter((m) => m.sourceBranch !== m.targetBranch && !clusterMap.get(clusterKey(m.sourceBranch, m.timestamp))))
      .join("circle")
      .attr("r", 5)
      .attr("fill", (d) => color(d.sourceBranch))
      .attr("opacity", (d) => 0.9 * dim(d.sourceBranch))
      .style("cursor", "pointer")
      .on("pointerenter", (event, d) => showTip(event, d))
      .on("pointermove", (event) => {
        const [px, py] = d3.pointer(event, wrapRef.current)
        setTip((t) => t && { ...t, x: px + 12, y: py + 12 })
      })
      .on("pointerleave", () => setTip(null))
      .on("click", (event, d) => {
        event.stopPropagation()
        onSelect({ kind: "merge", ...d })
      })
      .on("dblclick", (event) => event.stopPropagation())

    const axisG = axisSvg.append("g").attr("transform", "translate(0,0)")

    function apply(t) {
      const xz = t.rescaleX(x0)
      const ty = yOff(t)
      bg.attr("transform", `translate(0,${ty})`)
      labels.attr("transform", `translate(0,${ty})`)
      plot.attr("transform", `translate(0,${ty})`)
      laneLines.attr("x1", MARGIN.left).attr("x2", MARGIN.left + innerW)
      branchLines.selectAll("path").attr("d", (nodes) =>
        d3.line()
          .x((d) => xz(new Date(d.timestamp)))
          .y((d) => yOf(d.branch))
          .curve(d3.curveMonotoneX)(nodes)
      )
      mergeLinks.attr("d", (d) => mergeCurve(d, xz).d)
      flowArrows.attr("transform", (d) => {
        const c = mergeCurve(d.m, xz)
        const x = bez(c.x1, c.cx1, c.cx2, c.x2, d.t)
        const y = bez(c.y1, c.cy1, c.cy2, c.y2, d.t)
        const a = Math.atan2(dbez(c.y1, c.cy1, c.cy2, c.y2, d.t), dbez(c.x1, c.cx1, c.cx2, c.x2, d.t)) * (180 / Math.PI)
        return `translate(${x},${y}) rotate(${a})`
      })
      merges.forEach((m, i) => {
        const c = mergeCurve(m, xz)
        defs.select(`#grad-${m.hash}-${i}`).attr("x1", c.x1).attr("y1", c.y1).attr("x2", c.x2).attr("y2", c.y2)
      })
      commitDots.attr("transform", (d) => `translate(${xz(new Date(d.timestamp))},${yOf(d.branch)})`)
      srcNodes
        .attr("cx", (d) => mergeCurve(d, xz).x1)
        .attr("cy", (d) => mergeCurve(d, xz).y1)
      const axis = d3.axisBottom(xz).tickFormat(tickFmt(xz)).tickSize(6).tickPadding(6)
      const interval = tickInterval(xz)
      axisG.call(interval ? axis.ticks(interval) : axis.ticks(8))
        .call((g) => g.select(".domain").attr("stroke", "#334155"))
        .call((g) => g.selectAll(".tick line").attr("stroke", "#334155"))
        .call((g) => g.selectAll(".tick text").attr("fill", "#94a3b8").attr("font-size", 11))
    }

    const viewSpan = Math.max(winEnd - winStart, 1)
    const minK = 1
    const maxK = Math.max(1, viewSpan / minSpan)
    const clamp = (t) => d3.zoomIdentity.translate(t.x, yOff(t)).scale(Math.max(minK, t.k))

    const zoom = d3.zoom()
      .scaleExtent([minK, maxK])
      .extent([[MARGIN.left, 0], [width, clipH]])
      .clickDistance(6)
      .on("start", () => svg.style("cursor", "grabbing"))
      .on("end", () => svg.style("cursor", "grab"))
      .on("zoom", (event) => {
        const next = clamp(event.transform)
        if (next.x !== event.transform.x || next.y !== event.transform.y || next.k !== event.transform.k) {
          svg.node().__zoom = next
        }
        zoomRef.current = next
        apply(next)
        if (event.sourceEvent) {
          const [a, b] = next.rescaleX(x0).domain()
          viewCb.current?.(+a, +b)
        }
      })

    svg.call(zoom)
    svg.on("dblclick.zoom", null)
    svg.on("dblclick", () => {
      zoomRef.current = d3.zoomIdentity
      svg.transition().duration(200).call(zoom.transform, d3.zoomIdentity)
    })
    svg.call(zoom.transform, zoomRef.current)

    return () => {
      d3.select(svgEl).on(".zoom", null).on("dblclick", null)
    }
  }, [graph, related, size, selectedHash, onSelect, rangeStart, rangeEnd])

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <svg ref={svgRef} className="absolute inset-x-0 top-0 block w-full touch-none" style={{ bottom: MARGIN.bottom }} />
      <svg ref={axisRef} className="pointer-events-none absolute bottom-0 left-0 block w-full" style={{ height: MARGIN.bottom }} />
      {tip && (
        <div
          className="pointer-events-none absolute z-20 w-72 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg"
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
          <span className="min-w-0 break-words text-foreground">{c.subject || c.hash}</span>
        </div>
      ))}
      {extra > 0 && <div className="text-[11px] text-muted-foreground">+{extra} more</div>}
    </div>
  )
}
