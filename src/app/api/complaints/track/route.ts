import { NextRequest } from 'next/server';
import dbConnect from '@/lib/db';
import { handle, ok, BadRequest, NotFound } from '@/lib/rbac';
import { trackComplaint } from '@/lib/complaints';

/**
 * `GET /api/complaints/track?ref=…&phone=…` — the complainant's own status check.
 *
 * Reference **and** phone, both required. The reference is a sequential number,
 * so on its own it would let anyone who filed one complaint walk the series and
 * read every other complainant's name, address and allegations. A wrong pair
 * returns the same 404 as a non-existent reference: distinguishing them would
 * turn this into an oracle for which references exist.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: NextRequest) => {
  await dbConnect();

  const { searchParams } = new URL(req.url);
  const ref = searchParams.get('ref')?.trim() ?? '';
  const phone = searchParams.get('phone')?.trim() ?? '';

  if (!ref) throw BadRequest('Enter the complaint reference number.');
  if (!phone) throw BadRequest('Enter the mobile number you filed the complaint with.');

  const view = await trackComplaint(ref, phone);

  if (!view) {
    throw NotFound(
      'No complaint matches that reference and mobile number. Check both — the number must be the one used when filing.'
    );
  }

  return ok({ complaint: view });
});
