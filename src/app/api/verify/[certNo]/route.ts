import { NextRequest } from 'next/server';
import { handle, ok } from '@/lib/rbac';
import { publicVerify } from '@/lib/publicVerify';

/**
 * The URL a VTULA QR code points at: `/api/verify/<certNo>`.
 *
 * The certificate QR encodes `${NEXTAUTH_URL}/verify/<certNo>` (see
 * `verifyUrl()`), which is the page; this is the data endpoint behind it. Kept as
 * a path parameter rather than a query string so the printed URL stays short
 * enough to survive a low-resolution sticker scan.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (req: NextRequest, ctx: { params: Promise<{ certNo: string }> }) => {
    const { certNo } = await ctx.params;

    const result = await publicVerify(decodeURIComponent(certNo), {
      source: 'QR',
      headers: req.headers,
    });

    return ok({ ...result });
  }
);
