import { NextRequest, NextResponse } from 'next/server';
import { sendOTP } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  try {
    const { phone, channel } = await req.json();

    if (!phone) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
    }

    // Validate E.164 format
    const phoneRegex = /^\+[1-9]\d{6,14}$/;
    if (!phoneRegex.test(phone)) {
      return NextResponse.json(
        { error: 'Invalid phone format. Use E.164 (e.g., +919876543210)' },
        { status: 400 }
      );
    }

    const result = await sendOTP(phone, channel || 'sms');

    if (result.success) {
      return NextResponse.json({ success: true, status: result.status });
    } else {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
