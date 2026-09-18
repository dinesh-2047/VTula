import { NextRequest } from 'next/server';
import { Types } from 'mongoose';
import Certificate from '@/models/Certificate';
import { handle, ok, requireAuth, scopeFilter, isOfficial } from '@/lib/rbac';
import { effectiveStatus, certificateQrDataUrl } from '@/lib/certificates';
import {
  CERTIFICATE_STATUSES,
  EXPIRING_SOON_WINDOW_DAYS,
  type CertificateStatus,
} from '@/lib/constants';

/**
 * Certificates collection.
 *
 * The previous version had the same scoping hole as the applications list: an
 * `if (role === 'Owner')` branch, with a comment claiming "LMO, GATC, and Admin
 * see all certificates in jurisdiction" — but no jurisdiction clause existed, so
 * every official saw every certificate nationwide, and any unrecognised role
 * fell through to `query = {}` as well.
 *
 * Issuing happens in `POST /api/applications/[id]/transition`; this collection
 * is read-only.
 */

export const GET = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const sp = req.nextUrl.searchParams;

  const scope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'instrumentSnapshot.installationState',
    districtField: 'instrumentSnapshot.installationDistrict',
    assigneeField: 'issuedBy',
  });

  const query: Record<string, unknown> = { ...scope };

  const statusParam = sp.get('status');
  if (statusParam && statusParam !== 'all') {
    const wanted = statusParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is CertificateStatus =>
        (CERTIFICATE_STATUSES as readonly string[]).includes(s)
      );
    if (wanted.length > 0) query.status = { $in: wanted };
  }

  if (sp.get('instrumentId')) query.instrumentId = sp.get('instrumentId');

  // `expiring=true` is what the renewal reminder screens ask for.
  if (sp.get('expiring') === 'true') {
    query.expiryDate = {
      $lte: new Date(Date.now() + EXPIRING_SOON_WINDOW_DAYS * 86_400_000),
      $gte: new Date(),
    };
    query.status = { $in: ['ACTIVE', 'EXPIRING_SOON'] };
  }

  const search = sp.get('search')?.trim();
  if (search) {
    const rx = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Certificate number or instrument serial — both are things the holder
    // already knows, so neither leaks data across tenants under a scoped query.
    query.$or = [
      { certNo: { $regex: rx, $options: 'i' } },
      { 'instrumentSnapshot.serialNo': { $regex: rx, $options: 'i' } },
    ];
  }

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const [certificates, total] = await Promise.all([
    Certificate.find(query)
      .select('-dataHash -digitalSignature')
      .sort({ issuedDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Certificate.countDocuments(query),
  ]);

  // The stored status can lag reality between alert sweeps, so the displayed
  // status is derived from the expiry date. `status` remains the stored value so
  // a caller can tell the two apart.
  const rows = certificates.map((c) => ({
    ...c,
    effectiveStatus: effectiveStatus(c as Parameters<typeof effectiveStatus>[0]),
    daysToExpiry: Math.ceil((new Date(c.expiryDate).getTime() - Date.now()) / 86_400_000),
  }));

  if (isOfficial(user.role)) {
    await Certificate.populate(rows, { path: 'ownerId', select: 'name organizationName phone' });
  }

  // A single-certificate fetch also returns the QR, so the download/print view
  // does not have to make a second round trip.
  const qr =
    rows.length === 1 && sp.get('withQr') === 'true'
      ? await certificateQrDataUrl(rows[0].certNo)
      : undefined;

  const summary = await Certificate.aggregate<{ _id: string; count: number }>([
    { $match: scope as Record<string, unknown> },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return ok({
    certificates: rows,
    total,
    page,
    limit,
    qrDataUrl: qr,
    countsByStatus: Object.fromEntries(summary.map((s) => [s._id, s.count])),
  });
});

/** Kept so callers can resolve `?certNo=` without knowing the ObjectId. */
export const POST = handle(async (req: NextRequest) => {
  const user = await requireAuth();
  const body = (await req.json()) as { certNo?: string };
  const certNo = body.certNo?.trim();

  if (!certNo) {
    return ok({ certificate: null });
  }

  const scope = scopeFilter(user, {
    ownerField: 'ownerId',
    stateField: 'instrumentSnapshot.installationState',
    districtField: 'instrumentSnapshot.installationDistrict',
    assigneeField: 'issuedBy',
  });

  const cert = await Certificate.findOne({
    ...scope,
    certNo: certNo.toUpperCase(),
  })
    .select('-dataHash -digitalSignature')
    .lean();

  return ok({
    certificate: cert
      ? { ...cert, _id: String((cert as { _id: Types.ObjectId })._id) }
      : null,
  });
});
