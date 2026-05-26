import { memo, useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  EyeOff,
  FileText,
  Flag,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { downloadAttachment, formatBytes } from "@/lib/messageAttachments";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type MessageBubbleData = {
  id: string;
  sender_id: string | null;
  text: string;
  created_at: string;
  edited_at?: string | null;
  attachment_path?: string | null;
  attachment_kind?: "image" | "document" | null;
  attachment_name?: string | null;
  attachment_size?: number | null;
  attachment_mime?: string | null;
};

type Props = {
  message: MessageBubbleData;
  mine: boolean;
  otherName: string;
  otherAvatar: string | null;
  showAvatar: boolean;
  attachmentUrl?: string | null;
  onEdit: (id: string, nextText: string) => Promise<void> | void;
  onUnsend: (id: string) => Promise<void> | void;
  onDeleteForMe: (id: string) => void;
  onReport?: (id: string) => void;
};

function formatBubbleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function MessageBubbleInner({
  message,
  mine,
  otherName,
  otherAvatar,
  showAvatar,
  attachmentUrl,
  onEdit,
  onUnsend,
  onDeleteForMe,
  onReport,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmUnsend, setConfirmUnsend] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(message.text);
      requestAnimationFrame(() => {
        const el = editRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }
      });
    }
  }, [isEditing, message.text]);

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft(message.text);
  };

  const submitEdit = async () => {
    const next = draft.trim();
    if (!next) {
      toast.error("Message cannot be empty");
      return;
    }
    if (next === message.text) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    try {
      await onEdit(message.id, next);
      setIsEditing(false);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  const startLongPress = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      setMenuOpen(true);
      if ("vibrate" in navigator) navigator.vibrate?.(15);
    }, 450);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const edited = Boolean(message.edited_at);

  return (
    <div
      className={cn("group/msg flex items-end gap-2", mine ? "justify-end" : "justify-start")}
      data-message-id={message.id}
    >
      {!mine && (
        <div className="w-7 shrink-0">
          {showAvatar && <UserAvatar name={otherName} url={otherAvatar} className="h-7 w-7" />}
        </div>
      )}

      <div
        className={cn(
          "relative flex max-w-[78%] flex-col sm:max-w-[70%]",
          mine ? "items-end" : "items-start",
        )}
      >
        {isEditing ? (
          <div
            className={cn(
              "w-full rounded-[1.35rem] px-3 py-2 shadow-sm",
              mine ? "gradient-brand text-white" : "bg-card text-foreground",
            )}
          >
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              rows={1}
              className={cn(
                "w-full resize-none bg-transparent text-sm leading-relaxed outline-none",
                mine ? "placeholder:text-white/60" : "placeholder:text-muted-foreground",
              )}
            />
            <div className="mt-1 flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={cancelEdit}
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  mine
                    ? "text-white/80 hover:bg-white/10"
                    : "text-muted-foreground hover:bg-foreground/10",
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitEdit()}
                disabled={savingEdit}
                className={cn(
                  "rounded-full px-3 py-1 font-semibold transition-colors disabled:opacity-60",
                  mine
                    ? "bg-white/20 text-white hover:bg-white/30"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-1">
            {mine && (
              <BubbleMenu
                mine
                edited={edited}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onEdit={() => setIsEditing(true)}
                onUnsend={() => setConfirmUnsend(true)}
                onCopy={() => void handleCopy()}
                onDeleteForMe={() => onDeleteForMe(message.id)}
              />
            )}
            <div
              role="group"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuOpen(true);
              }}
              onTouchStart={startLongPress}
              onTouchEnd={cancelLongPress}
              onTouchMove={cancelLongPress}
              onTouchCancel={cancelLongPress}
              className={cn(
                "select-text break-words text-left text-sm shadow-sm transition-shadow",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                "overflow-hidden",
                mine
                  ? "rounded-[1.35rem] rounded-br-md gradient-brand text-white"
                  : "rounded-[1.35rem] rounded-bl-md bg-card text-foreground",
                message.attachment_kind === "image" && !message.text
                  ? "p-1"
                  : message.attachment_path
                    ? "px-3 pt-2 pb-2"
                    : "px-4 py-2",
              )}
            >
              {message.attachment_kind === "image" && message.attachment_path && (
                <ImageAttachment
                  url={attachmentUrl ?? null}
                  name={message.attachment_name ?? "Image"}
                  mine={mine}
                />
              )}
              {message.attachment_kind === "document" && message.attachment_path && (
                <DocumentAttachment
                  url={attachmentUrl ?? null}
                  name={message.attachment_name ?? "Document"}
                  size={message.attachment_size ?? null}
                  mine={mine}
                />
              )}
              {message.text && message.text.trim().length > 0 && (
                <div
                  className={cn(
                    "whitespace-pre-wrap leading-relaxed",
                    message.attachment_path && "mt-2 px-1",
                  )}
                >
                  {message.text}
                </div>
              )}
            </div>
            {!mine && (
              <BubbleMenu
                mine={false}
                edited={edited}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onEdit={() => undefined}
                onUnsend={() => undefined}
                onCopy={() => void handleCopy()}
                onDeleteForMe={() => onDeleteForMe(message.id)}
                onReport={onReport ? () => onReport(message.id) : undefined}
              />
            )}
          </div>
        )}

        <div
          className={cn(
            "mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground",
            mine ? "justify-end" : "justify-start",
          )}
        >
          <span>{formatBubbleTime(message.created_at)}</span>
          {edited && <span className="italic">· edited</span>}
        </div>
      </div>

      <AlertDialog open={confirmUnsend} onOpenChange={setConfirmUnsend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsend message?</AlertDialogTitle>
            <AlertDialogDescription>
              This message will be removed for everyone in this chat. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void onUnsend(message.id)}
            >
              Unsend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type BubbleMenuProps = {
  mine: boolean;
  edited: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onUnsend: () => void;
  onCopy: () => void;
  onDeleteForMe: () => void;
  onReport?: () => void;
};

