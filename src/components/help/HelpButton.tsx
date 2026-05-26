import { useState, lazy, Suspense } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const HelpAssistant = lazy(() =>
  import("./HelpAssistant").then((m) => ({ default: m.HelpAssistant })),
);

export function HelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open help guide"
        className={cn(
          "fixed z-40 flex h-12 w-12 items-center justify-center rounded-2xl",
          "gradient-brand text-white shadow-glow",
          "right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:right-6 md:bottom-6",
          "transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          "hover:-translate-y-0.5 hover:shadow-glow-blue active:translate-y-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <HelpCircle className="h-5 w-5" />
      </button>

      {open && (
        <Suspense fallback={null}>
          <HelpAssistant open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}
