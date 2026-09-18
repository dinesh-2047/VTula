import { NextRequest } from 'next/server';
import { handle, ok, BadRequest } from '@/lib/rbac';
import { publicVerify } from '@/lib/publicVerify';

/**
 * Public verification by query string: `/api/certificates/verify?certNo=…`.
 *
 * Kept for the manual-entry form on the trust page. The scan path uses
 * `/api/verify/[certNo]`, and both share `publicVerify` so a QR scan and a typed
 * number can never disagree.
 *
 * Unauthenticated by design — see `src/lib/publicVerify.ts` for what is and is
 * not disclosed, and why.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: NextRequest) => {
  const input = req.nextUrl.searchParams.get('certNo') ?? req.nextUrl.searchParams.get('q');
  if (!input?.trim()) {
    throw BadRequest('Enter a certificate number to verify', 'CERT_NO_REQUIRED');
  }

  const result = await publicVerify(input, {
    source: req.nextUrl.searchParams.get('source') === 'QR' ? 'QR' : 'MANUAL',
    headers: req.headers,
  });

  // A missing certificate is a legitimate answer to a legitimate question, not a
  // client error — the trust page renders "no such certificate" from this body.
  return ok({ ...result });
});

export const POST = handle(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { certNo?: string; qrData?: string };
  const input = body.qrData ?? body.certNo;

  if (!input?.trim()) {
    throw BadRequest('Enter a certificate number to verify', 'CERT_NO_REQUIRED');
  }

  const result = await publicVerify(input, {
    source: body.qrData ? 'QR' : 'MANUAL',
    headers: req.headers,
  });

  return ok({ ...result });
});
