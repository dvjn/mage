// The states a page or list shows besides its content: loading, a read that failed, nothing there
// yet, and a page that does not exist or is not the reader's, unless it is in another of their
// orgs, which the tab then moves to.

import type * as React from "react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { PageHeader } from "@/web/components/app-shell";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/skeleton";
import { followPlace } from "@/web/lib/org-tab";

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
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
      {icon && (
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <p className="font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-balance text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  );
}

// A page that does not exist or is not the reader's. Given the space or thread, it first looks for
// it in the reader's other orgs.
export function NotFound({ what, id }: { what: "space" | "thread"; id?: string }) {
  const [looking, setLooking] = useState(!!id);
  useEffect(() => {
    if (!id) return;
    let current = true;
    const place = what === "space" ? { space: id } : { thread: id };
    void followPlace(place, window.location.pathname + window.location.search).then((moved) => {
      if (current && !moved) setLooking(false);
    });
    return () => {
      current = false;
    };
  }, [what, id]);
  if (looking) return null;
  return (
    <>
      <PageHeader crumbs={[{ label: "Not found" }]} />
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-muted-foreground">This {what} does not exist or is not yours.</p>
        <GoHome />
      </div>
    </>
  );
}

export function GoHome() {
  return (
    <Button variant="outline" render={<Link to="/" />} nativeButton={false}>
      Go home
    </Button>
  );
}
