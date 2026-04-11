import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            "group toast pointer-events-auto w-full max-w-sm rounded-2xl border px-3 py-2 shadow-xl backdrop-blur-md text-xs leading-snug",
          title: "min-w-0 font-semibold break-words",
          description: "min-w-0 opacity-90 break-words",
          icon: "grid h-7 w-7 shrink-0 place-content-center rounded-full bg-black/10 [&_svg]:h-3.5 [&_svg]:w-3.5",
          closeButton:
            "grid h-6 w-6 shrink-0 place-content-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100",
          actionButton:
            "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground",
          cancelButton:
            "rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
