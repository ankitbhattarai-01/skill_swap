import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type Props = {
  name: string | null | undefined;
  url: string | null | undefined;
  className?: string;
  fallbackClassName?: string;
};

export function UserAvatar({ name, url, className, fallbackClassName }: Props) {
  const initial = (name ?? "U").trim().slice(0, 1).toUpperCase() || "U";
  return (
    <Avatar className={className}>
      {url ? (
        <AvatarImage src={url} alt={name ?? "Avatar"} loading="lazy" decoding="async" />
      ) : null}
      <AvatarFallback className={cn("gradient-brand text-white font-semibold", fallbackClassName)}>
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
