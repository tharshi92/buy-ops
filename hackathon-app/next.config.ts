import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default config;
