"use client";

import { Button } from "@/web/components/ui/button";
import { cn } from "cn";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "children"> & {
  children?: ReactNode;
  // Opens with this element near the top of the view, unless all from it on fits the view.
  openAt?: RefObject<HTMLElement | null>;
  // Content after `openAt` is still growing: it is not followed, even when it fits at first,
  // until the reader reaches the end.
  holdOpenAt?: boolean;
  // The id of an element to bring into view, without sticking to the end, once it is there.
  scrollTo?: string;
};

// Opens at the end, or at `openAt`, and stays at the end as content grows unless the reader
// scrolls up; scrolling back down to it sticks again.
export const Conversation = ({
  className,
  children,
  openAt,
  holdOpenAt,
  scrollTo,
  ...props
}: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  >
    {children}
    <OpenScrolled at={openAt} hold={holdOpenAt} />
    <ScrolledTo id={scrollTo} />
  </StickToBottom>
);

// How far down the view an element scrolled to sits, as a share of the view's height.
const SCROLL_TO_SHARE = 0.3;

// Scrolls the element with the id to near the top third of the view, once it is in the content,
// and stops following the end. Coming after the opening scroll, it wins over it.
const ScrolledTo = ({ id }: { id?: string }) => {
  const { state, scrollRef, stopScroll } = useStickToBottomContext();
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const element = id ? document.getElementById(id) : null;
    if (!scroll || !element || !scroll.contains(element)) return;
    const top =
      scroll.scrollTop +
      element.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      scroll.clientHeight * SCROLL_TO_SHARE;
    stopScroll();
    state.scrollTop = Math.max(0, top);
  }, [id, scrollRef, state, stopScroll]);
  return null;
};

// The room left above the element a conversation opens at.
const OPEN_AT_OFFSET_PX = 24;

// Scrolls the content mounted with the conversation into place before it is first painted: to the
// end, or to `at` without sticking to the end, held there when `hold`. Coming after the content,
// it runs once the content is in place.
const OpenScrolled = ({ at, hold }: { at?: RefObject<HTMLElement | null>; hold?: boolean }) => {
  const { state, scrollRef, stopScroll } = useStickToBottomContext();
  useLayoutEffect(() => {
    const end = state.calculatedTargetScrollTop;
    const scroll = scrollRef.current;
    const mark = at?.current;
    if (scroll && mark) {
      const top =
        scroll.scrollTop +
        mark.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        OPEN_AT_OFFSET_PX;
      if (top < end || hold) {
        state.scrollTop = Math.max(0, Math.min(top, end));
        stopScroll();
        return;
      }
    }
    state.scrollTop = end;
  }, [at, hold, scrollRef, state, stopScroll]);
  return null;
};

// How far above the view earlier content is asked for, so it is there before the reader reaches it.
const EARLIER_MARGIN_PX = 600;

// Goes first in the content: while there is `more` before it, asks for it with `onLoad` once the
// top comes near the view, and again while it stays near once that has arrived. What is in view
// stays where it is as the earlier content arrives above it; `first` names the content's first
// item, which changes when it has.
export const ConversationEarlier = ({
  more,
  first,
  onLoad,
}: {
  more: boolean;
  first: string | undefined;
  onLoad: () => Promise<unknown>;
}) => {
  const { scrollRef, state } = useStickToBottomContext();
  const top = useRef<HTMLDivElement>(null);
  // The item that was first, and how far it was from the top of the view, as content was asked for.
  const anchor = useRef<{ element: Element; at: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const root = scrollRef.current;
    const target = top.current;
    if (!more || loading || !root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const element = target.nextElementSibling;
        anchor.current = element && { element, at: element.getBoundingClientRect().top };
        setLoading(true);
        void onLoad().finally(() => setLoading(false));
      },
      { root, rootMargin: `${EARLIER_MARGIN_PX}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loading, onLoad, scrollRef]);

  useLayoutEffect(() => {
    const kept = anchor.current;
    if (!kept) return;
    anchor.current = null;
    if (!kept.element.isConnected) return;
    const moved = kept.element.getBoundingClientRect().top - kept.at;
    if (moved !== 0) state.scrollTop += moved;
  }, [first, state]);

  return <div ref={top} aria-hidden className="-mb-4 h-0 shrink-0" />;
};

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleScrollToBottom}
        aria-label="Scroll to end"
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
