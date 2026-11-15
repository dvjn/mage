"use client";

import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";
import { Spinner } from "@/web/components/ui/spinner";
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
    <StaysOnOpen />
    <RoomBelowShrinks />
  </StickToBottom>
);

// Room kept below the content, such as padding that makes way for the composer, is not what the
// library measures: when it shrinks, the browser pulling the view up to the new end is not the
// reader scrolling up, and the end stays followed.
const RoomBelowShrinks = () => {
  const { scrollRef, contentRef, state } = useStickToBottomContext();
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let height = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      if (content.offsetHeight < height) state.ignoreScrollToTop = scroll.scrollTop;
      height = content.offsetHeight;
    });
    observer.observe(content, { box: "border-box" });
    return () => observer.disconnect();
  }, [scrollRef, contentRef, state]);
  return null;
};

// Something the reader opens grows below where they are, so the view stays put rather than
// following the end down past it.
const StaysOnOpen = () => {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const open = (event: Event) => {
      const trigger = (event.target as Element | null)?.closest('[aria-expanded="false"]');
      if (trigger && scroll.contains(trigger)) stopScroll();
    };
    scroll.addEventListener("click", open, true);
    return () => scroll.removeEventListener("click", open, true);
  }, [scrollRef, stopScroll]);
  return null;
};

// The stick-to-bottom state is a mutable object the library owns, set by assigning.
function setScrollTop(state: { scrollTop: number }, top: number) {
  state.scrollTop = Math.max(0, top);
}

// How far down the view an element scrolled to sits, as a share of the view's height.
const SCROLL_TO_SHARE = 0.3;

// How many frames a target that is not in the content yet is waited for.
const SCROLL_TO_FRAMES = 20;

// Scrolls the element with the id to near the top third of the view, once it is in the content,
// and stops following the end. Coming after the opening scroll, it wins over it.
const ScrolledTo = ({ id }: { id?: string }) => {
  const { state, scrollRef, stopScroll } = useStickToBottomContext();
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!id || !scroll) return;
    // A line inside a folded run is mounted as the run opens, which may be a frame after the id
    // arrives, so it is looked for a few frames.
    let frame = 0;
    let tries = 0;
    const scrollToTarget = () => {
      const target = document.getElementById(id);
      if (!target || !scroll.contains(target)) {
        if (tries++ < SCROLL_TO_FRAMES) frame = requestAnimationFrame(scrollToTarget);
        return;
      }
      // A row skipping layout has no boxes inside it, so its frame is measured; a line inside a run
      // of calls is measured itself.
      const element =
        target.getClientRects().length > 0
          ? target
          : (target.closest("[data-row-frame]") ?? target);
      const top =
        scroll.scrollTop +
        element.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        scroll.clientHeight * SCROLL_TO_SHARE;
      stopScroll();
      setScrollTop(state, top);
    };
    scrollToTarget();
    return () => cancelAnimationFrame(frame);
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
        setScrollTop(state, Math.min(top, end));
        stopScroll();
        return;
      }
    }
    setScrollTop(state, end);
  }, [at, hold, scrollRef, state, stopScroll]);
  return null;
};

// How far above the view earlier content is asked for, so it is there before the reader reaches it.
const EARLIER_MARGIN_PX = 600;

// Goes first in the content: while there is `more` before it, asks for it with `onLoad` once the
// top comes near the view, and again while it stays near once that has arrived. A fixed-height
// slot shows a spinner meanwhile, or a retry when `onLoad` rejects, so nothing shifts as it
// changes. The view keeps its distance from the end of the content as earlier content arrives
// (measured from the end, assigned before paint), so what is in view stays where it is, and an
// end the reader is following keeps being followed. Native scroll anchoring is turned off, as it
// would add its own correction to this one. `first` names the content's first item.
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
  // The distance from the end of the content, kept as the reader scrolls.
  const fromEnd = useRef(0);
  const restore = useRef(false);
  const [loading, setLoading] = useState(false);
  // Stays set from asking until the top is seen to be out of range again, so the spinner does not
  // blink between pages asked for in a row.
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    root.style.overflowAnchor = "none";
    const measure = () => {
      if (!restore.current) fromEnd.current = root.scrollHeight - root.scrollTop;
    };
    measure();
    root.addEventListener("scroll", measure, { passive: true });
    return () => root.removeEventListener("scroll", measure);
  }, [scrollRef]);

  const load = useCallback(() => {
    const root = scrollRef.current;
    if (root) fromEnd.current = root.scrollHeight - root.scrollTop;
    restore.current = true;
    setFailed(false);
    setPending(true);
    setLoading(true);
    onLoad().then(
      () => setLoading(false),
      () => {
        restore.current = false;
        setFailed(true);
        setPending(false);
        setLoading(false);
      },
    );
  }, [onLoad, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = top.current;
    if (!more || loading || failed || !root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          setPending(false);
          return;
        }
        observer.disconnect();
        load();
      },
      { root, rootMargin: `${EARLIER_MARGIN_PX}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loading, failed, load, scrollRef]);

  useLayoutEffect(() => {
    if (!restore.current) return;
    restore.current = false;
    const root = scrollRef.current;
    if (!root) return;
    const next = root.scrollHeight - fromEnd.current;
    if (next !== root.scrollTop) setScrollTop(state, next);
  }, [first, more, scrollRef, state]);

  if (!more) return null;
  return (
    <div
      ref={top}
      className="-mb-4 flex h-8 shrink-0 items-center justify-center gap-2 text-xs text-muted-foreground"
    >
      {failed ? (
        <>
          <span>Couldn&apos;t load earlier messages</span>
          <Button type="button" variant="ghost" size="sm" onClick={load}>
            Retry
          </Button>
        </>
      ) : (
        (loading || pending) && <Spinner aria-label="Loading earlier messages" />
      )}
    </div>
  );
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
      <WithTooltip label="Scroll to end">
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
      </WithTooltip>
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
    <WithTooltip label="Download conversation">
      <Button
        className={cn(
          "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleDownload}
        aria-label="Download conversation"
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        {children ?? <DownloadIcon className="size-4" />}
      </Button>
    </WithTooltip>
  );
};
