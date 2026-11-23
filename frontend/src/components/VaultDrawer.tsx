"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SHARD_VALUE_LAMPORTS, explorerTxUrl } from "../lib/constants";

interface Checkout {
  txSig: string;
  status: string;
  itemName: string;
  rebateBps: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  shardBalance: bigint;
  claimableLamports: bigint;
  onClaim: () => Promise<void>;
  onSellShards: (amount: bigint) => Promise<void>;
  onBurnForSpin: () => Promise<void>;
  lastCheckouts: Checkout[];
}

export function VaultDrawer({ isOpen, onClose, shardBalance, claimableLamports, onClaim, onSellShards, onBurnForSpin, lastCheckouts }: Props) {
  const [sellAmount, setSellAmount] = useState("10");
  const [loading, setLoading] = useState<string | null>(null);

  const claimSol = Number(claimableLamports) / 1e9;
  const shardSol = Number(shardBalance * SHARD_VALUE_LAMPORTS) / 1e9;

  const handle = async (key: string, fn: () => Promise<void>) => {
    setLoading(key);
    try { await fn(); } finally { setLoading(null); }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed right-0 top-0 h-full z-50 w-full max-w-sm bg-pm-surface border-l border-pm-border flex flex-col"
          >
            {/* Header */}
            <div className="p-6 border-b border-pm-border flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-pm-text">My Vault</h2>
                <p className="text-xs text-pm-muted">Cashback · Loyalty Shards</p>
              </div>
              <button onClick={onClose} className="text-pm-muted hover:text-pm-text text-xl">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Claimable SOL */}
              <div className="bg-pm-card border border-pm-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-pm-text">Claimable SOL</p>
                  {claimableLamports > 0n && <span className="text-xs text-pm-success bg-green-900/20 border border-green-800/30 rounded px-2 py-0.5">Ready</span>}
                </div>
                <p className={`text-2xl font-bold mb-3 ${claimableLamports > 0n ? "text-pm-success" : "text-pm-muted"}`}>
                  {claimSol.toFixed(4)} SOL
                </p>
                <button
                  disabled={claimableLamports === 0n || loading === "claim"}
                  onClick={() => handle("claim", onClaim)}
                  className="w-full py-2 bg-pm-success text-pm-bg font-semibold rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-300 transition-colors"
                >
                  {loading === "claim" ? "Claiming…" : "Claim SOL"}
                </button>
              </div>

              {/* Loyalty Shards */}
              <div className="bg-pm-card border border-pm-border rounded-xl p-4">
                <p className="text-sm font-medium text-pm-text mb-3">🔵 Loyalty Shards</p>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-2xl font-bold text-pm-text">{shardBalance.toString()}</span>
                  <span className="text-xs text-pm-muted">shards</span>
                </div>
                <p className="text-xs text-pm-muted mb-4">≈ {shardSol.toFixed(4)} SOL buyback value</p>

                {/* Sell shards */}
                <div className="flex gap-2 mb-3">
                  <input
                    type="number"
                    value={sellAmount}
                    onChange={e => setSellAmount(e.target.value)}
                    min="1"
                    max={shardBalance.toString()}
                    className="flex-1 bg-pm-surface border border-pm-border rounded-lg px-3 py-2 text-sm text-pm-text focus:outline-none focus:border-pm-gold"
                    placeholder="Amount"
                  />
                  <button
                    disabled={shardBalance === 0n || loading === "sell"}
                    onClick={() => handle("sell", () => onSellShards(BigInt(sellAmount || "0")))}
                    className="px-3 py-2 bg-pm-gold text-pm-bg font-semibold rounded-lg text-sm disabled:opacity-40 hover:bg-amber-400 transition-colors"
                  >
                    {loading === "sell" ? "…" : "Sell → SOL"}
                  </button>
                </div>

                {/* Burn for spin */}
                <button
                  disabled={shardBalance < 10n || loading === "burn"}
                  onClick={() => handle("burn", onBurnForSpin)}
                  className="w-full py-2 bg-pm-surface border border-pm-border text-pm-text rounded-lg text-sm disabled:opacity-40 hover:border-pm-gold/40 transition-colors"
                >
                  {loading === "burn" ? "Burning…" : "🔥 Burn 10 Shards → Free Spin"}
                </button>
              </div>

              {/* Recent activity */}
              {lastCheckouts.length > 0 && (
                <div>
                  <p className="text-xs text-pm-muted mb-3 font-medium uppercase tracking-wider">Recent Checkouts</p>
                  <div className="space-y-2">
                    {lastCheckouts.map((c, i) => (
                      <div key={i} className="flex items-center justify-between p-3 bg-pm-card border border-pm-border rounded-lg">
                        <div>
                          <p className="text-xs font-medium text-pm-text">{c.itemName}</p>
                          <a href={explorerTxUrl(c.txSig)} target="_blank" rel="noopener noreferrer" className="text-xs text-pm-gold hover:underline font-mono">
                            {c.txSig.slice(0, 12)}… ↗
                          </a>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded ${c.rebateBps >= 10000 ? "bg-pm-gold/10 text-pm-gold" : c.rebateBps > 0 ? "bg-green-900/20 text-green-400" : "bg-pm-bg text-pm-muted"}`}>
                          {c.rebateBps >= 10000 ? "FREE!" : c.rebateBps > 0 ? `${c.rebateBps / 100}% off` : "Shards"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {lastCheckouts.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-pm-muted text-sm">No checkouts yet.</p>
                  <p className="text-pm-subtle text-xs mt-1">Buy something from the store to get started.</p>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
