"use client";
import { useMemo, useSyncExternalStore } from "react";
import { ITEMS, SHELF_EPOCH_DAY, SHELF_POOL, type CatalogItem } from "./constants";

const MS_PER_MINUTE = 60_000;
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

function subscribe(onChange: () => void): () => void {
  const id = setInterval(onChange, MS_PER_MINUTE);
  return () => clearInterval(id);
}

function getSnapshot(): number | null {
  return Math.floor(Date.now() / MS_PER_MINUTE);
}

// During SSR and hydration we have no clock we can trust, so render the default (epoch) shelf.
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
  const minute = useSyncExternalStore<number | null>(subscribe, getSnapshot, getServerSnapshot);
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
