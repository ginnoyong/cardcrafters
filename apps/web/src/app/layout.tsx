import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Card Crafters",
  description: "Team-based real-time AI greeting-card design game",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}