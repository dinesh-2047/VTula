import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

/**
 * Send OTP to a phone number via Twilio Verify.
 * @param phone - E.164 format phone number (e.g., +919876543210)
 * @param channel - 'sms' or 'whatsapp'
 */
export async function sendOTP(
  phone: string,
  channel: 'sms' | 'whatsapp' = 'sms'
): Promise<{ success: boolean; status?: string; error?: string }> {
  if (!client || !verifyServiceSid) {
    // Dev mock: always succeed
    console.log(`[DEV MOCK] OTP sent to ${phone} via ${channel}`);
    return { success: true, status: 'pending' };
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

/**
 * Verify an OTP code.
 * @param phone - E.164 format phone number
 * @param code - The 6-digit OTP entered by user
 */
export async function verifyOTP(
  phone: string,
  code: string
): Promise<{ success: boolean; valid: boolean; error?: string }> {
  if (!client || !verifyServiceSid) {
    // Dev mock: accept code "123456"
    console.log(`[DEV MOCK] Verifying OTP ${code} for ${phone}`);
    return { success: true, valid: code === '123456' };
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

/**
 * Send WhatsApp notification via Meta Cloud API.
 */
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
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
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
      }
    );

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
