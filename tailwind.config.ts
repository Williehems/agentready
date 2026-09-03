import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0b0d",
        surface: "#14161a",
        raised: "#1b1e23",
        line: "#24272c",
        "line-strong": "#3a3d42",
        text: "#f0f1f3",
        muted: "#84868c",
        dim: "#56585e",
        grade: {
          a: "#4ade80",
          b: "#a3e635",
          c: "#fbbf24",
          d: "#fb923c",
          f: "#f87171",
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "Cascadia Code",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      maxWidth: {
        shell: "56rem",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "1" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 220ms ease-out both",
        "pulse-dot": "pulse-dot 1.1s ease-in-out infinite",
        rise: "rise 160ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
