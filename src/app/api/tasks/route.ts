import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import dbConnect from '@/lib/db';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';
import Instrument from '@/models/Instrument';
import User from '@/models/User';
import { generateCertNo, signCertificateData } from '@/lib/utils';

// GET: Fetch pending inspection tasks for LMO / GATC
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userRole = (session.user as { role?: string }).role;

    // Fetch submitted or pending applications
    const applications = await Application.find({})
      .populate('instrumentId')
      .populate('ownerId', 'name email phone organizationName')
      .populate('certificateId')
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({ success: true, applications });
  } catch (error: unknown) {
    console.error('Tasks GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST: Issue certificate / complete inspection for an application
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { applicationId, verdict, remarks, stampNo, photos, readings, gpsLat, gpsLng } = await req.json();

    if (!applicationId || !verdict) {
      return NextResponse.json({ error: 'Application ID and verdict are required' }, { status: 400 });
    }

    await dbConnect();

    const application = await Application.findById(applicationId).populate('instrumentId').populate('ownerId');
    if (!application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    }

    const userRole = (session.user as { role?: string }).role || 'LMO';
    const userId = (session.user as { id?: string }).id;
    const userName = session.user.name || 'Officer';

    // Prepare inspection data object
    const inspectionData = {
      readings: readings || 'Standard Tolerance Compliance',
      remarks: remarks || 'Verified as per Legal Metrology Rules',
      photos: (photos || []).map((p: string) => ({
        url: p,
        gpsLat: gpsLat || undefined,
        gpsLng: gpsLng || undefined,
        timestamp: new Date(),
      })),
      result: verdict === 'Approve' ? 'Pass' : 'Fail',
    };

    if (verdict === 'Approve') {
      const certNo = generateCertNo();
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);

      const inst = application.instrumentId as any;
      const owner = application.ownerId as any;

      const dataToSign = `${certNo}:${inst._id}:${owner._id}:${expiryDate.toISOString()}:${userId}`;
      const digitalSignature = signCertificateData(dataToSign);

      const newCert = await Certificate.create({
        certNo,
        applicationId: application._id,
        instrumentId: inst._id,
        ownerId: owner._id,
        issuedDate: new Date(),
        expiryDate,
        issuedBy: userId,
        issuedByRole: userRole === 'GATC' ? 'GATC' : 'LMO',
        instrumentSnapshot: {
          type: inst.type,
          brand: inst.brand,
          model: inst.model,
          serialNo: inst.serialNo,
          capacity: inst.capacity,
        },
        ownerSnapshot: {
          name: owner.name,
          email: owner.email,
          phone: owner.phone,
        },
        dataHash: dataToSign,
        digitalSignature,
        status: 'Active',
      });

      // Update application
      application.status = 'Approved';
      application.certificateId = newCert._id;
      application.remarks = remarks || `Verified & Stamped by ${userName} (Stamp No: ${stampNo || 'N/A'})`;
      application.assignedTo = userId as any;
      application.assignedType = userRole === 'GATC' ? 'GATC' : 'LMO';
      application.inspectionData = inspectionData as any;
      await application.save();

      // Update instrument
      await Instrument.findByIdAndUpdate(inst._id, {
        status: 'Verified',
        lastVerifiedDate: new Date(),
        nextVerificationDue: expiryDate,
        currentCertificateId: newCert._id,
      });

      return NextResponse.json({ success: true, certificate: newCert });
    } else {
      application.status = 'Rejected';
      application.remarks = remarks || `Rejected by ${userName}`;
      application.inspectionData = inspectionData as any;
      application.assignedTo = userId as any;
      await application.save();

      if (application.instrumentId) {
        await Instrument.findByIdAndUpdate(application.instrumentId._id, {
          status: 'Rejected',
        });
      }

      return NextResponse.json({ success: true, message: 'Application rejected' });
    }
  } catch (error: unknown) {
    console.error('Inspection completion error:', error);
    return NextResponse.json({ error: 'Failed to complete inspection' }, { status: 500 });
  }
}
