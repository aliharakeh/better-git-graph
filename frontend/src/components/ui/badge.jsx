import { cn } from "../../lib/utils"

export function Badge({ className, variant = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
        variant === "outline" && "border-border text-muted-foreground",
        variant === "default" && "border-transparent bg-primary/15 text-primary",
        className
      )}
      {...props}
    />
  )
}
