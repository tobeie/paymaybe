"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { StorefrontSection } from "../components/StorefrontSection";
import { SpinModal } from "../components/SpinModal";
import { VaultDrawer } from "../components/VaultDrawer";
import { usePayMaybe } from "../hooks/usePayMaybe";
import { ITEMS } from "../lib/constants";

const WalletMultiButtonDynamic = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export default function Home() {
  const [showVault, setShowVault] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const { state, checkout, claimRebate, sellShards, verifyPrivacy } = usePayMaybe();

  const showModal = selectedItemId !== null && state.phase !== "idle";

  const handleBuy = async (itemId: number) => {
    setSelectedItemId(itemId);
    await checkout(itemId);
  };

  const handleCloseModal = () => {
    if (state.phase === "done" || state.phase === "idle") {
      setSelectedItemId(null);
    }
  };

  const selectedItem = selectedItemId !== null ? ITEMS[selectedItemId] : null;

  return (
    <div className="min-h-screen bg-pm-bg">
      <header className="border-b border-pm-border bg-pm-surface/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-pm-gold tracking-tight">PayMaybe</span>
            <span className="hidden sm:inline text-xs text-pm-muted border border-pm-border rounded px-2 py-0.5 font-mono">
              Solana · MagicBlock ER
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowVault(true)}
              className="text-sm text-pm-muted hover:text-pm-text border border-pm-border rounded-lg px-3 py-1.5 transition-colors"
            >
              Vault 🏦
            </button>
            <WalletMultiButtonDynamic />
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 pt-16 pb-8 text-center">
        <div className="inline-flex items-center gap-2 bg-pm-card border border-pm-border rounded-full px-4 py-1.5 text-xs text-pm-muted mb-6">
          <span className="w-1.5 h-1.5 bg-pm-success rounded-full animate-pulse" />
          Live on Solana Devnet · MagicBlock Private ER
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold text-pm-text mb-4 tracking-tight">
          Buy Now, <span className="text-pm-gold">Pay Maybe</span>
        </h1>
        <p className="text-pm-muted text-lg max-w-xl mx-auto">
          Every checkout gives you an instant, provably fair chance to pay nothing —
          privately inside a MagicBlock Ephemeral Rollup.
        </p>
      </div>

      <main className="max-w-5xl mx-auto px-6 pb-24">
        <StorefrontSection onBuy={handleBuy} />

        {state.error && (
          <div className="mt-6 p-4 bg-pm-error/10 border border-pm-error/30 rounded-xl text-pm-error text-sm">
            ⚠️ {state.error}
          </div>
        )}
      </main>

      {showModal && selectedItem && (
        <SpinModal
          isOpen={showModal}
          onClose={handleCloseModal}
          itemName={selectedItem.name}
          itemEmoji={selectedItem.emoji}
          priceDisplay={selectedItem.priceDisplay}
          phase={state.phase}
          txSigs={state.txSigs}
          privacyProof={state.privacyProof}
          result={state.result}
          onVerifyPrivacy={() => {
            void verifyPrivacy();
          }}
        />
      )}

      <VaultDrawer
        isOpen={showVault}
        onClose={() => setShowVault(false)}
        shardBalance={state.shardBalance}
        claimableLamports={state.claimableLamports}
        onClaim={claimRebate}
        onSellShards={sellShards}
        onBurnForSpin={() => sellShards(10n)}
        lastCheckouts={[]}
      />
    </div>
  );
}
