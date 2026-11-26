/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
]

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // PGlite (development only) and pg load native/wasm assets at runtime.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  sassOptions: { silenceDeprecations: ['global-builtin', 'import', 'if-function'], quietDeps: true },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // API responses carry no markup: deny everything.
      { source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" }, { key: 'Cache-Control', value: 'no-store' }] },
    ]
  },
}

export default nextConfig
