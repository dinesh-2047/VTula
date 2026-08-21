import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import dbConnect from '@/lib/db';
import Notification from '@/models/Notification';
import Application from '@/models/Application';
import Certificate from '@/models/Certificate';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userId = (session.user as { id?: string }).id;
    const userRole = (session.user as { role?: string }).role || 'Owner';

    let notifs = await Notification.find({ userId }).sort({ createdAt: -1 }).lean();

    // If user has no notifications yet, synthesize dynamic real alerts from user's DB records
    if (notifs.length === 0 && userId) {
      const generatedNotifs: any[] = [];

      // Fetch user's applications or all applications if officer
      const appQuery = userRole === 'Owner' ? { ownerId: userId } : {};
      const applications = await Application.find(appQuery)
        .populate('instrumentId', 'type serialNo brand')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      for (const app of applications) {
        const inst = app.instrumentId as any;
        generatedNotifs.push({
          userId,
          title: `Application ${app.applicationNo}`,
          message: `Verification application for ${inst?.type || 'Instrument'} (${inst?.serialNo || 'SN'}) is currently ${app.status}.`,
          type: app.status === 'Approved' ? 'success' : app.status === 'Rejected' ? 'error' : 'info',
          channel: 'app',
          relatedModel: 'Application',
          relatedId: app._id,
          isRead: false,
          createdAt: app.createdAt || new Date(),
        });
      }

      // Fetch user's certificates
      const certQuery = userRole === 'Owner' ? { ownerId: userId } : {};
      const certificates = await Certificate.find(certQuery).sort({ createdAt: -1 }).limit(5).lean();

      for (const cert of certificates) {
        generatedNotifs.push({
          userId,
          title: `Certificate ${cert.certNo} Active`,
          message: `Digital verification certificate for ${cert.instrumentSnapshot?.type} issued and valid until ${new Date(cert.expiryDate).toLocaleDateString('en-IN')}.`,
          type: 'success',
          channel: 'app',
          relatedModel: 'Certificate',
          relatedId: cert._id,
          isRead: false,
          createdAt: cert.issuedDate || new Date(),
        });
      }

      if (generatedNotifs.length > 0) {
        // Save initial dynamic notifications to DB
        await Notification.insertMany(generatedNotifs);
        notifs = await Notification.find({ userId }).sort({ createdAt: -1 }).lean();
      }
    }

    return NextResponse.json({ success: true, notifications: notifs });
  } catch (error: unknown) {
    console.error('Notifications GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userId = (session.user as { id?: string }).id;

    // Mark all as read
    await Notification.updateMany({ userId }, { isRead: true });
    return NextResponse.json({ success: true, message: 'Notifications marked as read' });
  } catch (error: unknown) {
    console.error('Notifications PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update notifications' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await dbConnect();
    const userId = (session.user as { id?: string }).id;

    await Notification.deleteMany({ userId });
    return NextResponse.json({ success: true, message: 'Notifications cleared' });
  } catch (error: unknown) {
    console.error('Notifications DELETE error:', error);
    return NextResponse.json({ error: 'Failed to clear notifications' }, { status: 500 });
  }
}
