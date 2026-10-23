// The one frame of the pages around getting in: signing in or up, opening an invite and a thread
// whose access ended. The wordmark over one card, centred: its title, what it says, then its form
// or its actions. On its own it fills the screen; inside the app, the space beside the sidebar.

import { cn } from "cn";
import type * as React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Wordmark } from "@/web/components/wordmark";

export function AuthFrame({
  children,
  inApp = false,
}: {
  children: React.ReactNode;
  inApp?: boolean;
}) {
  const Root = inApp ? "div" : "main";
  return (
    <Root className={cn("flex items-center justify-center p-6", inApp ? "flex-1" : "min-h-svh")}>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Wordmark className="self-center" />
        {children}
      </div>
    </Root>
  );
}

export function AuthCard({
  title,
  description,
  children,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  // A form.
  children?: React.ReactNode;
  // Buttons, side by side.
  actions?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
      {actions && <CardFooter className="flex gap-2">{actions}</CardFooter>}
    </Card>
  );
}
