import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import dbConnect from '@/lib/db';
import Certificate from '@/models/Certificate';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userRole = (session.user as { role?: string }).role || 'Owner';
    const userId = (session.user as { id?: string }).id;

    let query = {};
    if (userRole === 'Owner') {
      query = { ownerId: userId };
    }
    // LMO, GATC, and Admin see all certificates in jurisdiction

    const certificates = await Certificate.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({ success: true, certificates });
  } catch (error: unknown) {
    console.error('Certificates GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch certificates' }, { status: 500 });
  }
}
