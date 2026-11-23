"use client";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { ITEMS, ODDS_DISPLAY } from "../lib/constants";

const WalletMultiButtonDynamic = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

interface Props {
  onBuy: (itemId: number) => void;
}

export function StorefrontSection({ onBuy }: Props) {
  const { connected } = useWallet();

  return (
    <section>
      <div className="mb-8 p-4 bg-pm-surface border border-pm-border rounded-xl flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-pm-text">Every purchase includes a private spin</p>
          <p className="text-xs text-pm-muted mt-0.5">Odds: {ODDS_DISPLAY}</p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-1 bg-pm-gold/10 text-pm-gold border border-pm-gold/20 rounded">1% FREE</span>
          <span className="px-2 py-1 bg-green-900/20 text-green-400 border border-green-800/30 rounded">6% 50% off</span>
          <span className="px-2 py-1 bg-blue-900/20 text-blue-400 border border-blue-800/30 rounded">18% 25% off</span>
          <span className="px-2 py-1 bg-pm-card text-pm-muted border border-pm-border rounded">+🔵 Shards always</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {ITEMS.map((item) => (
          <div
            key={item.id}
            className="group bg-pm-card border border-pm-border rounded-2xl p-5 flex flex-col gap-4 hover:border-pm-gold/40 transition-all duration-200 hover:shadow-lg hover:shadow-pm-gold/5"
          >
            <div className="w-14 h-14 rounded-xl bg-pm-surface flex items-center justify-center text-3xl">
              {item.emoji}
            </div>

            <div className="flex-1">
              <h3 className="font-semibold text-pm-text">{item.name}</h3>
              <p className="text-xs text-pm-muted mt-1 leading-relaxed">{item.description}</p>
            </div>

            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-pm-text">{item.priceDisplay}</span>
              <span className="text-xs text-pm-muted">on Devnet</span>
            </div>

            {connected ? (
              <button
                onClick={() => onBuy(item.id)}
                className="w-full py-2.5 bg-pm-gold text-pm-bg font-semibold rounded-xl text-sm hover:bg-amber-400 transition-colors active:scale-95"
              >
                Buy Now
              </button>
            ) : (
              <div className="text-center">
                <p className="text-xs text-pm-muted mb-2">Connect wallet to buy</p>
                <WalletMultiButtonDynamic className="!w-full !justify-center !text-sm" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-10 p-6 bg-pm-surface border border-pm-border rounded-2xl">
        <h3 className="text-sm font-semibold text-pm-text mb-4">How PayMaybe works</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {[
            { step: "1", label: "Pay on L1", desc: "SOL escrowed into Solana L1 vault" },
            { step: "2", label: "Private Spin", desc: "MagicBlock TEE hides your session" },
            { step: "3", label: "VRF Rolls", desc: "Provably fair randomness, <100ms" },
            { step: "4", label: "Claim / Sell", desc: "Cashback or sell Loyalty Shards anytime" },
          ].map(({ step, label, desc }) => (
            <div key={step} className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-pm-gold/20 text-pm-gold text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">
                {step}
              </span>
              <div>
                <p className="text-xs font-medium text-pm-text">{label}</p>
                <p className="text-xs text-pm-muted mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
