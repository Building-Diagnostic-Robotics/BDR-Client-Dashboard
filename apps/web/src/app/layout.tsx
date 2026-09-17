import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

const inter = localFont({
  src: "./fonts/Inter-latin.woff2",
  display: "swap",
  style: "normal",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "BDR Inspections Dashboard",
  description: "Secure access to BDR building inspections and reports.",
  icons: "/BDR.jpg",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
