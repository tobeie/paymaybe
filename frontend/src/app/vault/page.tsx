"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePayMaybeContext } from "../../components/PayMaybeProvider";
import {
  ITEMS,
  SHARD_VALUE_LAMPORTS,
  tierOfBps,
  formatSol,
  formatRoll,
  formatReceiptDate,
  shortKey,
  explorerTxUrl,
} from "../../lib/constants";

export default function VaultPage() {
  const { connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { state, claimRebate, sellShards, refreshAccount } = usePayMaybeContext();

  const totalShardsNum = Number(state.shardBalance);
  const sliderStep = totalShardsNum >= 10 && totalShardsNum % 10 === 0 ? 10 : 1;

  const [sellQty, setSellQty] = useState<number>(totalShardsNum);
  const [busyAction, setBusyAction] = useState<"claim" | "sell" | null>(null);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    setSellQty(totalShardsNum);
  }, [totalShardsNum]);

  const winsCount = state.history.filter((h) => BigInt(h.rebateLamports) > 0n).length;
  const chipCount = Math.min(80, Math.ceil(totalShardsNum / 10));
  const chipCols = Array.from({ length: Math.ceil(chipCount / 10) }, (_, c) =>
    Math.min(10, chipCount - c * 10)
  );

  const handleClaim = async () => {
    setBusyAction("claim");
    try {
      await claimRebate();
    } finally {
      setBusyAction(null);
    }
  };

  const handleSell = async () => {
    if (sellQty <= 0) return;
    setBusyAction("sell");
    try {
      await sellShards(BigInt(sellQty));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="wrap vault" aria-labelledby="h-vault">
      <div className="vault-head-row">
        <div className="section-head">
          <h1 id="h-vault">Your vault</h1>
          <p>
            Cashback you&apos;ve won and shards you&apos;ve earned. Both pay out directly from the
            store&apos;s vault on Solana.
          </p>
        </div>

        <div>
          {connected ? (
            <button type="button" className="link-btn" onClick={() => void disconnect()}>
              Disconnect wallet
            </button>
          ) : (
            <button type="button" className="btn btn-key" onClick={() => setVisible(true)}>
              Connect wallet
            </button>
          )}
        </div>
      </div>

      {state.error && (
        <p className="pay-note err" style={{ marginBottom: 20 }}>
          {state.error}
        </p>
      )}

      <div className="vault-grid">
        {/* Cashback Slip */}
        <article className="slip" aria-labelledby="h-cash">
          <h2 id="h-cash">Cashback</h2>
          <p className="slip-amount">
            <span>{formatSol(state.claimableLamports)}</span> <small>SOL</small>
          </p>
          <p className="slip-note">
            {!connected
              ? "Connect your wallet to read your on-chain cashback balance."
              : state.claimableLamports > 0n
              ? winsCount > 0
                ? `From ${winsCount} winning spin${winsCount === 1 ? "" : "s"}. Claiming sends it straight to your wallet on Solana.`
                : "Ready to withdraw from the store vault to your wallet on Solana."
              : "Nothing to claim yet. Cashback from a winning spin lands here."}
          </p>
          <button
            className="btn btn-key btn-wide"
            type="button"
            disabled={!connected || state.claimableLamports === 0n || busyAction !== null}
            onClick={() => void handleClaim()}
          >
            {busyAction === "claim" ? "Claiming…" : "Claim cashback"}
          </button>
        </article>

        {/* Loyalty Shards Chip Stack */}
        <article className="chips" aria-labelledby="h-shards">
          <div className="chips-head">
            <h2 id="h-shards">Shards</h2>
            <p className="chips-count">{totalShardsNum.toLocaleString("en-US")}</p>
          </div>

          <div className="chip-stack" aria-hidden="true">
            {totalShardsNum === 0 ? (
              <p className="chip-empty">No shards yet. Every spin earns some.</p>
            ) : (
              chipCols.map((n, colIdx) => (
                <div key={colIdx} className="chip-col">
                  {Array.from({ length: n }, (_, j) => (
                    <i key={j} />
                  ))}
                </div>
              ))
            )}
          </div>

          <p className="chips-rate">
            Each shard sells back for 100 lamports on Solana L1. You earn 10 to 100 on every spin.
          </p>

          <div className="sell">
            <label htmlFor="sellRange">
              Sell <b>{sellQty.toLocaleString("en-US")}</b> shards for{" "}
              <b>{formatSol(BigInt(sellQty) * SHARD_VALUE_LAMPORTS, 7)}</b> SOL
            </label>
            <input
              type="range"
              id="sellRange"
              min={0}
              max={totalShardsNum}
              step={sliderStep}
              value={sellQty}
              disabled={!connected || totalShardsNum === 0 || busyAction !== null}
              onChange={(e) => setSellQty(Number(e.target.value))}
            />
            <button
              className="btn btn-shard btn-wide"
              type="button"
              disabled={!connected || sellQty === 0 || busyAction !== null}
              onClick={() => void handleSell()}
            >
              {busyAction === "sell" ? "Selling…" : "Sell shards"}
            </button>
          </div>
        </article>
      </div>

      {/* Receipt Stubs History */}
      <div className="stubs-wrap">
        <h2>Your receipts</h2>
        <ul className="stubs">
          {state.history.length === 0 ? (
            <li className="stubs-empty">
              No receipts yet. Your checkouts will collect here.{" "}
              <Link href="/" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                Visit the shelf
              </Link>
              .
            </li>
          ) : (
            state.history.slice(0, 12).map((h, i) => {
              const t = tierOfBps(h.rebateBps);
              const it = ITEMS[h.itemId] ?? ITEMS[0];
              const price = BigInt(h.priceLamports);
              const rebate = BigInt(h.rebateLamports);
              const net = price >= rebate ? price - rebate : 0n;
              return (
                <li key={`${h.settleSig}-${i}`} className="stub">
                  <span className={`mini-stamp t-${t.key}`}>{t.mini}</span>
                  <b>#{h.receiptNo}</b>
                  <br />
                  {it.name.toUpperCase()}
                  <br />
                  ROLL {formatRoll(h.rollBps)}
                  <br />
                  PAID {formatSol(net)} SOL
                  <br />
                  <span className="r-muted">{formatReceiptDate(h.at)}</span>
                  {h.settleSig && (
                    <>
                      <br />
                      <a
                        href={explorerTxUrl(h.settleSig)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        TX {shortKey(h.settleSig)} ↗
                      </a>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </section>
  );
}
