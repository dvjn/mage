// The states a page or list shows besides its content: loading, a read that failed, and nothing
// there yet.

import type * as React from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/web/components/ui/empty";
import { Skeleton } from "@/web/components/ui/skeleton";

export function LoadError({ className }: { className?: string }) {
  return (
    <p role="alert" className={className ?? "text-sm text-destructive"}>
      Could not load this. Reload the page to try again.
    </p>
  );
}

// Rows of a list still being read.
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 px-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  );
}

// A page-level "nothing here yet": what would be here, and how it comes to be.
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="border px-6 py-10">
      <EmptyHeader>
        {icon && (
          <EmptyMedia
            variant="icon"
            className="size-10 text-muted-foreground [&_svg:not([class*='size-'])]:size-5"
          >
            {icon}
          </EmptyMedia>
        )}
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
