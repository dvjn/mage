// A page that does not exist or is not the reader's, unless it is in another of their orgs, which
// the tab then moves to.

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/web/components/ui/button";
import { followPlace } from "@/web/lib/org-tab";
import { PageHeader } from "@/web/shell/page-header";

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