function BubbleMenu({
  mine,
  open,
  onOpenChange,
  onEdit,
  onUnsend,
  onCopy,
  onDeleteForMe,
  onReport,
}: BubbleMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Message actions"
          className={cn(
            "h-7 w-7 rounded-full text-muted-foreground transition-opacity",
            "opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            "md:opacity-0",
            // Always slightly visible on touch so the affordance exists without long-press only
            "max-md:opacity-60",
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={mine ? "end" : "start"} className="w-44">
        <DropdownMenuItem onClick={onCopy}>
          <Copy className="h-4 w-4" />
          Copy text
        </DropdownMenuItem>
        {mine && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            Edit
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onDeleteForMe}>
          <EyeOff className="h-4 w-4" />
          Delete for me
        </DropdownMenuItem>
        {!mine && onReport && (
          <DropdownMenuItem onClick={onReport}>
            <Flag className="h-4 w-4" />
            Report message
          </DropdownMenuItem>
        )}
        {mine && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onUnsend}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Unsend
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useAttachmentDownload(url: string | null, name: string) {
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!url || downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(url, name);
    } catch {
      toast.error("Could not download file");
    } finally {
      setDownloading(false);
    }
  };
  return { downloading, handleDownload };
}

function ImageAttachment({
  url,
  name,
  mine,
}: {
  url: string | null;
  name: string;
  mine: boolean;
}) {
  const { downloading, handleDownload } = useAttachmentDownload(url, name);
  if (!url) {
    return (
      <div
        className={cn(
          "flex h-40 w-60 max-w-[60vw] items-center justify-center rounded-2xl",
          mine ? "bg-white/10" : "bg-foreground/5",
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin opacity-60" />
      </div>
    );
  }
  return (
    <div className="relative max-w-full overflow-hidden rounded-2xl">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block"
      >
        <img
          src={url}
          alt={name}
          className="block h-auto max-h-[320px] w-auto max-w-full rounded-2xl object-cover"
          loading="lazy"
        />
      </a>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        aria-label="Download image"
        title="Download image"
        className="absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/75 active:scale-95 disabled:opacity-60"
      >
        {downloading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

function DocumentAttachment({
  url,
  name,
  size,
  mine,
}: {
  url: string | null;
  name: string;
  size: number | null;
  mine: boolean;
}) {
  const sizeLabel = size ? formatBytes(size) : null;
  const { downloading, handleDownload } = useAttachmentDownload(url, name);
  return (
    <div
      className={cn(
        "flex w-full max-w-xs items-center gap-3 rounded-2xl px-3 py-2",
        mine ? "bg-white/10" : "bg-foreground/5",
      )}
    >
      <div
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          mine ? "bg-white/20 text-white" : "bg-brand-purple/15 text-brand-purple",
        )}
      >
        <FileText className="h-5 w-5" />
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 transition-opacity hover:opacity-80"
        >
          <div className={cn("truncate text-sm font-medium", mine ? "text-white" : "text-foreground")}>
            {name}
          </div>
          {sizeLabel && (
            <div className={cn("text-[11px]", mine ? "text-white/75" : "text-muted-foreground")}>
              {sizeLabel} · Open
            </div>
          )}
        </a>
      ) : (
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-sm font-medium", mine ? "text-white" : "text-foreground")}>
            {name}
          </div>
          {sizeLabel && (
            <div className={cn("text-[11px]", mine ? "text-white/75" : "text-muted-foreground")}>
              {sizeLabel}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={handleDownload}
        disabled={!url || downloading}
        aria-label="Download file"
        title="Download file"
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95 disabled:opacity-60",
          mine
            ? "bg-white/15 text-white hover:bg-white/25"
            : "bg-brand-purple/15 text-brand-purple hover:bg-brand-purple/25",
        )}
      >
        {downloading || !url ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);
MessageBubble.displayName = "MessageBubble";
