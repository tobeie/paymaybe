"use client";
import { useMemo } from "react";
import { usePayMaybeContext } from "../../components/PayMaybeProvider";
import { deriveStoreVaultPda } from "../../hooks/usePayMaybe";
import {
  PROGRAM_ID,
  TEE_RPC,
  tierOfRoll,
  formatRoll,
  shortKey,
  explorerAddressUrl,
} from "../../lib/constants";

export default function FairPlayPage() {
  const { state } = usePayMaybeContext();
  const storeVault = useMemo(() => deriveStoreVaultPda().toBase58(), []);

  const rolls = state.history.slice(0, 30);
  const lastRoll = rolls[0] ?? null;

  const legend = (() => {
    if (!lastRoll) {
      return "Your live VRF rolls show up as pins on this strip as you check out.";
    }
    const tier = tierOfRoll(lastRoll.rollBps);
    const whatMap = {
      free: "free",
      half: "half back",
      quarter: "25% back",
      none: "shards only",
    } as const;
    const what = whatMap[tier.key];
    if (rolls.length === 1) {
      return `Your last roll was ${formatRoll(lastRoll.rollBps)} (${what}).`;
    }
    const earlier = rolls.length - 1;
    return `Your last roll was ${formatRoll(lastRoll.rollBps)} (${what}). Yellow marks it; white marks your earlier ${earlier === 1 ? "roll" : `${earlier} rolls`}.`;
  })();

  return (
    <section className="wrap fair" aria-labelledby="h-fair">
      <div className="section-head">
        <h1 id="h-fair">Fair play</h1>
        <p>
          Every spin draws one unbiased number from 0 to 9,999. Where it lands on this strip
          decides what you get back.
        </p>
      </div>

      {/* Proportional 0–9,999 Number Line Strip */}
      <div className="strip-wrap">
        <div
          className="strip"
          role="img"
          aria-label="Number line from 0 to 9,999: 0 to 7,499 earns shards, 7,500 to 9,299 is 25% back, 9,300 to 9,899 is half back, 9,900 to 9,999 is free."
        >
          <span className="seg seg-none" style={{ flex: 75 }}>
            <i>Shards</i>
          </span>
          <span className="seg seg-quarter" style={{ flex: 18 }}>
            <i>25%</i>
          </span>
          <span className="seg seg-half" style={{ flex: 6 }}>
            <i>50%</i>
          </span>
          <span className="seg seg-free" style={{ flex: 1 }}>
            <i>Free</i>
          </span>
          <div className="strip-marks">
            {rolls.map((r, i) => (
              <span
                key={`${r.settleSig}-${i}`}
                className={i === 0 ? "last" : undefined}
                style={{ left: `${(r.rollBps / 9999) * 100}%` }}
                title={`#${r.receiptNo} · Roll ${formatRoll(r.rollBps)}`}
              />
            ))}
          </div>
        </div>
        <div className="strip-scale" aria-hidden="true">
          <span>0</span>
          <span>7,500</span>
          <span>9,300</span>
          <span>9,999</span>
        </div>
        <p className="strip-legend">{legend}</p>
      </div>

      {/* Exact Odds Table */}
      <table className="odds">
        <caption>What each roll pays</caption>
        <thead>
          <tr>
            <th scope="col">Roll</th>
            <th scope="col">Chance</th>
            <th scope="col">Cashback</th>
            <th scope="col">Shards</th>
          </tr>
        </thead>
        <tbody>
          <tr className="t-free">
            <td>9,900 – 9,999</td>
            <td>1%</td>
            <td>100% of the price</td>
            <td>10</td>
          </tr>
          <tr className="t-half">
            <td>9,300 – 9,899</td>
            <td>6%</td>
            <td>50%</td>
            <td>25</td>
          </tr>
          <tr className="t-quarter">
            <td>7,500 – 9,299</td>
            <td>18%</td>
            <td>25%</td>
            <td>50</td>
          </tr>
          <tr className="t-none">
            <td>0 – 7,499</td>
            <td>75%</td>
            <td>None</td>
            <td>100</td>
          </tr>
        </tbody>
      </table>

      <div className="fair-cols">
        <div>
          <h2>Why nobody can rig it</h2>
          <p>
            The 32-byte randomness comes from MagicBlock&apos;s verifiable random function. The
            program verifies the scoped VRF identity signer at compile time, reduces the first 8
            bytes modulo 10,000 (<span className="mono-inline">u64 % 10_000</span>, modulo bias
            under 10⁻¹⁵), and evaluates it against <span className="mono-inline">tier_odds_bps</span>{" "}
            stored on-chain.
          </p>
          <p>
            Each checkout transitions strictly <span className="mono-inline">Idle → Paid → PendingVrf → Resolved</span>{" "}
            and zeroes <span className="mono-inline">pending_amount</span> inside the VRF callback,
            so one payment always produces exactly one spin.
          </p>
        </div>

        <div>
          <h2>Verify live on Solana Devnet</h2>
          <ul className="plain">
            <li>
              Program:{" "}
              <a
                href={explorerAddressUrl(PROGRAM_ID.toBase58())}
                target="_blank"
                rel="noopener noreferrer"
                className="mono-inline"
              >
                {shortKey(PROGRAM_ID.toBase58())} ↗
              </a>
            </li>
            <li>
              Store vault (<span className="mono-inline">store_v2</span>):{" "}
              <a
                href={explorerAddressUrl(storeVault)}
                target="_blank"
                rel="noopener noreferrer"
                className="mono-inline"
              >
                {shortKey(storeVault)} ↗
              </a>
            </li>
            <li>
              Private rollup (Intel TDX TEE):{" "}
              <span className="mono-inline">{TEE_RPC}</span>
            </li>
            <li>
              Every receipt barcode and transaction link opens directly on Solana Explorer.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
