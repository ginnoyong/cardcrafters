import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  weight: ["500", "600"],
  style: "normal",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Card Crafters",
  description: "Team-based real-time AI greeting-card design game",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fraunces.variable}>
      <body>{children}</body>
    </html>
  );
}
