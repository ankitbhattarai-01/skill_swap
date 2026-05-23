import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Premium glass toast that mirrors the rest of the design language
// (glass-strong cards, rounded-2xl, hairline border, soft shadow).
//
// Per-severity styling is layered on via Sonner's data-type attribute so
// success / error / warning / info each get their own accent color on the
// icon + a tinted hairline border — without flooding the toast in a single
// bright color the way `richColors` does. That keeps it consistent with our
// glass cards and dialogs even on the auth screens.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: [
            "group toast pointer-events-auto w-full max-w-sm",
            "rounded-2xl border border-[var(--glass-border)]",
            "bg-[var(--glass-bg)] backdrop-blur-xl",
            "shadow-card",
            "px-4 py-3.5 gap-3",
            "text-sm leading-snug text-foreground",
            // Severity-specific hairline accent + subtle inner tint.
            "data-[type=error]:border-destructive/30 data-[type=error]:bg-destructive/[0.04]",
            "data-[type=success]:border-accent/30 data-[type=success]:bg-accent/[0.04]",
            "data-[type=warning]:border-amber-400/35 data-[type=warning]:bg-amber-400/[0.04]",
            "data-[type=info]:border-primary/30 data-[type=info]:bg-primary/[0.04]",
          ].join(" "),
          title: "min-w-0 font-semibold break-words text-foreground",
          description: "min-w-0 text-muted-foreground break-words",
          icon: [
            "grid h-8 w-8 shrink-0 place-content-center rounded-xl",
            "bg-foreground/5 text-foreground/70",
            "[&_svg]:h-4 [&_svg]:w-4",
            // Tint the icon chip per severity so the box stays calm but the
            // status is still legible at a glance.
            "group-data-[type=error]:bg-destructive/15 group-data-[type=error]:text-destructive",
            "group-data-[type=success]:bg-accent/15 group-data-[type=success]:text-accent",
            "group-data-[type=warning]:bg-amber-400/15 group-data-[type=warning]:text-amber-500",
            "group-data-[type=info]:bg-primary/15 group-data-[type=info]:text-primary",
          ].join(" "),
          closeButton:
            "grid h-6 w-6 shrink-0 place-content-center rounded-full bg-foreground/5 text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground",
          actionButton:
            "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90",
          cancelButton:
            "rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
