type Variant = "vibrant" | "calm";

type Props = {
  className?: string;
  variant?: Variant;
};

type BlobConfig = {
  position: string;
  size: string;
  baseOpacity: string;
  darkOpacity: string;
  color: string;
  blur: number;
  animation: string;
};

const variants: Record<Variant, BlobConfig[]> = {
  vibrant: [
    {
      position: "left-[10%] top-[10%]",
      size: "h-[55%] w-[55%]",
      baseOpacity: "opacity-70",
      darkOpacity: "dark:opacity-60",
      color: "rgba(124,58,237,0.85)",
      blur: 60,
      animation: "blobDriftA 22s ease-in-out infinite",
    },
    {
      position: "right-[5%] top-[20%]",
      size: "h-[50%] w-[50%]",
      baseOpacity: "opacity-65",
      darkOpacity: "dark:opacity-55",
      color: "rgba(20,184,166,0.85)",
      blur: 60,
      animation: "blobDriftB 28s ease-in-out infinite",
    },
    {
      position: "bottom-[5%] left-[30%]",
      size: "h-[45%] w-[45%]",
      baseOpacity: "opacity-55",
      darkOpacity: "dark:opacity-50",
      color: "rgba(217,70,239,0.80)",
      blur: 60,
      animation: "blobDriftC 34s ease-in-out infinite",
    },
  ],
  calm: [
    {
      position: "right-[8%] top-[5%]",
      size: "h-[65%] w-[55%]",
      baseOpacity: "opacity-55",
      darkOpacity: "dark:opacity-50",
      color: "rgba(20,184,166,0.85)",
      blur: 80,
      animation: "blobDriftB 42s ease-in-out infinite",
    },
    {
      position: "-left-[5%] bottom-[10%]",
      size: "h-[60%] w-[60%]",
      baseOpacity: "opacity-45",
      darkOpacity: "dark:opacity-45",
      color: "rgba(52,211,153,0.75)",
      blur: 90,
      animation: "blobDriftC 55s ease-in-out infinite",
    },
    {
      position: "right-[25%] bottom-[5%]",
      size: "h-[40%] w-[40%]",
      baseOpacity: "opacity-35",
      darkOpacity: "dark:opacity-40",
      color: "rgba(124,58,237,0.70)",
      blur: 90,
      animation: "blobDriftA 48s ease-in-out infinite",
    },
  ],
};

export function ShaderBackground({ className, variant = "vibrant" }: Props) {
  const blobs = variants[variant];
  return (
    <div aria-hidden className={className}>
      <div className="relative h-full w-full overflow-hidden">
        {blobs.map((b, i) => (
          <div
            key={i}
            className={`absolute rounded-full mix-blend-multiply dark:mix-blend-screen ${b.position} ${b.size} ${b.baseOpacity} ${b.darkOpacity}`}
            style={{
              background: `radial-gradient(circle at 50% 50%, ${b.color}, ${b.color.replace(/,[\d.]+\)/, ",0)")} 65%)`,
              filter: `blur(${b.blur}px)`,
              animation: b.animation,
              willChange: "transform",
            }}
          />
        ))}
      </div>
    </div>
  );
}
