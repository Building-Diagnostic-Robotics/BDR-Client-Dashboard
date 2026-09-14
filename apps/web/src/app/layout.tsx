import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "BDR Client Dashboard",
  description: "Secure access to BDR building inspections and reports.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
