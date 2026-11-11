// Where a thread or an artifact is shared, opened from its visibility button: a dialog, or a sheet
// from the bottom on a phone. Each opening starts afresh, so what was shown once is not shown again.

import { type ReactNode, useState } from "react";

import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTrigger,
} from "@/web/components/responsive-dialog";
import { DialogDescription, DialogHeader, DialogTitle } from "@/web/components/ui/dialog";
import { type Visibility, VisibilityButton } from "@/web/sharing/visibility-button";

export function ShareSurface({
  title,
  description,
  visibility,
  children,
}: {
  title: string;
  description: string;
  visibility: Visibility;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(0);
  return (
    <ResponsiveDialog onOpenChange={(open) => open && setOpened(opened + 1)}>
      <ResponsiveDialogTrigger render={<VisibilityButton {...visibility} />} />
      <ResponsiveDialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div key={opened}>{children}</div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
