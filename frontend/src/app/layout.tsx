import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { WalletContextProvider } from "../components/WalletContextProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "PayMaybe — Buy Now, Pay Maybe",
  description: "Every checkout gives you a provably fair, private chance to get your purchase 100% free — powered by MagicBlock Private Ephemeral Rollups on Solana.",
  openGraph: {
    title: "PayMaybe — Buy Now, Pay Maybe",
    description: "Gamified confidential checkout on Solana + MagicBlock",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-pm-bg text-pm-text min-h-screen">
        <WalletContextProvider>
          {children}
        </WalletContextProvider>
      </body>
    </html>
  );
}
