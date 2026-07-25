import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/credit-purchases";

// A demo payment QR.
//
// This draws something with the *grammar* of a QR code — three finder eyes with
// their separators, both timing lines, an alignment square, and a quiet zone —
// filled with modules derived deterministically from the payload string. It is
// not a real encoding: a scanner will not read it, and it is labelled as a demo
// wherever it appears.
//
// Deterministic matters more than it sounds. The same reference always draws the
// same code, so the panel doesn't shimmer on re-render, and a screenshot taken
// during a demo keeps matching the reference printed underneath it.
//
// Making these scannable is a contained change: swap `buildMatrix` for a real
// encoder's boolean grid and the rendering below works unchanged.

const MODULES = 25; // A version-2 QR is 25×25 — same proportions, same density.
const QUIET_ZONE = 2;

// FNV-1a. Cheap, stable across engines, and spreads single-character reference
// changes across the whole grid.
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// mulberry32 — small, fast, and good enough for something purely visual.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Cell = "dark" | "light" | "eye";

function buildMatrix(value: string): Cell[][] {
  const cells: Cell[][] = Array.from({ length: MODULES }, () =>
    Array.from({ length: MODULES }, () => "light" as Cell),
  );
  // Reserved cells are the fixed patterns — the random fill must skip them or
  // the code stops reading as a code.
  const reserved = Array.from({ length: MODULES }, () =>
    Array.from({ length: MODULES }, () => false),
  );

  const set = (row: number, col: number, cell: Cell) => {
    if (row < 0 || col < 0 || row >= MODULES || col >= MODULES) return;
    cells[row][col] = cell;
    reserved[row][col] = true;
  };

  // Finder eye: 7×7 filled ring with a 3×3 core, plus the one-module separator
  // that keeps it clear of the data.
  const placeFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const outside = r < 0 || c < 0 || r > 6 || c > 6;
        set(top + r, left + c, outside ? "light" : inRing || inCore ? "eye" : "light");
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, MODULES - 7);
  placeFinder(MODULES - 7, 0);

  // Timing lines: alternating modules along row 6 and column 6.
  for (let i = 8; i < MODULES - 8; i += 1) {
    const dark = i % 2 === 0;
    set(6, i, dark ? "dark" : "light");
    set(i, 6, dark ? "dark" : "light");
  }

  // Alignment pattern: a 5×5 ring with a single dark centre, bottom-right.
  const alignTop = MODULES - 9;
  const alignLeft = MODULES - 9;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      const ring = r === 0 || r === 4 || c === 0 || c === 4;
      const centre = r === 2 && c === 2;
      set(alignTop + r, alignLeft + c, ring || centre ? "dark" : "light");
    }
  }

  const random = makeRandom(hashString(value));
  for (let r = 0; r < MODULES; r += 1) {
    for (let c = 0; c < MODULES; c += 1) {
      if (reserved[r][c]) continue;
      // Just under half — real codes hover around a balanced fill, and anything
      // denser starts to look like static.
      cells[r][c] = random() < 0.47 ? "dark" : "light";
    }
  }

  return cells;
}

export function DemoQrCode({
  value,
  method,
  className,
}: {
  value: string;
  method: PaymentMethod;
  className?: string;
}) {
  const matrix = useMemo(() => buildMatrix(value), [value]);
  const wallet = PAYMENT_METHODS[method];
  const span = MODULES + QUIET_ZONE * 2;

  return (
    <div
      className={cn(
        // Always a light plate with dark modules, in both themes. A QR that
        // inverts with the theme is a QR nothing can scan, and every wallet app
        // shows codes on white for the same reason.
        "rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/10",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${span} ${span}`}
        role="img"
        aria-label={`Demo ${wallet.label} payment code`}
        className="block h-auto w-full"
        shapeRendering="crispEdges"
      >
        {matrix.map((row, r) =>
          row.map((cell, c) => {
            if (cell === "light") return null;
            return (
              <rect
                key={`${r}-${c}`}
                x={c + QUIET_ZONE}
                y={r + QUIET_ZONE}
                width={1}
                height={1}
                // Eyes take the wallet's brand colour the way both apps style
                // their own codes; data modules stay near-black.
                fill={cell === "eye" ? wallet.accent : "#111827"}
              />
            );
          }),
        )}
      </svg>
      {/* Below the code rather than over it — a badge sitting on the modules
          would cover the alignment square and stop it reading as a code. */}
      <div className="mt-2 flex justify-center">
        <span
          className="rounded-full px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white"
          style={{ backgroundColor: wallet.accent }}
        >
          {wallet.label} · demo
        </span>
      </div>
    </div>
  );
}
