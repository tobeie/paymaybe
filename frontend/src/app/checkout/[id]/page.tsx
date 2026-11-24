"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePayMaybeContext } from "../../../components/PayMaybeProvider";
import { OdometerReel } from "../../../components/OdometerReel";
import { ReceiptBarcode } from "../../../components/ReceiptBarcode";
import {
  ITEMS,
  tierOfBps,
  formatSol,
  formatSolShort,
  formatRoll,
  formatReceiptDate,
  shortKey,
  explorerTxUrl,
  explorerTeeTxUrl,
} from "../../../lib/constants";

type StepVisual = "pending" | "active" | "done";

export default function CheckoutPage() {
  const params = useParams<{ id: string }>();
  const itemId = Number(params?.id);
  const item = Number.isInteger(itemId) && itemId >= 0 && itemId < ITEMS.length ? ITEMS[itemId] : null;

  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { state, checkout, resetCheckoutState, verifyPrivacy } = usePayMaybeContext();

  const [showCarbon, setShowCarbon] = useState(false);
  const [scrRoll, setScrRoll] = useState("----");
  const [orderTimestamp, setOrderTimestamp] = useState<number>(() => Date.now());
  const [recheckingPrivacy, setRecheckingPrivacy] = useState(false);

  // Reset checkout view when navigating to a different item (unless that item is already running)
  useEffect(() => {
    if (item && state.activeItemId !== null && state.activeItemId !== item.id && state.phase === "done") {
      resetCheckoutState();
    }
    setOrderTimestamp(Date.now());
    setShowCarbon(false);
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isForThisItem = item !== null && (state.activeItemId === null || state.activeItemId === item.id);
  const activePhase = isForThisItem ? state.phase : "idle";
  const activeResult = isForThisItem && state.result && state.result.itemId === item?.id ? state.result : null;
  const activeSigs = isForThisItem ? state.txSigs : {};
  const activeCarbon = isForThisItem ? state.carbon : null;

  // Scramble the 4-digit roll line on the receipt while waiting on MagicBlock VRF oracle
  useEffect(() => {
    if (activePhase !== "spinning") {
      if (activeResult) {
        setScrRoll(formatRoll(activeResult.rollBps));
      } else {
        setScrRoll("----");
      }
      return;
    }
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setScrRoll("....");
      return;
    }
    const buf = new Uint16Array(1);
    const id = setInterval(() => {
      crypto.getRandomValues(buf);
      setScrRoll(formatRoll(buf[0] % 10000));
    }, 65);
    return () => clearInterval(id);
  }, [activePhase, activeResult]);

  if (!item) {
    return (
      <section className="wrap checkout">
        <Link className="back" href="/">
          Back to the shelf
        </Link>
        <h1 className="checkout-title">Item not found</h1>
        <p className="checkout-sub">Pick an item from today&apos;s shelf to start a checkout.</p>
      </section>
    );
  }

  const isBusy = activePhase !== "idle" && activePhase !== "done";
  const isStarted = activePhase !== "idle";
  const minBalanceNeeded = item.priceLamports + 1_000_000n; // item price + ~0.001 SOL rent/fee buffer
  const insufficientSol = connected && state.walletBalanceLamports < minBalanceNeeded;

  const receiptNo = activeResult
    ? activeResult.receiptNo
    : String(state.totalCheckoutsOnChain + 1).padStart(4, "0");

  // Map real usePayMaybe phases to the 4 checkout step states
  const stepStates: Record<"escrow" | "sealed" | "roll" | "settle", StepVisual> = {
    escrow:
      activePhase === "escrowing"
        ? "active"
        : ["delegating", "privacy", "spinning", "revealing", "done"].includes(activePhase)
        ? "done"
        : "pending",
    sealed:
      activePhase === "delegating" || activePhase === "privacy"
        ? "active"
        : ["spinning", "revealing", "done"].includes(activePhase)
        ? "done"
        : "pending",
    roll:
      activePhase === "spinning"
        ? "active"
        : ["revealing", "done"].includes(activePhase)
        ? "done"
        : "pending",
    settle:
      activePhase === "revealing"
        ? "active"
        : activePhase === "done"
        ? "done"
        : "pending",
  };

  const tier = activeResult ? tierOfBps(activeResult.rebateBps) : null;
  const reelValue =
    activeResult && (activePhase === "revealing" || activePhase === "done")
      ? formatSol(activeResult.netLamports)
      : formatSol(item.priceLamports);
  const reelSpinning = activePhase === "spinning";
  const stampVisible = activePhase === "done" && tier !== null;

  const handlePayClick = async () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    if (isBusy || insufficientSol) return;
    if (typeof window !== "undefined" && window.innerWidth < 860) {
      const el = document.getElementById("checkoutReceipt");
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
    await checkout(item.id);
  };

  const handleRecheckPrivacy = async () => {
    setRecheckingPrivacy(true);
    try {
      await verifyPrivacy();
    } finally {
      setRecheckingPrivacy(false);
    }
  };

  const resultSummary = (() => {
    if (!activeResult || !tier) return "";
    if (tier.key === "free") {
      return `Free. All ${formatSol(activeResult.rebateLamports)} SOL is waiting in your vault.`;
    }
    if (tier.key === "half") {
      return `Half back. ${formatSol(activeResult.rebateLamports)} SOL is waiting in your vault.`;
    }
    if (tier.key === "quarter") {
      return `A quarter back. ${formatSol(activeResult.rebateLamports)} SOL is waiting in your vault.`;
    }
    return `No cashback this time. You earned ${activeResult.shardsEarned.toString()} shards.`;
  })();

  return (
    <section className="wrap checkout" aria-labelledby="h-checkout">
      <Link className="back" href="/">
        Back to the shelf
      </Link>

      <div className="checkout-grid">
        {/* Left: Live Thermal Receipt Printer (comes first on mobile) */}
        <div className="checkout-paper">
          <div id="checkoutReceipt" className="receipt-host">
            <div className="printer">
              <div className="printer-slot" />
              <div className="feed">
                <div
                  className={`receipt${stampVisible ? " thud" : ""}`}
                  role="group"
                  aria-label="Live checkout receipt"
                >
                  <div className="r-body">
                    <div className="r-center r-store">PAYMAYBE STORE</div>
                    <div className="r-center r-muted">SOLANA DEVNET  #{receiptNo}</div>
                    <div className="r-center r-muted">
                      {formatReceiptDate(activeResult?.settledAt ?? orderTimestamp)}
                    </div>
                    <hr className="r-rule" />
                    <div className="r-line">
                      <span className="l">{item.name.toUpperCase()}</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">{formatSol(item.priceLamports)}</span>
                    </div>
                    <div className="r-sub">INCLUDES 1 SPIN</div>
                    <hr className="r-rule" />

                    {/* Static order total before paying */}
                    {!isStarted && (
                      <div className="r-total">
                        <span className="l">TOTAL DUE</span>
                        <span>
                          <OdometerReel value={formatSol(item.priceLamports)} spinning={false} />{" "}
                          <span className="sol">SOL</span>
                        </span>
                      </div>
                    )}

                    {/* Step 1: L1 Escrow */}
                    {isStarted && (
                      <>
                        <div className="r-line printing">
                          <span className="l">ESCROW</span>
                          <span className="fill" aria-hidden="true" />
                          <span className="r">
                            {stepStates.escrow === "done" ? (
                              <span className="r-ok">HELD</span>
                            ) : (
                              <span className="r-wait" />
                            )}
                          </span>
                        </div>
                        {activeSigs.escrowing && (
                          <div className="r-sub printing">
                            <a
                              href={explorerTxUrl(activeSigs.escrowing)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              TX {shortKey(activeSigs.escrowing)} ↗
                            </a>
                          </div>
                        )}
                      </>
                    )}

                    {/* Step 2: MagicBlock TEE Session */}
                    {stepStates.sealed !== "pending" && (
                      <>
                        <div className="r-line printing">
                          <span className="l">SESSION</span>
                          <span className="fill" aria-hidden="true" />
                          <span className="r">
                            {stepStates.sealed === "done" ? (
                              <span className="r-ok">PRIVATE</span>
                            ) : (
                              <span className="r-wait" />
                            )}
                          </span>
                        </div>
                        {stepStates.sealed === "done" && (
                          <div className="r-sub printing">
                            {activeSigs.spinning ? (
                              <a
                                href={explorerTeeTxUrl(activeSigs.spinning)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                MAGICBLOCK TEE · {shortKey(activeSigs.spinning)} ↗
                              </a>
                            ) : (
                              "MAGICBLOCK PRIVATE ROLLUP"
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {/* Step 3: VRF Roll + Odometer Reel */}
                    {stepStates.roll !== "pending" && (
                      <>
                        <div className="r-line printing">
                          <span className="l">VRF ROLL</span>
                          <span className="fill" aria-hidden="true" />
                          <span className="r">
                            {activeResult ? formatRoll(activeResult.rollBps) : scrRoll}
                          </span>
                        </div>
                        <hr className="r-rule printing" />
                        <div className="r-total printing">
                          <span className="l">YOU PAY</span>
                          <span>
                            <OdometerReel value={reelValue} spinning={reelSpinning} />{" "}
                            <span className="sol">SOL</span>
                          </span>
                        </div>
                      </>
                    )}

                    {/* Step 4: Cashback, Shards, L1 Settlement & Barcode */}
                    {(activePhase === "revealing" || activePhase === "done") && activeResult && (
                      <>
                        {activeResult.rebateLamports > 0n && (
                          <div className="r-line printing">
                            <span className="l">CASHBACK</span>
                            <span className="fill" aria-hidden="true" />
                            <span className="r">{formatSol(activeResult.rebateLamports)}</span>
                          </div>
                        )}
                        <div className="r-line printing">
                          <span className="l">SHARDS</span>
                          <span className="fill" aria-hidden="true" />
                          <span className="r">+{activeResult.shardsEarned.toString()}</span>
                        </div>
                        <div className="r-line printing">
                          <span className="l">SETTLED</span>
                          <span className="fill" aria-hidden="true" />
                          <span className="r">
                            {activePhase === "done" ? (
                              <span className="r-ok">SOLANA</span>
                            ) : (
                              <span className="r-wait" />
                            )}
                          </span>
                        </div>
                        {activePhase === "done" && activeSigs.revealing && (
                          <ReceiptBarcode
                            seed={activeSigs.revealing}
                            href={explorerTxUrl(activeSigs.revealing)}
                          />
                        )}
                      </>
                    )}
                  </div>

                  {/* Rubber Stamp */}
                  <div
                    className={`stamp${tier ? ` t-${tier.key}` : ""}${stampVisible ? " on" : ""}`}
                    aria-hidden={!stampVisible}
                  >
                    {tier?.stamp}
                    {tier && <small>{tier.sub}</small>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Controls, Live Chain Steps, Real Carbon Copy TEE Comparison, Result */}
        <div className="checkout-side">
          <h1 id="h-checkout" className="checkout-title">
            {item.name}
          </h1>
          <p className="checkout-sub">
            You pay {formatSolShort(item.priceLamports)} SOL now. Your spin decides how much comes
            back.
          </p>

          {activePhase === "idle" && (
            <div className="pay-box">
              <button
                className="btn btn-key btn-wide"
                type="button"
                disabled={insufficientSol}
                onClick={() => void handlePayClick()}
              >
                {connected
                  ? `Pay ${formatSolShort(item.priceLamports)} SOL and spin`
                  : "Connect wallet"}
              </button>

              {!connected && (
                <p className="pay-note">
                  Switch Phantom to Solana Devnet. Need test SOL? Grab some at{" "}
                  <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">
                    faucet.solana.com
                  </a>
                  .
                </p>
              )}

              {connected && publicKey && !insufficientSol && !state.error && (
                <p className="pay-note">
                  Wallet {shortKey(publicKey.toBase58())} has{" "}
                  {formatSolShort(state.walletBalanceLamports)} devnet SOL.
                </p>
              )}

              {insufficientSol && (
                <p className="pay-note err">
                  Your wallet has {formatSol(state.walletBalanceLamports)} SOL, which isn&apos;t
                  enough for {formatSolShort(item.priceLamports)} SOL + fees. Top up at{" "}
                  <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">
                    faucet.solana.com
                  </a>
                  .
                </p>
              )}

              {state.error && <p className="pay-note err">Transaction error: {state.error}</p>}
            </div>
          )}

          {/* 4 Live On-Chain Steps */}
          <ol className="steps" aria-live="polite">
            <li className={stepStates.escrow === "pending" ? undefined : stepStates.escrow}>
              <span className="dot" aria-hidden="true" />
              <div>
                <b>Payment held</b>
                <small>SOL escrowed in the store vault on Solana</small>
                {activeSigs.escrowing && (
                  <a
                    className="step-tx"
                    href={explorerTxUrl(activeSigs.escrowing)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    TX {shortKey(activeSigs.escrowing)} ↗
                  </a>
                )}
              </div>
            </li>

            <li className={stepStates.sealed === "pending" ? undefined : stepStates.sealed}>
              <span className="dot" aria-hidden="true" />
              <div>
                <b>Spin sealed</b>
                <small>
                  Moved into MagicBlock Intel TDX TEE with Permission Program access control
                </small>
                {activeCarbon && (
                  <button
                    className="link-btn stranger-toggle"
                    type="button"
                    aria-expanded={showCarbon}
                    onClick={() => setShowCarbon((v) => !v)}
                  >
                    {showCarbon ? "Hide the comparison" : "Compare with a stranger's view"}
                  </button>
                )}
              </div>
            </li>

            <li className={stepStates.roll === "pending" ? undefined : stepStates.roll}>
              <span className="dot" aria-hidden="true" />
              <div>
                <b>Number drawn</b>
                <small>
                  {activeResult
                    ? `MagicBlock VRF drew ${formatRoll(activeResult.rollBps)} out of 9,999`
                    : "MagicBlock VRF, unbiased 0 to 9,999"}
                </small>
                {activeSigs.spinning && (
                  <a
                    className="step-tx"
                    href={explorerTeeTxUrl(activeSigs.spinning)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    TEE TX {shortKey(activeSigs.spinning)} ↗
                  </a>
                )}
              </div>
            </li>

            <li className={stepStates.settle === "pending" ? undefined : stepStates.settle}>
              <span className="dot" aria-hidden="true" />
              <div>
                <b>Settled</b>
                <small>Permission closed and result committed back to Solana</small>
                {activeSigs.revealing && (
                  <a
                    className="step-tx"
                    href={explorerTxUrl(activeSigs.revealing)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    L1 TX {shortKey(activeSigs.revealing)} ↗
                  </a>
                )}
              </div>
            </li>
          </ol>

          {/* Real Side-by-Side Carbon Copy TEE Privacy Comparison */}
          {showCarbon && activeCarbon && (
            <div className="carbon">
              <div className="carbon-col">
                <h3>Your copy</h3>
                <pre>{activeCarbon.yourCopy}</pre>
              </div>
              <div className="carbon-col carbon-col--stranger">
                <h3>A stranger&apos;s copy</h3>
                <pre>{activeCarbon.strangerCopy}</pre>
              </div>
              <div className="carbon-note">
                <span>{activeCarbon.note}</span>
                <button
                  type="button"
                  className="link-btn"
                  disabled={recheckingPrivacy}
                  onClick={() => void handleRecheckPrivacy()}
                >
                  {recheckingPrivacy ? "Reading TEE…" : "Re-read live"}
                </button>
              </div>
            </div>
          )}

          {/* Final Result */}
          {activePhase === "done" && activeResult && (
            <div className="result">
              <p className="result-line">{resultSummary}</p>
              <div className="result-actions">
                <Link className="btn btn-key" href="/vault">
                  {activeResult.rebateLamports > 0n ? "Claim in vault" : "See your shards"}
                </Link>
                <button
                  type="button"
                  className="btn btn-line"
                  onClick={() => {
                    resetCheckoutState();
                    setShowCarbon(false);
                    setOrderTimestamp(Date.now());
                  }}
                >
                  Spin again
                </button>
                <Link className="btn btn-line" href="/">
                  Back to the shelf
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
