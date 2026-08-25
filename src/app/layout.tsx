import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import SiteHeader from "@/components/SiteHeader";
import { SITE_TITLE } from "@/lib/site-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: "A multi-author blog with revisions and quote-anchored comments.",
  alternates: {
    types: { "application/rss+xml": "/rss.xml" },
  },
};

// The only other place --background's two values are duplicated — see
// ICON_PLATE_COLOR/THEME_COLOR in manifest.ts, which this must stay in sync
// with by hand (the manifest spec has no per-scheme theme_color).
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <SessionProvider>
          <SiteHeader />
          {children}
        </SessionProvider>
        {/* The remote console (scripts/remote-console.ts), which puts a JS
            console on a real phone over the LAN. Injected here rather than
            served as a page of its own because a standalone page on another
            port is a different origin and so cannot see a single element of
            the app — reaching the app's DOM means running in the app's origin.

            Bare, not NEXT_PUBLIC_, so it is a restart and not a rebuild
            (docs/ENV.md's rule) and is read only on the server: the value
            carries the relay's token, and a NEXT_PUBLIC_ var would bake that
            into every client bundle this machine ever built, a production one
            included. Guarded on NODE_ENV as well as on the variable, so
            setting it in a deployed environment still does nothing. */}
        {process.env.NODE_ENV !== "production" && process.env.REMOTE_CONSOLE_SRC ? (
          // eslint-disable-next-line @next/next/no-sync-scripts
          <script src={process.env.REMOTE_CONSOLE_SRC} />
        ) : null}
      </body>
    </html>
  );
}
