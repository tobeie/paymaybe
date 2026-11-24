import type { Metadata } from "next";
import { Big_Shoulders, Hanken_Grotesk, Martian_Mono } from "next/font/google";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { WalletContextProvider } from "../components/WalletContextProvider";
import { PayMaybeProvider } from "../components/PayMaybeProvider";
import { AppShell } from "../components/AppShell";

const bigShoulders = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: false,
});

const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const martianMono = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-receipt",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PayMaybe — Buy now. Pay maybe.",
  description:
    "Every checkout is a provably fair spin. One in a hundred is free. Built on Solana with MagicBlock Private Ephemeral Rollups (TEE) and VRF.",
  openGraph: {
    title: "PayMaybe — Buy now. Pay maybe.",
    description: "Every checkout is a provably fair spin. One in a hundred is free.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${bigShoulders.variable} ${hankenGrotesk.variable} ${martianMono.variable}`}
    >
      <body>
        {/* Ink texture filter for rubber stamps */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <filter id="ink">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves={2}
              seed={7}
              result="n"
            />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={2.2} />
          </filter>
        </svg>

        <WalletContextProvider>
          <PayMaybeProvider>
            <AppShell>{children}</AppShell>
          </PayMaybeProvider>
        </WalletContextProvider>
      </body>
    </html>
  );
}
