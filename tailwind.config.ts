import type { Config } from "tailwindcss";

/** Every colour is a channel triple in globals.css, so `bg-ink/60` still works
    and one class on <html> repaints the whole product. */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: token("ink"),
        surface: token("surface"),
        raised: token("raised"),
        line: token("line"),
        "line-strong": token("line-strong"),
        text: token("text"),
        muted: token("muted"),
        dim: token("dim"),
        grade: {
          a: token("grade-a"),
          b: token("grade-b"),
          c: token("grade-c"),
          d: token("grade-d"),
          f: token("grade-f"),
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
