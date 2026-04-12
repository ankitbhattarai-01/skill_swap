import { cn } from "@/lib/utils";

export function Logo({
  size = "md",
  showText = true,
  className,
}: {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  className?: string;
}) {
  const sizes = {
    sm: { mark: "h-8 w-8", text: "text-xl" },
    md: { mark: "h-11 w-11", text: "text-3xl" },
    lg: { mark: "h-16 w-16", text: "text-6xl" },
  };

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span aria-hidden="true" className={cn("relative block shrink-0", sizes[size].mark)}>
        <img src="/brand-mark.png" alt="" className="h-full w-full object-contain" />
      </span>
      {showText && (
        <span
          className={cn(
            "font-black leading-none tracking-tight text-[#07144b] dark:text-foreground",
            sizes[size].text,
          )}
        >
          Skill<span className="text-[#5141E8] dark:text-[#7c5cff]">Swap</span>
        </span>
      )}
    </div>
  );
}
