/** Keel mark: a hull section with its keel. Pure SVG, inherits the text colour. */
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
      <path d="M4 10c0 10 6 16 12 16s12-6 12-16" />
      <path d="M16 6v20" />
      <path d="M4 10h24" />
    </svg>
  );
}
