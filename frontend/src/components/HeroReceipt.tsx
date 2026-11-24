"use client";
import { useEffect, useRef, useState } from "react";
import { ITEMS, TIERS, formatSol, formatRoll, formatReceiptDate } from "../lib/constants";
import { OdometerReel } from "./OdometerReel";
import { ReceiptBarcode } from "./ReceiptBarcode";

const EXAMPLE_ITEM = ITEMS[3]; // Mystery Rollup Box · 0.15 SOL
const EXAMPLE_ROLL = 9942;

export function HeroReceipt() {
  const [stage, setStage] = useState(0);
  const [scrRoll, setScrRoll] = useState("----");
  const [runId, setRunId] = useState(0);
  const [timestamp] = useState(() => Date.now());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    if (reduced) {
      setScrRoll(formatRoll(EXAMPLE_ROLL));
      setStage(8);
      return;
    }

    setStage(0);
    setScrRoll("----");

    const schedule = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      timersRef.current.push(t);
    };

    schedule(260, () => setStage(1)); // header + item
    schedule(520, () => setStage(2)); // ESCROW ...
    schedule(1150, () => setStage(3)); // ESCROW HELD + SESSION ...
    schedule(1800, () => setStage(4)); // SESSION PRIVATE + VRF ROLL + spinning reel
    schedule(3150, () => {
      setScrRoll(formatRoll(EXAMPLE_ROLL));
      setStage(5); // VRF landed -> reel lands on 0.0000
    });
    schedule(3950, () => setStage(6)); // cashback + shards + barcode
    schedule(4150, () => setStage(7)); // rubber stamp slams!
    schedule(4700, () => setStage(8)); // SETTLED SOLANA

    // Scramble roll readout smoothly while stage === 4
    let interval: ReturnType<typeof setInterval> | null = null;
    schedule(1820, () => {
      const digits = new Uint16Array(1);
      interval = setInterval(() => {
        crypto.getRandomValues(digits);
        setScrRoll(formatRoll(digits[0] % 10000));
      }, 65);
    });
    schedule(3130, () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      setScrRoll(formatRoll(EXAMPLE_ROLL));
    });

    return () => {
      timersRef.current.forEach(clearTimeout);
      if (interval) clearInterval(interval);
    };
  }, [runId]);

  const reelSpinning = stage === 4;
  const reelValue = stage >= 5 ? "0.0000" : formatSol(EXAMPLE_ITEM.priceLamports);
  const stampVisible = stage >= 7;

  return (
    <figure className="hero-stage">
      <div className="receipt-host receipt-host--hero">
        <div className="printer">
          <div className="printer-slot" />
          <div className="feed">
            <div className={`receipt${stampVisible ? " thud" : ""}`} role="group" aria-label="Example free roll receipt">
              <div className="r-body">
                <div className="r-center r-store">PAYMAYBE STORE</div>
                <div className="r-center r-muted">EXAMPLE PREVIEW  #0001</div>
                <div className="r-center r-muted">{formatReceiptDate(timestamp)}</div>

                {stage >= 1 && (
                  <>
                    <hr className="r-rule printing" />
                    <div className="r-line printing">
                      <span className="l">{EXAMPLE_ITEM.name.toUpperCase()}</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">{formatSol(EXAMPLE_ITEM.priceLamports)}</span>
                    </div>
                    <div className="r-sub printing">INCLUDES 1 SPIN</div>
                    <hr className="r-rule printing" />
                  </>
                )}

                {stage >= 2 && (
                  <>
                    <div className="r-line printing">
                      <span className="l">ESCROW</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">
                        {stage >= 3 ? <span className="r-ok">HELD</span> : <span className="r-wait" />}
                      </span>
                    </div>
                    {stage >= 3 && <div className="r-sub printing">SOLANA L1 STORE VAULT</div>}
                  </>
                )}

                {stage >= 3 && (
                  <>
                    <div className="r-line printing">
                      <span className="l">SESSION</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">
                        {stage >= 4 ? <span className="r-ok">PRIVATE</span> : <span className="r-wait" />}
                      </span>
                    </div>
                    {stage >= 4 && <div className="r-sub printing">MAGICBLOCK PRIVATE ROLLUP</div>}
                  </>
                )}

                {stage >= 4 && (
                  <>
                    <div className="r-line printing">
                      <span className="l">VRF ROLL</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">{scrRoll}</span>
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

                {stage >= 6 && (
                  <>
                    <div className="r-line printing">
                      <span className="l">CASHBACK</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">{formatSol(EXAMPLE_ITEM.priceLamports)}</span>
                    </div>
                    <div className="r-line printing">
                      <span className="l">SHARDS</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">+{TIERS.free.shards}</span>
                    </div>
                    <div className="r-line printing">
                      <span className="l">SETTLED</span>
                      <span className="fill" aria-hidden="true" />
                      <span className="r">
                        {stage >= 8 ? <span className="r-ok">SOLANA</span> : <span className="r-wait" />}
                      </span>
                    </div>
                    <ReceiptBarcode
                      seed="BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX"
                      caption="EXAMPLE · 1 IN 100"
                    />
                  </>
                )}
              </div>

              <div
                className={`stamp t-free${stampVisible ? " on" : ""}`}
                aria-hidden={!stampVisible}
              >
                {TIERS.free.stamp}
                <small>{TIERS.free.sub}</small>
              </div>
            </div>
          </div>
        </div>
      </div>

      <figcaption className="hero-cap">
        <span>An example free roll, printed. It happens on 1 checkout in 100.</span>
        <button
          className="link-btn"
          type="button"
          onClick={() => setRunId((n) => n + 1)}
        >
          Print again
        </button>
      </figcaption>
    </figure>
  );
}
