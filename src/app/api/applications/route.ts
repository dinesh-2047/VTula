import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Application from '@/models/Application';
import { auth } from '@/lib/auth';
import { generateApplicationNo, calculateFee } from '@/lib/utils';
import Instrument from '@/models/Instrument';

// GET: List applications
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userId = (session.user as { id: string }).id;
    const role = (session.user as { role: string }).role;

    let query = {};
    if (role === 'Owner') {
      query = { ownerId: userId };
    } else if (role === 'LMO' || role === 'GATC') {
      query = { assignedTo: userId };
    }
    // Admin sees all

    const applications = await Application.find(query)
      .populate('instrumentId', 'type brand model serialNo')
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({ success: true, applications });
  } catch (error: unknown) {
    console.error('GET applications error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Create a new application
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as { id: string }).id;
    const body = await req.json();

    const { instrumentId, type, inspectionLocation, attachments, paymentId, orderId, feeStatus } = body;

    if (!instrumentId || !type) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    await dbConnect();

    // Verify instrument belongs to user
    const instrument = await Instrument.findOne({ _id: instrumentId, ownerId: userId });
    if (!instrument) {
      return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
    }

    const locationToUse = inspectionLocation || `${instrument.address}, ${instrument.installationDistrict}, ${instrument.installationState}`;

    // Calculate fee
    const fee = calculateFee(instrument.type, type);

    const application = await Application.create({
      applicationNo: generateApplicationNo(),
      instrumentId,
      ownerId: userId,
      type,
      inspectionLocation: locationToUse,
      attachments: attachments || [],
      feePaid: fee,
      feeStatus: feeStatus || (paymentId ? 'Paid' : 'Unpaid'),
      paymentId,
      orderId,
      submittedDate: new Date(),
    });

    // Update instrument status
    instrument.status = 'PendingVerification';
    await instrument.save();

    return NextResponse.json(
      {
        success: true,
        application: {
          id: application._id,
          applicationNo: application.applicationNo,
          status: application.status,
          feeDue: fee,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error('POST application error:', error);
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
