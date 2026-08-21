import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function wailsError(err) {
  if (!err) return "unknown error"
  if (typeof err === "string") return err
  return err.message || String(err)
}
