import { Link } from "@tanstack/react-router";
import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="mt-auto h-14 shrink-0 overflow-hidden border-t border-border/70">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo size="sm" />
        <p className="text-sm leading-none text-muted-foreground">
          (c) {new Date().getFullYear()} SkillSwap. Teach. Learn. Grow Together.
        </p>
        <div className="flex gap-4 text-sm leading-none text-muted-foreground">
          <Link to="/skills" className="transition-colors hover:text-foreground">
            Explore
          </Link>
          <Link to="/credits" className="transition-colors hover:text-foreground">
            Credits
          </Link>
        </div>
      </div>
    </footer>
  );
}
