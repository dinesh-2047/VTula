/**
 * Geographic helpers used by GPS evidence checks.
 */

const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  lat: number;
  lng: number;
}

export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180 &&
    // 0,0 is in the Atlantic — almost always a placeholder rather than a reading.
    !(p.lat === 0 && p.lng === 0)
  );
}

/** Great-circle distance in metres between two coordinates. */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Rough bounding box for India, used to sanity-check submitted coordinates. */
export function isPlausibleIndianCoordinate(p: LatLng): boolean {
  return p.lat >= 6 && p.lat <= 37.5 && p.lng >= 68 && p.lng <= 97.5;
}

export function formatCoordinate(p: LatLng | null | undefined): string {
  if (!p || !isValidLatLng(p)) return 'Not recorded';
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}
