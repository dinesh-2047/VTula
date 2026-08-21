import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { auth } from '@/lib/auth';

const razorpay = new Razorpay({
  key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { amount, currency = 'INR', notes = {} } = body;

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    // Razorpay accepts amount in paise (1 INR = 100 paise)
    const options = {
      amount: Math.round(amount * 100),
      currency,
      receipt: `receipt_${Date.now()}`,
      notes,
    };

    const order = await razorpay.orders.create(options);

    return NextResponse.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
    });
  } catch (error: unknown) {
    console.error('Create Razorpay order error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to create payment order';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
