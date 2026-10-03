import { cn } from "../lib/utils";

export function AppLogo({ className }: { className?: string }) {
  return (
    <svg
      className={cn("app-logo", className)}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-slot="app-logo"
    >
      <rect x="3" y="3" width="26" height="26" rx="6" fill="var(--accent)" />
      <path
        d="M9 10 16 23 23 10"
        fill="none"
        stroke="var(--accent-text)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
