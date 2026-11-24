"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { SpinPhase, SpinResult } from "../hooks/usePayMaybe";
import { explorerTxUrl, explorerTeeTxUrl } from "../lib/constants";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  itemName: string;
  itemEmoji: string;
  priceDisplay: string;
  phase: SpinPhase;
  txSigs: Record<string, string>;
  privacyProof: string | null;
  privacyVerified: boolean;
  error: string | null;
  result: SpinResult | null;
  onVerifyPrivacy: () => void;
}

const STEPS: { key: SpinPhase[]; label: string; detail: string; isTee?: boolean }[] = [
  { key: ["escrowing"], label: "L1 Payment Escrowed", detail: "Fixed catalog price locked in Solana L1 StoreVault" },
  {
    key: ["delegating", "privacy"],
    label: "MagicBlock TEE Privacy",
    detail: "Permission Program hides state from strangers; owner reads via JWT",
  },
  {
    key: ["spinning"],
    label: "MagicBlock VRF Rolling…",
    detail: "Unbiased 64-bit verifiable randomness inside TEE",
    isTee: true,
  },
  { key: ["revealing", "done"], label: "Result Revealed!", detail: "Permission closed & state committed back to Solana L1" },
];

function getStepStatus(stepPhases: SpinPhase[], currentPhase: SpinPhase): "done" | "active" | "pending" {
  const phaseOrder: SpinPhase[] = ["idle", "escrowing", "delegating", "privacy", "spinning", "revealing", "done"];
  const currentIdx = phaseOrder.indexOf(currentPhase);
  const stepIdx = Math.max(...stepPhases.map((p) => phaseOrder.indexOf(p)));
  if (currentIdx > stepIdx) return "done";
  if (stepPhases.includes(currentPhase)) return "active";
  return "pending";
}

function rebateLabel(bps: number): { label: string; color: string; emoji: string } {
  if (bps >= 10000) return { label: "100% FREE! Full Refund! 🎉", color: "text-pm-gold", emoji: "🏆" };
  if (bps >= 5000) return { label: "50% Off!", color: "text-green-400", emoji: "🎁" };
  if (bps >= 2500) return { label: "25% Off!", color: "text-blue-400", emoji: "🎫" };
  return { label: "Loyalty Shards Earned!", color: "text-pm-muted", emoji: "🔵" };
}

export function SpinModal({
  isOpen,
  onClose,
  itemName,
  itemEmoji,
  priceDisplay,
  phase,
  txSigs,
  privacyProof,
  privacyVerified,
  error,
  result,
  onVerifyPrivacy,
}: Props) {
  const [showPrivacyProof, setShowPrivacyProof] = useState(false);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={phase === "done" || phase === "idle" ? onClose : undefined}
          />

          {/* Modal */}
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="relative bg-pm-surface border border-pm-border rounded-2xl w-full max-w-md p-6 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{itemEmoji}</span>
                <div>
                  <h2 className="font-semibold text-pm-text">{itemName}</h2>
                  <p className="text-xs text-pm-muted">
                    {priceDisplay} · {phase === "done" ? "Spin Complete" : "Private TEE Spin in Progress"}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close modal"
                className="text-pm-muted hover:text-pm-text text-lg leading-none px-2 py-1 rounded hover:bg-pm-card transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Steps */}
            <div className="space-y-3 mb-6">
              {STEPS.map(({ key, label, detail, isTee }, i) => {
                const status = getStepStatus(key, phase);
                const sig = txSigs[key[0]];
                return (
                  <div
                    key={i}
                    className={`flex gap-3 p-3 rounded-xl transition-all ${
                      status === "active"
                        ? "bg-pm-card border border-pm-gold/30"
                        : status === "done"
                        ? "bg-pm-card/50"
                        : "opacity-40"
                    }`}
                  >
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 font-bold ${
                        status === "done"
                          ? "bg-pm-success text-pm-bg"
                          : status === "active"
                          ? "bg-pm-gold text-pm-bg animate-pulse-gold"
                          : "bg-pm-border text-pm-muted"
                      }`}
                    >
                      {status === "done" ? "✓" : status === "active" ? "●" : i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-pm-text">{label}</p>
                      <p className="text-xs text-pm-muted">{detail}</p>
                      {sig && (
                        <a
                          href={isTee ? explorerTeeTxUrl(sig) : explorerTxUrl(sig)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-pm-gold hover:underline font-mono mt-0.5 inline-block truncate max-w-full"
                        >
                          {sig.slice(0, 20)}… ↗
                        </a>
                      )}
                      {/* Live Dual-Read TEE Privacy Verification */}
                      {i === 1 && status !== "pending" && (
                        <div className="mt-2">
                          <button
                            onClick={() => {
                              setShowPrivacyProof((prev) => !prev);
                              onVerifyPrivacy();
                            }}
                            className="text-xs px-2 py-1 bg-pm-surface border border-pm-border rounded text-pm-muted hover:text-pm-text transition-colors"
                          >
                            🔍 Verify TEE Privacy
                          </button>
                          <AnimatePresence>
                            {(showPrivacyProof || privacyProof) && privacyProof && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                              >
                                <pre
                                  className={`mt-2 text-xs font-mono bg-pm-bg border border-pm-border rounded p-2 whitespace-pre-wrap break-all ${
                                    privacyVerified ? "text-green-400" : "text-amber-300"
                                  }`}
                                >
                                  {privacyProof}
                                </pre>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="mb-4 p-3 bg-pm-error/10 border border-pm-error/30 rounded-xl text-pm-error text-xs">
                ⚠️ {error}
              </div>
            )}

            {/* Result reveal */}
            <AnimatePresence>
              {result && (
                <motion.div
                  initial={{ rotateY: 90, opacity: 0 }}
                  animate={{ rotateY: 0, opacity: 1 }}
                  transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                  className="p-5 bg-pm-card border border-pm-border rounded-xl text-center mb-4"
                  style={{ perspective: 1000 }}
                >
                  <span className="text-4xl mb-3 block">{rebateLabel(result.rebateBps).emoji}</span>
                  <p className={`text-xl font-bold mb-1 ${rebateLabel(result.rebateBps).color}`}>
                    {rebateLabel(result.rebateBps).label}
                  </p>
                  <p className="text-xs text-pm-muted">
                    VRF Roll: {result.rollBps}/9999 ({(result.rollBps / 100).toFixed(2)}%) ·{" "}
                    {result.shardsEarned.toString()} 🔵 Loyalty Shards earned
                  </p>
                  {result.rebateLamports > 0n && (
                    <p className="text-sm text-pm-success mt-2 font-medium">
                      +{(Number(result.rebateLamports) / 1e9).toFixed(4)} SOL claimable
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Close button */}
            {(phase === "done" || phase === "idle") && (
              <button
                onClick={onClose}
                className="w-full py-3 bg-pm-gold text-pm-bg font-semibold rounded-xl hover:bg-amber-400 transition-colors"
              >
                {result && result.rebateLamports > 0n ? "Claim in Vault 🏦" : "Done"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
