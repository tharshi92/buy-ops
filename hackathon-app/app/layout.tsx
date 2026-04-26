import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Buy Ops — Daily Brief",
  description: "Coarse-indexed produce procurement decisions, powered by Opus.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
