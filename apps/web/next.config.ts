import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile the workspace package's TypeScript source (main points at src/).
  transpilePackages: ["@cardcrafters/shared"],
};

export default nextConfig;