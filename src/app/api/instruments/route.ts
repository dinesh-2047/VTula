import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Instrument from '@/models/Instrument';
import { auth } from '@/lib/auth';

// GET: List instruments for the authenticated owner
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
    }
    // Admin and LMO can see all

    const instruments = await Instrument.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({ success: true, instruments });
  } catch (error: unknown) {
    console.error('GET instruments error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Create a new instrument
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as { id: string }).id;
    const body = await req.json();

    const {
      type, brand, model, serialNo, capacity, accuracyClass,
      installationState, installationDistrict, address, gpsCoordinates, photos,
      installationDate,
    } = body;

    if (!type || !brand || !model || !serialNo || !capacity || !installationState || !installationDistrict || !address) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    await dbConnect();

    const existing = await Instrument.findOne({ serialNo });
    if (existing) {
      return NextResponse.json({ error: 'Serial number already registered' }, { status: 409 });
    }

    const instrument = await Instrument.create({
      ownerId: userId,
      type, brand, model, serialNo, capacity,
      accuracyClass: accuracyClass || '',
      installationState, installationDistrict, address,
      gpsCoordinates,
      photos: photos || [],
      installationDate: installationDate ? new Date(installationDate) : undefined,
    });

    return NextResponse.json({ success: true, instrument }, { status: 201 });
  } catch (error: unknown) {
    console.error('POST instrument error:', error);
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE: Delete an instrument by ID
export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as { id: string }).id;
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Instrument ID required' }, { status: 400 });
    }

    await dbConnect();
    const deleted = await Instrument.findOneAndDelete({ _id: id, ownerId: userId });

    if (!deleted) {
      return NextResponse.json({ error: 'Instrument not found or unauthorized' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('DELETE instrument error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
