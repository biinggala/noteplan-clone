import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Electron 빌드 시에만 standalone 출력
  ...(process.env.ELECTRON_BUILD === 'true' && {
    output: 'standalone',
  }),
};

export default nextConfig;
