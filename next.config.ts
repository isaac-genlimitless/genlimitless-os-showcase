import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e harness runs a second dev server (the member-cell test server, :3210) from this same checkout; two dev servers can't share one .next folder.
  ...(process.env.GLOS_DIST_DIR ? { distDir: process.env.GLOS_DIST_DIR } : {}),
  serverExternalPackages: ["better-sqlite3", "imapflow", "mailparser", "@blocknote/server-util", "@blocknote/core", "@blocknote/react", "jsdom", "playwright-core"],
  // Chat uploads go through the proxy, which buffers bodies (default 10 MB). 50 MB cap + overhead.
  experimental: { proxyClientMaxBodySize: "220mb" },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Content-Security-Policy-Report-Only", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" },
    ] }];
  },
  async redirects() {
    // Docs became Files; old links (including /docs?id=N from chat history) keep working.
    return [{ source: "/docs", destination: "/files", permanent: false }];
  },
};

export default nextConfig;
