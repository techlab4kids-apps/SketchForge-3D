import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TL4K CAD - SketchForge 3D",
  description: "Modellazione 3D facile e intuitiva per TL4K",
  icons: {
    icon: "assets/sketchforge/tl4k-cad-icon-48.webp",
    apple: "assets/sketchforge/tl4k-cad-icon.webp",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" style={{ colorScheme: "light" }}>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}