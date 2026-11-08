import type { NextConfig } from "next";

// The browser calls same-origin /api/*. app/api/[...path]/route.ts forwards
// those calls to API_URL at request time, so the target can be set when the
// container starts instead of when the image is built.
const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
