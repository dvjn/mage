// The last card of a settings page that deletes what the page is about, asking before it does.

import type * as React from "react";

import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { Button } from "@/web/components/ui/button";
import { SettingsCard } from "@/web/shell/settings-page";

export function DeleteCard({
  title,
  description,
  blocked = false,
  confirmTitle,
  confirmDescription,
  action,
  error,
  children,
  disabled,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description: string;
  // It cannot be deleted as it is, as the description says.
  blocked?: boolean;
  confirmTitle: string;
  confirmDescription: React.ReactNode;
  action: string;
  error?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <SettingsCard
      title={title}
      description={description}
      footer={
        <ConfirmDialog
          trigger={<Button variant="destructive" disabled={blocked} />}
          triggerLabel={title}
          onOpenChange={onOpenChange}
          title={confirmTitle}
          description={confirmDescription}
          error={error}
          action={action}
          disabled={disabled}
          onConfirm={onConfirm}
        >
          {children}
        </ConfirmDialog>
      }
    />
  );
}
