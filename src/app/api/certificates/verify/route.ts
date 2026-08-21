import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Certificate from '@/models/Certificate';

// GET: Public endpoint to verify a certificate by certNo
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const certNo = searchParams.get('certNo');

    if (!certNo) {
      return NextResponse.json({ error: 'Certificate number is required' }, { status: 400 });
    }

    await dbConnect();

    const certificate = await Certificate.findOne({
      certNo: { $regex: new RegExp(`^${certNo.trim()}$`, 'i') },
    }).lean();

    if (!certificate) {
      return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
    }

    // Check if expired
    const isExpired = new Date(certificate.expiryDate) < new Date();
    if (isExpired && certificate.status === 'Active') {
      // Update status in background
      Certificate.updateOne({ _id: certificate._id }, { status: 'Expired' }).exec();
    }

    return NextResponse.json({
      success: true,
      certificate: {
        certNo: certificate.certNo,
        issuedDate: certificate.issuedDate,
        expiryDate: certificate.expiryDate,
        issuedByRole: certificate.issuedByRole,
        instrumentSnapshot: certificate.instrumentSnapshot,
        ownerSnapshot: certificate.ownerSnapshot,
        status: isExpired ? 'Expired' : certificate.status,
      },
    });
  } catch (error: unknown) {
    console.error('Certificate verify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
