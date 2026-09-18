import mongoose, { Schema, Document, Model } from 'mongoose';
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from '@/lib/constants';

/**
 * A notification addressed to one user.
 *
 * Previously the notifications API *synthesised* rows on first read by scanning
 * applications and certificates — and for officer roles it scanned the whole
 * database, writing other tenants' data into the reader's notification list.
 * Notifications are now created at the point the event happens (see
 * `src/lib/notify.ts`) and this collection is read-only from the API's side.
 */
export interface INotification extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  channel: 'app' | 'email' | 'sms' | 'whatsapp';

  relatedModel?: 'Application' | 'Certificate' | 'Instrument' | 'Schedule' | 'EnforcementCase' | 'RiskFlag' | 'User';
  relatedId?: mongoose.Types.ObjectId;

  /** Deep link into the app. */
  actionUrl?: string;
  actionLabel?: string;

  /**
   * Stable key that makes delivery idempotent — an expiry reminder for the same
   * certificate at the same offset can only ever be written once, even if the
   * alert sweep runs repeatedly.
   */
  dedupeKey?: string;

  /** Outbound delivery bookkeeping for non-app channels. */
  deliveryStatus: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  deliveredAt?: Date;
  deliveryError?: string;

  isRead: boolean;
  readAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, default: 'info' },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'app' },

    relatedModel: {
      type: String,
      enum: ['Application', 'Certificate', 'Instrument', 'Schedule', 'EnforcementCase', 'RiskFlag', 'User'],
    },
    relatedId: { type: Schema.Types.ObjectId },

    actionUrl: { type: String },
    actionLabel: { type: String },

    dedupeKey: { type: String, sparse: true },

    deliveryStatus: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'],
      default: 'SENT',
    },
    deliveredAt: { type: Date },
    deliveryError: { type: String },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ createdAt: -1 });
NotificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
export default Notification;
