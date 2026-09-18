import { NextRequest, NextResponse } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import DocumentRecord from '@/models/DocumentRecord';
import Application from '@/models/Application';
import Instrument from '@/models/Instrument';
import { requireAuth, canAccessRecord, HttpError } from '@/lib/rbac';
import { sha256Hex } from '@/lib/utils';

/**
 * Streams the bytes of an inline-stored document.
 *
 * `documentUrl()` points here whenever a file was not sent to an object store —
 * the development fallback. Unlike a Cloudinary URL, this route is *not* public:
 * an evidence photograph of somebody's premises, or a scan of their GST
 * certificate, is only served to people who can already reach the record it hangs
 * off.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await ctx.params;

  try {
    await dbConnect();
    const user = await requireAuth();

    if (!Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    // `data` is `select: false`, so it must be asked for explicitly.
    const doc = await DocumentRecord.findById(id).select('+data');
    if (!doc) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    let permitted = String(doc.uploadedBy) === user.id;

    if (!permitted && doc.applicationId) {
      const app = await Application.findById(doc.applicationId).select(
        'ownerId assignedTo jurisdiction'
      );
      permitted = Boolean(
        app &&
          canAccessRecord(user, {
            ownerId: app.ownerId,
            assignedTo: app.assignedTo,
            state: app.jurisdiction?.state,
            district: app.jurisdiction?.district,
          })
      );
    }

    if (!permitted && doc.instrumentId) {
      const inst = await Instrument.findById(doc.instrumentId).select(
        'ownerId installationState installationDistrict'
      );
      permitted = Boolean(
        inst &&
          canAccessRecord(user, {
            ownerId: inst.ownerId,
            state: inst.installationState,
            district: inst.installationDistrict,
          })
      );
    }

    if (!permitted) {
      // 404 rather than 403: an id you cannot reach should look like an id that
      // does not exist.
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    if (doc.storage === 'cloudinary' && doc.url) {
      // Nothing to stream — the bytes live at the object store.
      return NextResponse.redirect(doc.url);
    }

    if (!doc.data) {
      return NextResponse.json(
        { success: false, error: 'The stored file is missing its contents' },
        { status: 410 }
      );
    }

    const bytes = Buffer.from(doc.data, 'base64');

    // If the stored bytes no longer hash to the recorded digest, the file has been
    // altered since it was uploaded. Serving it silently would be worse than
    // refusing.
    if (sha256Hex(bytes) !== doc.sha256) {
      console.error(`[documents] integrity failure on ${id}: stored bytes do not match sha256`);
      return NextResponse.json(
        {
          success: false,
          error: 'This file failed its integrity check and will not be served. Report it to the Legal Metrology office.',
          code: 'INTEGRITY_FAILED',
        },
        { status: 409 }
      );
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': doc.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        // Inline for images and PDFs so they can be viewed in place; the filename
        // is quoted because uploaded names contain spaces.
        'Content-Disposition': `inline; filename="${doc.fileName.replace(/["\\]/g, '')}"`,
        // Content-addressed: the same id always returns the same bytes.
        ETag: `"${doc.sha256}"`,
        // Private, because this is somebody's evidence.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error('[documents] content stream failed:', error);
    return NextResponse.json({ success: false, error: 'Could not read the file' }, { status: 500 });
  }
}
