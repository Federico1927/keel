/** Hullwise mark: a hull on its waterline. Pure SVG, inherits the text colour. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 15.5h21l-2.7 5.2a3 3 0 0 1-2.66 1.6H10.86a3 3 0 0 1-2.66-1.6z" />
      <path d="M15 5.5v10" />
      <path d="M15 6.5l7 7.5h-7z" />
      <path d="M6 26.3c2.5 0 2.5-1.5 5-1.5s2.5 1.5 5 1.5 2.5-1.5 5-1.5 2.5 1.5 5 1.5" />
    </svg>
  );
}
