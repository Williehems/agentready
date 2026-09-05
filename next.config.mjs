/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Solari browser SDK is a server-only dependency. Keeping it external
  // stops Next from trying to bundle its native/ws bits into the route handler.
  experimental: {
    serverComponentsExternalPackages: ["@solarisdk/browser"],

    /**
     * The frames of the shipped examples, put where the server can see them.
     *
     * A run page discovers its screenshots by listing the directory they sit in, and
     * `@vercel/nft` decides what goes into a serverless function by reading the
     * source: `import`, `require` and literal `fs` paths. A path assembled from a run
     * id at request time is invisible to that, and `public/` is the one folder the
     * build deliberately strips from the function anyway, because the CDN serves it.
     *
     * So the JPEGs were served fine over HTTP and the page that links them could not
     * find them. The one failing example, the whole point of shipping a failing
     * example, rendered "its screenshots do not ship" on the deployment while all
     * eight of them sat there answering 200. Worth 218 KB in the function to have the
     * listing succeed in both places.
     */
    outputFileTracingIncludes: {
      "/runs/[id]": ["./public/examples/**/*"],
    },
  },
};

export default nextConfig;
