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
      {icon === "bolt" && <path d="M36 6 16 36h14l-4 22 22-32H34z" />}
      {icon === "cap" && (
        <>
          <path d="M12 38a20 20 0 0 1 40 0z" />
          <path d="M8 38h48" />
          <path d="M52 38c6 0 8 3 8 6H40" />
          <path d="M32 18v-4" />
        </>
      )}
      {icon === "chip" && (
        <>
          <rect x="18" y="18" width="28" height="28" rx="3" />
          <rect x="26" y="26" width="12" height="12" />
          <path d="M26 10v8M38 10v8M26 46v8M38 46v8M10 26h8M10 38h8M46 26h8M46 38h8" />
        </>
      )}
      {icon === "gamepad" && (
        <>
          <path d="M18 22h28a10 10 0 0 1 10 10v6a6 6 0 0 1-10 4l-4-4H22l-4 4A6 6 0 0 1 8 38v-6a10 10 0 0 1 10-10z" />
          <path d="M20 29v8M16 33h8" />
          <circle cx="42" cy="31" r="1.6" />
          <circle cx="47" cy="35" r="1.6" />
        </>
      )}
      {icon === "rocket" && (
        <>
          <path d="M32 6c10 6 14 18 12 30H20C18 24 22 12 32 6z" />
          <circle cx="32" cy="24" r="4" />
          <path d="M20 36l-8 10 10-2M44 36l8 10-10-2" />
          <path d="M28 44v8M36 44v8" />
        </>
      )}
    </svg>
  );
}
