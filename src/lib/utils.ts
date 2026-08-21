import crypto from 'crypto';

/**
 * Generate a unique application number
 */
export function generateApplicationNo(): string {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `APP-${year}-${rand}`;
}

/**
 * Generate a unique certificate number
 */
export function generateCertNo(): string {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `CERT-${year}-${rand}`;
}

/**
 * Create HMAC signature for certificate data
 */
export function signCertificateData(data: string): string {
  const secret = process.env.CERT_SIGNING_SECRET || 'default-secret';
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify HMAC signature
 */
export function verifyCertificateSignature(data: string, signature: string): boolean {
  const expected = signCertificateData(data);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Format date to Indian locale
 */
export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Calculate fee based on instrument type and verification type
 */
export function calculateFee(instrumentType: string, verificationType: string = 'initial'): number {
  const baseFees: Record<string, number> = {
    'Weighing Scale': 200,
    'Platform Scale': 500,
    'Weighbridge': 2000,
    'Fuel Dispenser': 1500,
    'Water Meter': 300,
    'Energy Meter': 400,
    'Clinical Thermometer': 150,
    'Sphygmomanometer': 250,
    'Taxi Meter': 350,
    'Auto Fare Meter': 300,
    'Length Measure': 100,
    'Capacity Measure': 200,
    'Storage Tank': 1000,
    default: 300,
  };

  const base = baseFees[instrumentType] || baseFees['default'];
  return verificationType === 'reverification' ? Math.round(base * 0.75) : base;
}

/**
 * Get Indian states list
 */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

/**
 * Instrument type categories
 */
export const INSTRUMENT_TYPES = [
  'Weighing Scale',
  'Platform Scale',
  'Weighbridge',
  'Fuel Dispenser',
  'Water Meter',
  'Energy Meter',
  'Clinical Thermometer',
  'Sphygmomanometer',
  'Taxi Meter',
  'Auto Fare Meter',
  'Length Measure',
  'Capacity Measure',
  'Storage Tank',
  'Pressure Gauge',
  'Flow Meter',
  'Speed Meter',
];
