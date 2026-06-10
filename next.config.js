/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // These reports moved under /reports/* so they live inside the Reports
    // page (shared sidebar) instead of routing away. Keep the old URLs working.
    return [
      { source: '/season', destination: '/reports/season', permanent: true },
      { source: '/marketing', destination: '/reports/marketing', permanent: true },
      { source: '/cash-flow', destination: '/reports/cash-flow', permanent: true },
    ]
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
