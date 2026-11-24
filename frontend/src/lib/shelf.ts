"use client";
import { useMemo, useSyncExternalStore } from "react";
import { ITEMS, SHELF_EPOCH_DAY, SHELF_POOL, type CatalogItem } from "./constants";

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const SECONDS_PER_DAY = 86_400;
const MINUTES_PER_DAY = 1_440;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Pure function of the UTC day index: every visitor sees the same shelf on the same day. */
export function shelfForDay(dayIndex: number): readonly CatalogItem[] {
  return ITEMS.map((base) => {
    const pool = SHELF_POOL[base.id];
    if (!pool || pool.length === 0) return base;
    const pick = pool[mod(dayIndex - SHELF_EPOCH_DAY, pool.length)];
    return { ...base, name: pick.name, icon: pick.icon, description: pick.description };
  });
}

function subscribeMinute(onChange: () => void): () => void {
  const id = setInterval(onChange, MS_PER_MINUTE);
  return () => clearInterval(id);
}

function getMinuteSnapshot(): number | null {
  return Math.floor(Date.now() / MS_PER_MINUTE);
}

function subscribeSecond(onChange: () => void): () => void {
  const id = setInterval(onChange, MS_PER_SECOND);
  return () => clearInterval(id);
}

function getSecondSnapshot(): number | null {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

// During SSR and hydration we have no clock we can trust, so render the default (epoch) shelf
// and a steady "--:--:--" placeholder until the client mounts.
function getServerSnapshot(): number | null {
  return null;
}

export interface Shelf {
  items: readonly CatalogItem[];
  /** Drop number counted from the epoch day (null until the client clock is available). */
  dropNo: number | null;
  minutesUntilNext: number | null;
}

export function useShelf(): Shelf {
  const minute = useSyncExternalStore<number | null>(
    subscribeMinute,
    getMinuteSnapshot,
    getServerSnapshot
  );
  const day = minute === null ? null : Math.floor(minute / MINUTES_PER_DAY);
  const items = useMemo(() => (day === null ? ITEMS : shelfForDay(day)), [day]);

  if (minute === null || day === null) {
    return { items, dropNo: null, minutesUntilNext: null };
  }
  return {
    items,
    dropNo: Math.max(1, day - SHELF_EPOCH_DAY + 1),
    minutesUntilNext: (day + 1) * MINUTES_PER_DAY - minute,
  };
}

/** Hydration-safe per-second countdown ("HH:MM:SS") until the next 00:00 UTC shelf restock. */
export function useRestockCountdown(): string | null {
  const sec = useSyncExternalStore<number | null>(
    subscribeSecond,
    getSecondSnapshot,
    getServerSnapshot
  );
  if (sec === null) return null;
  const remaining = SECONDS_PER_DAY - (sec % SECONDS_PER_DAY);
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
