// A question before something that cannot be taken back: what it does, why it might fail, and the
// one button that does it. It opens from its own trigger, or from wherever holds it open.

import type * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/web/components/ui/alert-dialog";
import { FieldError } from "@/web/components/ui/field";

export function ConfirmDialog({
  trigger,
  triggerLabel,
  open,
  onOpenChange,
  title,
  description,
  error,
  children,
  action,
  disabled,
  onConfirm,
}: {
  // The element that opens it, and what it says.
  trigger?: React.ReactElement;
  triggerLabel?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  error?: React.ReactNode;
  // Asked for before it can be done, as a name to type.
  children?: React.ReactNode;
  action: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger render={trigger}>{triggerLabel}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={disabled} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
