import { NextRequest } from 'next/server';
import dbConnect from '@/lib/db';
import { handle, ok, BadRequest } from '@/lib/rbac';
import { fileComplaint } from '@/lib/complaints';
import { MAX_COMPLAINT_EVIDENCE_FILES } from '@/lib/constants';

/**
 * `POST /api/complaints/public` — file a complaint with no account.
 *
 * Separate from the officer-facing `/api/complaints` collection on purpose. That
 * route is behind `requireOfficial()`; this one is open, and keeping the two in
 * one file would mean one editing mistake silently exposes the officer list. The
 * split makes the authorisation boundary a directory boundary.
 */

export const dynamic = 'force-dynamic';

export const POST = handle(async (req: NextRequest) => {
  await dbConnect();

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    throw BadRequest('Send the complaint as multipart/form-data so evidence can be attached.');
  }

  const form = await req.formData();

  const str = (key: string): string => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };

  const files = form
    .getAll('evidence')
    .filter((v): v is File => v instanceof File)
    .slice(0, MAX_COMPLAINT_EVIDENCE_FILES);

  // GPS arrives as two strings from the browser's geolocation API, or not at all.
  const lat = Number(str('gpsLat'));
  const lng = Number(str('gpsLng'));
  const gps =
    Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
      ? {
          lat,
          lng,
          accuracyMetres: Number.isFinite(Number(str('gpsAccuracy')))
            ? Number(str('gpsAccuracy'))
            : undefined,
        }
      : undefined;

  const complaint = await fileComplaint({
    complainant: {
      name: str('complainantName'),
      phone: str('complainantPhone'),
      email: str('complainantEmail') || undefined,
      address: str('complainantAddress') || undefined,
      isAnonymousToTrader: str('isAnonymousToTrader') === 'true',
    },
    against: {
      businessName: str('businessName'),
      ownerName: str('ownerName') || undefined,
      phone: str('businessPhone') || undefined,
      address: str('businessAddress'),
      state: str('state'),
      district: str('district'),
      pincode: str('pincode') || undefined,
      landmark: str('landmark') || undefined,
      instrumentDescription: str('instrumentDescription') || undefined,
      certNo: str('certNo') || undefined,
    },
    complaintType: str('complaintType'),
    description: str('description'),
    incidentDate: str('incidentDate') || undefined,
    gps,
    files,
    headers: req.headers,
  });

  /*
   * The reference is the only thing the complainant leaves with — there is no
   * account for them to log back into — so it is returned prominently and
   * nothing else about the record is echoed back.
   */
  return ok(
    {
      complaintNo: complaint.complaintNo,
      status: complaint.status,
      filedOn: complaint.createdAt,
      trackUrl: `/complaint/track?ref=${encodeURIComponent(complaint.complaintNo)}`,
      message:
        'Your complaint has been registered. Save the reference number — you will need it, along with the mobile number you used, to check the status.',
    },
    201
  );
});
