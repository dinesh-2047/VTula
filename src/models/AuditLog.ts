import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAuditLog extends Document {
  _id: mongoose.Types.ObjectId;
  action: string;
  userId: mongoose.Types.ObjectId;
  userRole: string;
  details: string;
  ipAddress?: string;
  resourceType?: string;
  resourceId?: mongoose.Types.ObjectId;
  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  action: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userRole: { type: String, required: true },
  details: { type: String, default: '' },
  ipAddress: { type: String },
  resourceType: { type: String },
  resourceId: { type: Schema.Types.ObjectId },
  timestamp: { type: Date, default: Date.now },
});

AuditLogSchema.index({ userId: 1 });
AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ action: 1 });

const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
export default AuditLog;
