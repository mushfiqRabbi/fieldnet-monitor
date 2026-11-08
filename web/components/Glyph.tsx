export type GlyphName =
  | "check"
  | "cross"
  | "warn"
  | "circle"
  | "question"
  | "pause"
  | "dash"
  | "clock"
  | "ban";

/** Small inline icons so no state depends on colour alone. Decorative: the label text always accompanies them. */
export function Glyph({ name }: { name: GlyphName }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    className: "shrink-0",
  };
  switch (name) {
    case "check":
      return (
        <svg {...common}>
          <path d="M2 6.5l2.5 2.5L10 3.5" />
        </svg>
      );
    case "cross":
      return (
        <svg {...common}>
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      );
    case "warn":
      return (
        <svg {...common} strokeWidth={1.5}>
          <path d="M6 1.5L11 10.5H1Z" />
          <path d="M6 5v2.4M6 9h.01" />
        </svg>
      );
    case "circle":
      return (
        <svg {...common} strokeWidth={1.5}>
          <circle cx="6" cy="6" r="3.5" />
        </svg>
      );
    case "question":
      return (
        <svg {...common} strokeWidth={1.6}>
          <path d="M4.2 4.6a1.9 1.9 0 113.2 1.4c-.7.5-1.4.9-1.4 1.8M6 10.2h.01" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <rect x="2.5" y="2" width="2.5" height="8" rx=".5" />
          <rect x="7" y="2" width="2.5" height="8" rx=".5" />
        </svg>
      );
    case "dash":
      return (
        <svg {...common}>
          <path d="M2.5 6h7" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common} strokeWidth={1.5}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.8 1" />
        </svg>
      );
    case "ban":
      return (
        <svg {...common} strokeWidth={1.5}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M2.8 9.2l6.4-6.4" />
        </svg>
      );
  }
}
