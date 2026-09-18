import type { NextConfig } from 'next';

/**
 * Build and runtime configuration.
 *
 * This file was the bare `create-next-app` scaffold — an empty object with a
 * `/* config options here *\/` comment — for the whole life of the project. That is
 * defensible in a prototype and not defensible in something that issues legal
 * instruments and takes payments, so what follows is the set of headers a portal
 * like this one is expected to send.
 *
 * Note what is deliberately *not* here. There is no `images` block, because the
 * project does not use `next/image` anywhere: certificate QRs are locally
 * generated data URLs and uploaded evidence is served through
 * `/api/documents/[id]/content` or straight from Cloudinary, both behind plain
 * `<img>` tags with the eslint exemption the codebase already uses. Adding
 * `remotePatterns` would be configuring a loader nothing calls.
 */

/**
 * Content Security Policy.
 *
 * Written as a list so each decision can carry its reason, since a CSP is mostly
 * a record of judgement calls and an undocumented one gets widened by the next
 * person who sees something break.
 *
 * `frame-ancestors 'none'` is the one that matters most for this product. A
 * verification page that can be framed can be wrapped by a site that puts its own
 * chrome around a genuine "valid certificate" verdict — which is precisely the
 * fraud the trust centre exists to make hard.
 */
const CSP = [
  "default-src 'self'",

  /*
   * `'unsafe-inline'` is required by Next's own bootstrap: the framework inlines
   * the script that hydrates the page and streams RSC payloads as inline
   * `self.__next_f.push(...)` calls. `'unsafe-eval'` is development-only — the
   * dev-mode React refresh runtime needs it and the production bundle does not.
   *
   * Razorpay's checkout script is loaded from their CDN by
   * `src/lib/razorpayCheckout.ts`; it is the only third-party script in the
   * product, and it is named explicitly rather than covered by a wildcard.
   */
  process.env.NODE_ENV === 'development'
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com"
    : "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",

  // CSS Modules compile to files; the inline allowance covers Next's injected
  // critical CSS and the `style` props used for progress bars and score meters.
  "style-src 'self' 'unsafe-inline'",

  /*
   * `data:` is load-bearing rather than lazy: every QR code in the product is a
   * locally generated data URL, which is the whole reason certificate pages no
   * longer talk to `api.qrserver.com`. Cloudinary is where uploaded evidence
   * lives when it is configured.
   */
  "img-src 'self' data: blob: https://res.cloudinary.com",

  "font-src 'self' data:",

  /*
   * No `https://fonts.googleapis.com` here, deliberately. The stylesheet import
   * that needed it was removed from `globals.css` — the fonts are self-hosted by
   * `next/font` — and leaving the origin allowed would let it quietly come back.
   */
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",

  // Razorpay's payment modal is an iframe; nothing else may be embedded.
  'frame-src https://api.razorpay.com https://checkout.razorpay.com',

  "object-src 'none'",
  "base-uri 'self'",

  // Restricts where the report and application forms can POST.
  "form-action 'self'",

  // Clickjacking protection, in its modern form.
  "frame-ancestors 'none'",

  // Stops a plain-HTTP subresource from downgrading a page served over TLS.
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },

  /*
   * `X-Frame-Options` duplicates `frame-ancestors` for older browsers that
   * understand the former and ignore the latter. Redundant on anything current,
   * and free.
   */
  { key: 'X-Frame-Options', value: 'DENY' },

  // Stops a browser from MIME-sniffing an uploaded evidence file served by
  // `/api/documents/[id]/content` into something executable.
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  /*
   * A certificate number in a URL should not travel to another origin. The
   * verification page links out to Google Maps for an instrument's location, and
   * without this the full `/verify/VT-CERT-…` path would arrive in that request's
   * `Referer`.
   */
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

  /*
   * The inspection flow asks for geolocation and the camera — on the inspector's
   * device, from our own origin, and nowhere else. Everything the product does
   * not use is switched off rather than left at the browser default.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), geolocation=(self), microphone=(), payment=(self), interest-cohort=()',
  },

  /*
   * Twelve months, including subdomains. Harmless over plain HTTP in local
   * development — browsers ignore HSTS from an insecure origin — so it does not
   * need to be conditional.
   */
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
];

const nextConfig: NextConfig = {
  /*
   * Announcing the framework and its version tells an attacker which advisories
   * to try first. It buys nothing in return.
   */
  poweredByHeader: false,

  /*
   * `typedRoutes` is deliberately left off.
   *
   * It is stable in this version and it does find real things, but most of what it
   * finds here is by design: notification `actionUrl`s, the topbar's register
   * search and the dashboard's activity feed all navigate to hrefs composed at
   * runtime from data the server sent. Turning it on means either casting at every
   * such call site — which silences the checker without proving anything — or
   * narrowing the routes to string literals the server cannot produce. Left off
   * until those hrefs are modelled as typed builders, which is a refactor of its
   * own rather than a config flag.
   */

  async headers() {
    return [
      {
        // Every path, including API routes and uploaded document content.
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
      {
        /*
         * A verification result is a statement about one instrument at one
         * moment. It must never be served from a CDN or browser cache — a
         * suspended certificate showing yesterday's "valid" verdict is exactly
         * the failure this product exists to prevent. The page already sets
         * `dynamic = 'force-dynamic'`; this closes the same hole at the edge.
         */
        source: '/verify/:certNo*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
      {
        // Same reasoning for the API the verification page and any integrator use.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
