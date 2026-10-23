// Short messages about something that just happened, as an action that failed, shown at the foot
// of the window for a few seconds each and read out to screen readers.

import { cn } from "cn";
import { XIcon } from "lucide-react";
import { createContext, type ReactNode, use, useCallback, useMemo, useRef, useState } from "react";

import { Button } from "@/web/components/ui/button";

const SHOWN_MS = 6000;

interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
}

type Show = (text: string, tone?: Toast["tone"]) => void;

const ToastContext = createContext<Show | null>(null);

// Shows a message; an error unless said otherwise.
export function useToast() {
  const show = use(ToastContext);
  if (!show) throw new Error("toasts need their provider");
  return show;
}

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<Show>(
    (text, tone = "error") => {
      next.current += 1;
      const id = next.current;
      setToasts((current) => [...current.slice(-2), { id, text, tone }]);
      setTimeout(() => dismiss(id), SHOWN_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      <ol
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-100 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <li
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-popover py-2 pr-1 pl-3 text-sm text-popover-foreground shadow-lg",
              toast.tone === "error" && "border-destructive/40",
            )}
          >
            <span className={cn("flex-1 py-1", toast.tone === "error" && "text-destructive")}>
              {toast.text}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
    </ToastContext>
  );
}
