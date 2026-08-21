import { NextRequest, NextResponse } from 'next/server';
import { verifyOTP } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  try {
    const { phone, code } = await req.json();

    if (!phone || !code) {
      return NextResponse.json({ error: 'Phone and code are required' }, { status: 400 });
    }

    const result = await verifyOTP(phone, code);

    if (result.success && result.valid) {
      return NextResponse.json({ success: true, valid: true });
    } else if (result.success && !result.valid) {
      return NextResponse.json({ success: true, valid: false, error: 'Invalid OTP' });
    } else {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
