import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export const BRANCH_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#f97316", "#84cc16", "#ec4899", "#6366f1"]

export function branchColor(name) {
  const n = String(name || "").replace(/^refs\/(heads|remotes|tags)\//, "").replace(/^(origin|upstream)\//, "")
  let h = 2166136261
  for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619)
  return BRANCH_COLORS[(h >>> 0) % BRANCH_COLORS.length]
}

export function wailsError(err) {
  if (!err) return "unknown error"
  if (typeof err === "string") return err
  return err.message || String(err)
}
