import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hubi (Prototype)",
  description: "Wellhub Revenue's AI Copilot -- internal prototype.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="prototype-banner">
          Internal prototype -- verify important answers through the cited sources.
        </div>
        {children}
      </body>
    </html>
  );
}
