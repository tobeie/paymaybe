import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        felt: "#0E4A38",
        "felt-deep": "#0A3A2C",
        chalk: "#E9F2EC",
        "chalk-soft": "#A9C2B6",
        paper: "#F6F5EF",
        "paper-shade": "#E7E5DC",
        ink: "#2E2B63",
        "ink-soft": "#6C69A0",
        stamp: "#D7263D",
        key: "#FFD23F",
        "key-edge": "#C99A12",
        shard: "#36C5F0",
        "shard-ink": "#137FAA",
      },
      fontFamily: {
        display: ["var(--font-display)", "Big Shoulders", "Arial Narrow", "Impact", "sans-serif"],
        ui: ["var(--font-ui)", "Hanken Grotesk", "system-ui", "sans-serif"],
        receipt: ["var(--font-receipt)", "Martian Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
