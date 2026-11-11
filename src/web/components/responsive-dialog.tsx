// A dialog on a wide screen and a sheet from the bottom on a phone, with the same parts as the
// dialog: its header, title, description, footer and close are the dialog's, which a sheet shares.
// Every dialog that holds a form or a list uses it; a question before something that cannot be
// taken back stays centred.

import { cn } from "cn";
import type * as React from "react";

import { Dialog, DialogContent, DialogTrigger } from "@/web/components/ui/dialog";
import { Sheet, SheetContent, SheetTrigger } from "@/web/components/ui/sheet";
import { useIsMobile } from "@/web/hooks/use-mobile";

type RootProps = React.ComponentProps<typeof Dialog>;

export function ResponsiveDialog(props: RootProps) {
  return useIsMobile() ? <Sheet {...props} /> : <Dialog {...props} />;
}

export function ResponsiveDialogTrigger(props: React.ComponentProps<typeof DialogTrigger>) {
  return useIsMobile() ? <SheetTrigger {...props} /> : <DialogTrigger {...props} />;
}

export function ResponsiveDialogContent({
  className,
  children,
  showCloseButton,
}: {
  className?: string;
  children: React.ReactNode;
  showCloseButton?: boolean;
}) {
  const close = showCloseButton === undefined ? {} : { showCloseButton };
  if (useIsMobile()) {
    return (
      <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto" {...close}>
        <div className={cn("grid gap-4 p-4", className)}>{children}</div>
      </SheetContent>
    );
  }
  return (
    <DialogContent className={className} {...close}>
      {children}
    </DialogContent>
  );
}
