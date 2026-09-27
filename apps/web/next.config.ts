import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile the workspace package's TypeScript source (main points at src/).
  transpilePackages: ["@cardcrafters/shared"],
  webpack: (config) => {
    // konva's node entry (index-node.js) requires the optional 'canvas'
    // package, which Next must not try to bundle for the browser (konva uses
    // the DOM canvas in the client — see konva docs / CardCanvas.tsx).
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;