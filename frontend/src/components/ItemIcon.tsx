import type { ItemIconKey } from "../lib/constants";

export function ItemIcon({ icon, className = "tag-icon" }: { icon: ItemIconKey; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon === "cup" && (
        <>
          <path d="M14 24h30v14a13 13 0 0 1-13 13h-4a13 13 0 0 1-13-13z" />
          <path d="M44 28h4a6 6 0 0 1 0 12h-5" />
          <path d="M22 9c-2 3 2 5 0 8M30 9c-2 3 2 5 0 8M38 9c-2 3 2 5 0 8" />
          <path d="M10 57h40" />
        </>
      )}
      {icon === "hoodie" && (
        <>
          <path d="M22 9c2 6 18 6 20 0l10 6 7 17-8 4-3-7v28H16V29l-3 7-8-4 7-17z" />
          <path d="M26 11c0 9 12 9 12 0" />
          <path d="M23 43h18v7H23z" />
          <path d="M29 17v9M35 17v9" />
        </>
      )}
      {icon === "ticket" && (
        <>
          <path d="M7 17h50v9a6 6 0 0 0 0 12v9H7v-9a6 6 0 0 0 0-12z" />
          <path d="M41 17v30" strokeDasharray="3 4" />
          <path d="M15 27h18M15 35h11" />
        </>
      )}
      {icon === "box" && (
        <>
          <path d="M7 22l25-10 25 10-25 10z" />
          <path d="M7 22v24l25 11 25-11V22" />
          <path d="M32 32v25" />
          <path d="M16 26.5l25-10" />
        </>
      )}
    </svg>
  );
}
