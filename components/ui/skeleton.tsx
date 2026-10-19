import { cn } from "cn"

function Skeleton({
  className,
  shimmer = true,
  ...props
}: React.ComponentProps<"div"> & {
  /** Use the shimmer gradient animation instead of the default pulse. Default true. */
  shimmer?: boolean
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted",
        shimmer ? "skeleton-shimmer" : "animate-pulse",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
