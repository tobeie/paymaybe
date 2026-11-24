"use client";
import { createContext, useContext, ReactNode } from "react";
import { usePayMaybe } from "../hooks/usePayMaybe";

type PayMaybeContextValue = ReturnType<typeof usePayMaybe>;

const PayMaybeContext = createContext<PayMaybeContextValue | null>(null);

export function PayMaybeProvider({ children }: { children: ReactNode }) {
  const value = usePayMaybe();
  return <PayMaybeContext.Provider value={value}>{children}</PayMaybeContext.Provider>;
}

export function usePayMaybeContext(): PayMaybeContextValue {
  const ctx = useContext(PayMaybeContext);
  if (!ctx) {
    throw new Error("usePayMaybeContext must be used inside PayMaybeProvider");
  }
  return ctx;
}
