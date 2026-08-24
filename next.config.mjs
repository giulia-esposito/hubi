/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces .next/standalone -- a self-contained server bundle with only
  // the production dependencies actually used, traced automatically by
  // Next.js. This is what Dockerfile copies into the runtime image; it has
  // no effect on `next dev` and does not change local development at all.
  // See docs/gcp-deployment-guide.md "Cloud Run" for how the image is built
  // from this output.
  output: "standalone",
};

export default nextConfig;
