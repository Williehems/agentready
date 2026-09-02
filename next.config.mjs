/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Solari browser SDK is a server-only dependency. Keeping it external
  // stops Next from trying to bundle its native/ws bits into the route handler.
  experimental: {
    serverComponentsExternalPackages: ["@solarisdk/browser"],
  },
};

export default nextConfig;
