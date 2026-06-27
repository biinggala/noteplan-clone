import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // STATIC_EXPORT=true → 정적 SPA export (Tauri 용)
  ...(process.env.STATIC_EXPORT === 'true' && {
    output: 'export',
    images: { unoptimized: true },
  }),
};

export default nextConfig;
