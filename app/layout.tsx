import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentReady: can an AI agent actually use your website?",
  description:
    "Send a real stealth browser to attempt the one action your site exists for. Get a grade, the blockers, and the replay of the agent giving up.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink font-mono text-text antialiased">{children}</body>
    </html>
  );
}
