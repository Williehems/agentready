import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentReady: can an AI agent actually use your website?",
  description:
    "Send a real stealth browser to attempt the one action your site exists for. Get a grade, the blockers, and the replay of the agent giving up.",
};

/** Runs before the first paint, so nobody sees the wrong sky for a frame. A
    remembered choice wins; otherwise the operating system decides. Kept as a
    string because it has to be in the document, not in a bundle that arrives
    later. */
const BOOT = `(function(){try{var s=localStorage.getItem("agentready-theme");var d=s?s==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){document.documentElement.classList.add("dark")}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The class on <html> is written by the script above, so the server markup
    // and the first client render legitimately disagree about it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body className="min-h-screen bg-ink font-mono text-text antialiased">{children}</body>
    </html>
  );
}
