import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // STATIC_EXPORT=true → 정적 SPA export (Electron 정적 셸 / Tauri 용)
  ...(process.env.STATIC_EXPORT === 'true' && {
    output: 'export',
    images: { unoptimized: true },
  }),
  // (레거시) ELECTRON_BUILD=true → standalone 서버 번들
  ...(process.env.ELECTRON_BUILD === 'true' && process.env.STATIC_EXPORT !== 'true' && {
    output: 'standalone',
  }),
};

export default nextConfig;
