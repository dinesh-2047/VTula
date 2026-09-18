import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Append-only audit trail.
 *
 * This model already existed but was never written to from anywhere in the
 * codebase — the system had no audit trail at all despite it being a stated
 * requirement. Every privileged action now routes through
 * `writeAudit()` in `src/lib/audit.ts`.
 */
export interface IAuditLog extends Document {
  _id: mongoose.Types.ObjectId;

  /** Dotted action code, e.g. `application.transition`, `certificate.revoke`. */
  action: string;

  /** Null for unauthenticated actions such as a public verification. */
  userId?: mongoose.Types.ObjectId;
  userRole: string;
  userEmail?: string;

  details: string;

  /** Structured before/after payload. Secrets must never be placed here. */
  changes?: Record<string, unknown>;

  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';

  ipAddress?: string;
  userAgent?: string;
  requestId?: string;

  resourceType?: string;
  resourceId?: mongoose.Types.ObjectId;
  resourceLabel?: string;

  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  action: { type: String, required: true, index: true },

  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  userRole: { type: String, required: true, default: 'PUBLIC' },
  userEmail: { type: String },

  details: { type: String, default: '' },

  changes: { type: Schema.Types.Mixed },

  outcome: { type: String, enum: ['SUCCESS', 'DENIED', 'FAILURE'], default: 'SUCCESS', index: true },

  ipAddress: { type: String },
  userAgent: { type: String },
  requestId: { type: String },

  resourceType: { type: String, index: true },
  resourceId: { type: Schema.Types.ObjectId, index: true },
  resourceLabel: { type: String },

  timestamp: { type: Date, default: Date.now, index: true },
});

AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ resourceType: 1, resourceId: 1, timestamp: -1 });

const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
export default AuditLog;
