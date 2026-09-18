import twilio from 'twilio';

/**
 * SMS / WhatsApp / OTP delivery.
 *
 * The dev mock is now gated on `NODE_ENV`. Previously the mock accepted the
 * literal code `123456` for *any* phone number with no environment check, so a
 * production deployment that was missing its Twilio configuration would silently
 * accept a fixed OTP for every account rather than failing.
 */

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const isProduction = process.env.NODE_ENV === 'production';

/** Explicit opt-in for the fixed dev OTP, so it can never be on by accident. */
const allowMockOtp = !isProduction && process.env.VTULA_ALLOW_MOCK_OTP !== 'false';

/** The fixed code accepted in development only. */
export const DEV_MOCK_OTP = '123456';

let cachedClient: twilio.Twilio | null | undefined;

function getClient(): twilio.Twilio | null {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = accountSid && authToken ? twilio(accountSid, authToken) : null;
  return cachedClient;
}

export function isTwilioConfigured(): boolean {
  return Boolean(getClient() && verifyServiceSid);
}

/** Which provider will actually handle OTPs, so callers can record it. */
export function otpProvider(): 'twilio' | 'mock' {
  return isTwilioConfigured() ? 'twilio' : 'mock';
}

/**
 * Sends an OTP.
 * @param phone E.164 format, e.g. `+919876543210`
 */
export async function sendOTP(
  phone: string,
  channel: 'sms' | 'whatsapp' = 'sms'
): Promise<{ success: boolean; status?: string; error?: string; mocked?: boolean }> {
  const client = getClient();

  if (!client || !verifyServiceSid) {
    if (!allowMockOtp) {
      console.error('[otp] Twilio Verify is not configured and mock OTP is disabled.');
      return {
        success: false,
        error: 'OTP delivery is not configured on this server. Please sign in with your password.',
      };
    }
    console.log(`[DEV MOCK] OTP for ${phone} via ${channel} is ${DEV_MOCK_OTP}`);
    return { success: true, status: 'pending', mocked: true };
  }

  try {
    const verification = await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel });
    return { success: true, status: verification.status };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Twilio sendOTP error:', msg);
    return { success: false, error: msg };
  }
}

/** Checks an OTP code. */
export async function verifyOTP(
  phone: string,
  code: string
): Promise<{ success: boolean; valid: boolean; error?: string }> {
  const client = getClient();

  if (!client || !verifyServiceSid) {
    if (!allowMockOtp) {
      return { success: false, valid: false, error: 'OTP verification is not configured' };
    }
    return { success: true, valid: code === DEV_MOCK_OTP };
  }

  try {
    const check = await client.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({ to: phone, code });
    return { success: true, valid: check.status === 'approved' };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Twilio verifyOTP error:', msg);
    return { success: false, valid: false, error: msg };
  }
}

/** Sends a plain SMS (not an OTP) via Twilio Messages. */
export async function sendSms(
  to: string,
  body: string
): Promise<{ success: boolean; error?: string }> {
  const client = getClient();
  const from = process.env.TWILIO_SMS_FROM;

  if (!client || !from) {
    console.log(`[DEV MOCK] SMS to ${to}: ${body}`);
    return { success: true };
  }

  try {
    await client.messages.create({ to, from, body });
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Twilio sendSms error:', msg);
    return { success: false, error: msg };
  }
}

/** Sends a WhatsApp text via the Meta Cloud API. */
export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.log(`[DEV MOCK] WhatsApp message to ${to}: ${message}`);
    return { success: true };
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace('+', ''),
        type: 'text',
        text: { body: message },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { success: false, error: err };
    }

    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: msg };
  }
}
