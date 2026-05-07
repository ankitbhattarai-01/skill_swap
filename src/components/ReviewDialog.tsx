import { useEffect, useState } from "react";
import { Loader2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const COMMENT_MAX = 500;
const EDIT_WINDOW_HOURS = 24;

type ExistingReview = {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
};

export function ReviewDialog({
  open,
  onOpenChange,
  sessionId,
  revieweeId,
  revieweeName,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  sessionId: string;
  revieweeId: string;
  revieweeName: string;
  onSubmitted?: () => void;
}) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<ExistingReview | null>(null);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!open || !user) return;
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setExisting(null);
    setRating(0);
    setComment("");

    (async () => {
      const { data, error } = await supabase
        .from("reviews")
        .select("id, rating, comment, created_at")
        .eq("session_id", sessionId)
        .eq("reviewer_id", user.id)
        .abortSignal(controller.signal)
        .maybeSingle();
      if (!alive) return;
      if (error) {
        toastError(error);
        setLoading(false);
        return;
      }
      if (data) {
        setExisting(data as ExistingReview);
        setRating(data.rating);
        setComment(data.comment ?? "");
      }
      setLoading(false);
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, sessionId, user]);

  const withinEditWindow = existing
    ? Date.parse(existing.created_at) > Date.now() - EDIT_WINDOW_HOURS * 60 * 60 * 1000
    : true;
  const readOnly = Boolean(existing) && !withinEditWindow;
  const trimmedComment = comment.trim();

  const submit = async () => {
    if (!user) return;
    if (rating < 1 || rating > 5) {
      toast.error("Pick a rating between 1 and 5 stars.");
      return;
    }
    if (trimmedComment.length > COMMENT_MAX) {
      toast.error(`Comments must be ${COMMENT_MAX} characters or fewer.`);
      return;
    }

    setSaving(true);
    const payload = { rating, comment: trimmedComment || null };
    const { error } = existing
      ? await supabase.from("reviews").update(payload).eq("id", existing.id)
      : await supabase.from("reviews").insert({
          ...payload,
          session_id: sessionId,
          reviewer_id: user.id,
          reviewee_id: revieweeId,
        });
    setSaving(false);

    if (error) return toastError(error);
    toast.success(existing ? "Review updated." : "Review submitted.");
    onOpenChange(false);
    onSubmitted?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong border-white/10">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit your review" : `Review ${revieweeName}`}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "The 24-hour edit window has passed. Your review is shown below for reference."
              : "Reviews are public on your partner's profile. Phone numbers, links, and email addresses aren't allowed."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Rating</Label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((value) => {
                  const filled = (hoverRating || rating) >= value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={readOnly}
                      onMouseEnter={() => !readOnly && setHoverRating(value)}
                      onMouseLeave={() => !readOnly && setHoverRating(0)}
                      onClick={() => !readOnly && setRating(value)}
                      className={cn(
                        "rounded-md p-1 transition-colors",
                        readOnly ? "cursor-default" : "hover:bg-white/5",
                      )}
                      aria-label={`${value} star${value === 1 ? "" : "s"}`}
                    >
                      <Star
                        className={cn(
                          "h-7 w-7 transition-colors",
                          filled ? "fill-yellow-300 text-yellow-300" : "text-muted-foreground",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="review-comment">Comment (optional)</Label>
              <Textarea
                id="review-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                placeholder="What was the session like?"
                className="glass border-white/10 min-h-28"
                maxLength={COMMENT_MAX}
                disabled={readOnly}
              />
              <div className="text-right text-[11px] text-muted-foreground">
                {comment.length}/{COMMENT_MAX}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button variant="hero" onClick={submit} disabled={saving || loading || rating < 1}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {existing ? "Save changes" : "Submit review"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
