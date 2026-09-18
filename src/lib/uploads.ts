import { v2 as cloudinary } from 'cloudinary';
import DocumentRecord, { type IDocumentRecord } from '@/models/DocumentRecord';
import { sha256Hex } from '@/lib/utils';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type DocumentType,
} from '@/lib/constants';
import { BadRequest } from '@/lib/rbac';

/**
 * File storage for documents and inspection evidence.
 *
 * Previously the field app read photos with `FileReader.readAsDataURL` and the
 * resulting base64 strings were stored inline inside the application document —
 * a handful of photos would exceed MongoDB's 16 MB document limit, and nothing
 * recorded a hash, so evidence had no integrity guarantee.
 *
 * Files now go to Cloudinary when it is configured, with an inline fallback so
 * the app still works out of the box in development. Either way a SHA-256 of the
 * bytes is stored.
 */

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

let configured = false;

export function isCloudinaryConfigured(): boolean {
  return Boolean(cloudName && apiKey && apiSecret);
}

function ensureCloudinary(): void {
  if (configured || !isCloudinaryConfigured()) return;
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  configured = true;
}

export interface StoreFileInput {
  file: File;
  documentType: DocumentType;
  uploadedBy: string;
  organizationId?: string;
  instrumentId?: string;
  applicationId?: string;
  inspectionId?: string;
  enforcementCaseId?: string;
  capturedAt?: Date;
  gps?: { lat: number; lng: number; accuracyMetres?: number };
  /** When set, the new record supersedes this one rather than sitting alongside it. */
  supersedesId?: string;
}

/** Validates size and type, then throws a 400 if unacceptable. */
export function assertAcceptableFile(file: File): void {
  if (!file || typeof file.size !== 'number') {
    throw BadRequest('No file was provided');
  }
  if (file.size === 0) {
    throw BadRequest('The uploaded file is empty');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw BadRequest(
      `File is too large (${(file.size / 1_048_576).toFixed(1)} MB). Maximum is ${
        MAX_UPLOAD_BYTES / 1_048_576
      } MB.`
    );
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.type as (typeof ALLOWED_UPLOAD_MIME_TYPES)[number])) {
    throw BadRequest(
      `Unsupported file type "${file.type || 'unknown'}". Allowed: JPEG, PNG, WebP, PDF.`
    );
  }
}

/** Stores a file and returns the created DocumentRecord. */
export async function storeFile(input: StoreFileInput): Promise<IDocumentRecord> {
  assertAcceptableFile(input.file);

  const buffer = Buffer.from(await input.file.arrayBuffer());
  const sha256 = sha256Hex(buffer);

  let storage: 'cloudinary' | 'inline' = 'inline';
  let url: string | undefined;
  let data: string | undefined;

  if (isCloudinaryConfigured()) {
    ensureCloudinary();
    try {
      const uploaded = await new Promise<{ secure_url: string }>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              folder: `vtula/${input.documentType.toLowerCase()}`,
              resource_type: 'auto',
              // Content-addressed public id: re-uploading identical bytes is a no-op.
              public_id: sha256,
              overwrite: false,
            },
            (error, result) => {
              if (error || !result) reject(error ?? new Error('Upload failed'));
              else resolve(result as { secure_url: string });
            }
          )
          .end(buffer);
      });
      storage = 'cloudinary';
      url = uploaded.secure_url;
    } catch (err) {
      console.error('[uploads] Cloudinary upload failed, falling back to inline storage:', err);
      data = buffer.toString('base64');
    }
  } else {
    data = buffer.toString('base64');
  }

  let version = 1;
  if (input.supersedesId) {
    const previous = await DocumentRecord.findById(input.supersedesId);
    if (previous) {
      version = previous.version + 1;
      previous.isSuperseded = true;
      await previous.save();
    }
  }

  return DocumentRecord.create({
    fileName: input.file.name || `upload-${sha256.slice(0, 8)}`,
    mimeType: input.file.type,
    sizeBytes: buffer.byteLength,
    sha256,
    storage,
    url,
    data,
    documentType: input.documentType,
    uploadedBy: input.uploadedBy,
    organizationId: input.organizationId,
    instrumentId: input.instrumentId,
    applicationId: input.applicationId,
    inspectionId: input.inspectionId,
    enforcementCaseId: input.enforcementCaseId,
    capturedAt: input.capturedAt,
    gps: input.gps,
    version,
    supersedesId: input.supersedesId,
  });
}

/** Public URL for a stored document, or the API route that streams inline bytes. */
export function documentUrl(doc: Pick<IDocumentRecord, '_id' | 'storage' | 'url'>): string {
  if (doc.storage === 'cloudinary' && doc.url) return doc.url;
  return `/api/documents/${String(doc._id)}/content`;
}
