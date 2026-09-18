/*
 * The printable certificate, as an actual PDF.
 *
 * The old page's "View & Print PDF" button called `window.print()`, which prints
 * the entire dashboard — sidebar, topbar, modal chrome and all — because no print
 * stylesheet ever existed. It also drew a stamp reading `LMO-SEAL-VERIFIED` and a
 * signature line reading `HMAC-SHA256: undefined...`, since the list endpoint
 * strips `digitalSignature`. Every one of those is now real data from
 * `GET /api/certificates/[id]`.
 *
 * `@react-pdf/renderer` is ~1 MB of client bundle, so this module is only ever
 * reached through a dynamic `import()` at the moment the user asks to download.
 *
 * The rupee sign is deliberately absent: react-pdf's built-in Helvetica is
 * WinAnsi-encoded and has no ₹ glyph, so it would render as a blank box. Nothing
 * on a verification certificate needs a currency amount anyway.
 */

import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer';

export interface CertificatePdfData {
  certNo: string;
  status: string;
  effectiveStatus: string;
  issuedDate: string;
  expiryDate: string;
  version: number;
  supersedes?: boolean;

  verifyUrl: string;
  qrDataUrl: string;

  signatureKeyId?: string;
  digitalSignature?: string;
  dataHash?: string;
  integrity?: { signatureValid: boolean; hashValid: boolean };

  instrument: {
    type?: string;
    brand?: string;
    model?: string;
    serialNo?: string;
    capacity?: string;
    accuracyClass?: string;
    address?: string;
    installationDistrict?: string;
    installationState?: string;
  };

  owner: {
    name?: string;
    organizationName?: string;
    email?: string;
    phone?: string;
  };

  issuer: {
    name?: string;
    designation?: string;
    officerCode?: string;
    state?: string;
    district?: string;
    role?: string;
  };

  inspection?: {
    inspectionNo?: string;
    inspectedAt?: string;
    result?: string;
    readingCount?: number;
    maxErrorPercent?: number;
    sealNo?: string;
  };

  rule?: {
    validityMonths?: number;
    legalReference?: string;
  };
}

const INK = '#1F2233';
const MUTED = '#5B5F73';
const RULE = '#B9BDCB';
const GOLD = '#8A6A1F';

const s = StyleSheet.create({
  page: {
    paddingTop: 38,
    paddingBottom: 44,
    paddingHorizontal: 46,
    fontSize: 9.5,
    fontFamily: 'Helvetica',
    color: INK,
    lineHeight: 1.5,
  },

  frame: {
    borderWidth: 2,
    borderColor: GOLD,
    padding: 22,
    flexGrow: 1,
  },

  dept: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    letterSpacing: 1.1,
  },
  govt: {
    fontSize: 9,
    textAlign: 'center',
    color: MUTED,
    marginTop: 3,
  },
  title: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    marginTop: 14,
    letterSpacing: 1.4,
  },
  certNo: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    marginTop: 6,
  },
  statusLine: {
    fontSize: 8.5,
    textAlign: 'center',
    color: MUTED,
    marginTop: 2,
  },

  hr: {
    borderBottomWidth: 1,
    borderBottomColor: GOLD,
    marginVertical: 14,
  },

  recital: {
    fontSize: 9.5,
    textAlign: 'justify',
  },

  sectionTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1,
    color: MUTED,
    marginTop: 16,
    marginBottom: 6,
  },

  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
    paddingVertical: 4,
  },
  key: {
    width: '34%',
    fontFamily: 'Helvetica-Bold',
    fontSize: 8.5,
  },
  val: {
    width: '66%',
    fontSize: 9,
  },

  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 22,
  },
  qrBlock: {
    width: 130,
    alignItems: 'center',
  },
  qr: {
    width: 96,
    height: 96,
  },
  qrCaption: {
    fontSize: 7,
    color: MUTED,
    textAlign: 'center',
    marginTop: 4,
  },
  qrUrl: {
    fontSize: 6.5,
    color: MUTED,
    textAlign: 'center',
    marginTop: 2,
  },

  signBlock: {
    width: 220,
    alignItems: 'flex-end',
  },
  signName: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginTop: 26,
  },
  signMeta: {
    fontSize: 8,
    color: MUTED,
  },

  integrity: {
    marginTop: 18,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: RULE,
  },
  integrityText: {
    fontSize: 7,
    color: MUTED,
    lineHeight: 1.45,
  },
  mono: {
    fontFamily: 'Courier',
    fontSize: 6.5,
  },
});

function fmt(date: string | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <View style={s.row}>
      <Text style={s.key}>{label}</Text>
      <Text style={s.val}>{String(value)}</Text>
    </View>
  );
}

