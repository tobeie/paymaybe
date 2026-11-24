"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ReactNode } from "react";
import { usePayMaybeContext } from "./PayMaybeProvider";
import {
  PROGRAM_ID,
  formatSolShort,
  shortKey,
  explorerAddressUrl,
} from "../lib/constants";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { state } = usePayMaybeContext();

  const isShop = pathname === "/" || pathname.startsWith("/checkout");
  const isVault = pathname === "/vault";
  const isFair = pathname === "/fair";

  const handleWalletClick = () => {
    if (connected) {
      router.push("/vault");
    } else {
      setVisible(true);
    }
  };

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <div className="topbar-in">
          <Link className="brand" href="/" aria-label="PayMaybe home">
            <svg className="brand-mark" viewBox="0 0 28 34" aria-hidden="true">
              <path
                d="M2 2h24v26l-3-2-3 2-3-2-3 2-3-2-3 2-3-2-3 2z"
                fill="#F6F5EF"
              />
              <path
                d="M7 9h14M7 14h9M7 20h14"
                stroke="#2E2B63"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
            <span>PayMaybe</span>
          </Link>

          <nav className="nav" aria-label="Main">
            <Link href="/" aria-current={isShop ? "page" : undefined}>
              Shop
            </Link>
            <Link href="/vault" aria-current={isVault ? "page" : undefined}>
              Vault
            </Link>
            <Link href="/fair" aria-current={isFair ? "page" : undefined}>
              Fair play
            </Link>
          </nav>

          <button
            className={`wallet-btn${connected ? " is-on" : ""}`}
            type="button"
            onClick={handleWalletClick}
            aria-label={
              connected && publicKey
                ? `Wallet ${shortKey(publicKey.toBase58())}, ${formatSolShort(state.walletBalanceLamports)} SOL. Open vault.`
                : "Connect Solana wallet"
            }
          >
            {connected && publicKey ? (
              <>
                <span>{shortKey(publicKey.toBase58())}</span>
                <span className="bal">{formatSolShort(state.walletBalanceLamports)} SOL</span>
              </>
            ) : (
              "Connect wallet"
            )}
          </button>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="foot">
        <div className="wrap foot-in">
          <p>
            PayMaybe · Solana Blitz v10 · Program{" "}
            <a
              href={explorerAddressUrl(PROGRAM_ID.toBase58())}
              target="_blank"
              rel="noopener noreferrer"
              className="mono-inline"
            >
              {shortKey(PROGRAM_ID.toBase58())}
            </a>
          </p>
          <p className="live-pill">
            <span className="pulse" aria-hidden="true" />
            Live on Solana Devnet · MagicBlock TEE
          </p>
        </div>
      </footer>

      <div className="toasts" aria-live="polite">
        {state.toasts.map((t) => (
          <div key={t.id} className="toast">
            <b>{t.title}</b>
            {t.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {t.txUrl && t.txLabel && (
              <div>
                <a href={t.txUrl} target="_blank" rel="noopener noreferrer">
                  {t.txLabel} ↗
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
