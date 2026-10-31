// The one look every settings page shares: the page header, a title with what the page is for and
// an action beside it, and cards with a title, a description, an action beside the title, and a
// placeholder while what they show is loading or could not be read. A card that only holds a page's
// table or list goes without a title, which would repeat the page's.

import { cn } from "cn";
import type * as React from "react";

import { LoadError } from "@/web/components/page-states";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Skeleton } from "@/web/components/ui/skeleton";
import { type Crumb, PageHeader, pageWidth } from "@/web/shell/page-header";

export function SettingsPage({
  crumbs,
  title,
  description,
  children,
}: {
  crumbs: Crumb[];
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader crumbs={crumbs} />
      <div className={cn(pageWidth, "flex flex-col gap-8 p-4 pb-12")}>
        <SettingsTitle title={title} description={description} />
        {children}
      </div>
    </>
  );
}

export function SettingsTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// A card whose content waits for `state`: a skeleton while it loads, and what went wrong when it
// could not be read.
export function SettingsCard({
  title,
  description,
  action,
  footer,
  state,
  children,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  state?: { isPending: boolean; error: Error | null };
  children?: React.ReactNode;
  className?: string;
}) {
  const body = state?.error ? (
    <LoadError />
  ) : state?.isPending ? (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-full" />
    </div>
  ) : (
    children
  );
  return (
    <Card className={className}>
      {(title || description || action) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      {body && <CardContent>{body}</CardContent>}
      {footer && !state?.error && !state?.isPending && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}