function CertificateDocument({ data }: { data: CertificatePdfData }) {
  const { instrument, owner, issuer, inspection, rule } = data;

  const holder = owner.organizationName
    ? `${owner.organizationName}${owner.name ? ` (${owner.name})` : ''}`
    : (owner.name ?? 'the holder');

  const place = [instrument.installationDistrict, instrument.installationState]
    .filter(Boolean)
    .join(', ');

  /*
   * No form number and no section number are printed. The old page asserted
   * "FORM VIII — RULE 11(1)" and "SEC. 24, ACT 2009" as decoration; nothing in
   * the record supports either, and a wrong statutory citation on a certificate
   * is worse than none. Where the applied rule carries a legal reference, that
   * is printed instead — it is the provision the department actually applied.
   */
  return (
    <Document
      title={`Verification certificate ${data.certNo}`}
      author="Department of Legal Metrology"
      subject={`Verification of ${instrument.type ?? 'instrument'} ${instrument.serialNo ?? ''}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.frame}>
          <Text style={s.dept}>DEPARTMENT OF LEGAL METROLOGY</Text>
          <Text style={s.govt}>
            {issuer.state ? `Government of ${issuer.state}` : 'State Legal Metrology Organisation'}
          </Text>

          <Text style={s.title}>CERTIFICATE OF VERIFICATION</Text>
          <Text style={s.certNo}>{data.certNo}</Text>
          <Text style={s.statusLine}>
            Status as recorded at the time of printing: {data.effectiveStatus}
            {data.version > 1 ? ` · revision ${data.version}` : ''}
          </Text>

          <View style={s.hr} />

          <Text style={s.recital}>
            This is to certify that the weighing or measuring instrument described below, belonging
            to {holder}
            {place ? ` at ${place}` : ''}, was verified and stamped under the Legal Metrology Act,
            2009 and the rules made thereunder. This certificate is valid from{' '}
            {fmt(data.issuedDate)} until {fmt(data.expiryDate)}, unless suspended, revoked or
            superseded before that date.
          </Text>

          <Text style={s.sectionTitle}>INSTRUMENT</Text>
          <Field label="Type" value={instrument.type} />
          <Field
            label="Make and model"
            value={[instrument.brand, instrument.model].filter(Boolean).join(' ') || undefined}
          />
          <Field label="Serial number" value={instrument.serialNo} />
          <Field label="Capacity" value={instrument.capacity} />
          <Field label="Accuracy class" value={instrument.accuracyClass} />
          <Field label="Place of use" value={instrument.address ?? place} />

          <Text style={s.sectionTitle}>HOLDER</Text>
          <Field label="Name" value={owner.organizationName ?? owner.name} />
          <Field label="Contact person" value={owner.organizationName ? owner.name : undefined} />
          <Field label="Email" value={owner.email} />
          <Field label="Telephone" value={owner.phone} />

          {inspection && (
            <>
              <Text style={s.sectionTitle}>VERIFICATION</Text>
              <Field label="Inspection reference" value={inspection.inspectionNo} />
              <Field label="Date of inspection" value={fmt(inspection.inspectedAt)} />
              <Field label="Result" value={inspection.result} />
              <Field label="Test points recorded" value={inspection.readingCount} />
              <Field
                label="Maximum error observed"
                value={
                  inspection.maxErrorPercent === undefined
                    ? undefined
                    : `${inspection.maxErrorPercent}%`
                }
              />
              <Field label="Seal number" value={inspection.sealNo} />
            </>
          )}

          <Text style={s.sectionTitle}>VALIDITY</Text>
          <Field label="Issued on" value={fmt(data.issuedDate)} />
          <Field label="Valid until" value={fmt(data.expiryDate)} />
          <Field
            label="Validity period applied"
            value={rule?.validityMonths ? `${rule.validityMonths} months` : undefined}
          />
          <Field label="Provision applied" value={rule?.legalReference} />
          <Field
            label="Supersedes"
            value={data.supersedes ? 'An earlier certificate for this instrument' : undefined}
          />

          <View style={s.footer}>
            <View style={s.qrBlock}>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop */}
              <Image style={s.qr} src={data.qrDataUrl} />
              <Text style={s.qrCaption}>Scan to check the current status</Text>
              <Text style={s.qrUrl}>{data.verifyUrl}</Text>
            </View>

            <View style={s.signBlock}>
              <Text style={s.signName}>{issuer.name ?? 'Verifying officer'}</Text>
              <Text style={s.signMeta}>
                {issuer.designation ?? issuer.role ?? 'Legal Metrology Officer'}
              </Text>
              {issuer.officerCode && <Text style={s.signMeta}>Officer code {issuer.officerCode}</Text>}
              {(issuer.district || issuer.state) && (
                <Text style={s.signMeta}>
                  {[issuer.district, issuer.state].filter(Boolean).join(', ')}
                </Text>
              )}
              <Text style={s.signMeta}>Issued electronically on {fmt(data.issuedDate)}</Text>
            </View>
          </View>

          <View style={s.integrity}>
            <Text style={s.integrityText}>
              This certificate is issued electronically and carries no ink signature. Its
              authenticity is established by the record held by the department, not by this
              printout: scan the code above or visit the address shown to see the current status.
              Printed details that disagree with that page should be treated as altered.
            </Text>
            {data.digitalSignature && (
              <Text style={[s.integrityText, s.mono]}>
                Signature (HMAC-SHA256{data.signatureKeyId ? `, key ${data.signatureKeyId}` : ''}):{' '}
                {data.digitalSignature.slice(0, 40)}
              </Text>
            )}
            {data.dataHash && (
              <Text style={[s.integrityText, s.mono]}>
                Content digest (SHA-256): {data.dataHash.slice(0, 40)}
              </Text>
            )}
            {data.integrity && !(data.integrity.hashValid && data.integrity.signatureValid) && (
              <Text style={[s.integrityText, { fontFamily: 'Helvetica-Bold' }]}>
                Warning: the department&apos;s own integrity check on this record did not pass. Do
                not rely on this printout — contact the issuing office.
              </Text>
            )}
          </View>
        </View>
      </Page>
    </Document>
  );
}

/** Renders the certificate and hands back a Blob the browser can save. */
export async function certificatePdfBlob(data: CertificatePdfData): Promise<Blob> {
  return pdf(<CertificateDocument data={data} />).toBlob();
}
