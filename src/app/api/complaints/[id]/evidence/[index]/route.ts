import { NextRequest, NextResponse } from 'next/server';
import { Types } from 'mongoose';
import dbConnect from '@/lib/db';
import Complaint from '@/models/Complaint';
import { handle, requireOfficial, scopeFilter, NotFound } from '@/lib/rbac';

/**
 * Serves one inline-stored complaint attachment.
 *
 * Officer-only, and scoped the same way the detail route is: complaint evidence
 * is a photograph of a named business's premises, often with a person in frame.
 * Cloudinary-stored files are served from their own URL and never reach here.
 *
 * Streaming one attachment per request is what keeps the detail page usable —
 * a complaint may carry several 25 MB videos, and none of them belong in a JSON
 * response.
 */

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string; index: string }> }) => {
    await dbConnect();
    const user = await requireOfficial('complaints.evidence.read');
    const { id, index } = await ctx.params;

    if (!Types.ObjectId.isValid(id)) throw NotFound('Evidence not found');

    const scoped = scopeFilter(user, {
      stateField: 'against.state',
      districtField: 'against.district',
      assigneeField: 'assignedTo',
    });

    const complaint = await Complaint.findOne({ _id: id, ...scoped })
      .select('evidence')
      .lean<{ evidence: { fileName: string; mimeType: string; data?: string; url?: string; storage: string }[] }>();

    if (!complaint) throw NotFound('Evidence not found');

    const i = Number(index);
    const item = Number.isInteger(i) ? complaint.evidence?.[i] : undefined;
    if (!item) throw NotFound('Evidence not found');

    if (item.storage === 'cloudinary' && item.url) {
      return NextResponse.redirect(item.url);
    }
    if (!item.data) throw NotFound('Evidence not found');

    const bytes = Buffer.from(item.data, 'base64');

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': item.mimeType,
        'Content-Length': String(bytes.length),
        /*
         * `inline` so an officer can watch a clip or view a photo without
         * downloading it first, but the filename is quoted and the sniffing
         * protection stays on: the file name came from an unauthenticated
         * uploader.
         */
        'Content-Disposition': `inline; filename="${item.fileName.replace(/["\r\n]/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  }
);
