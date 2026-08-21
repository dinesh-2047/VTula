import mongoose, { Schema, Document, Model } from 'mongoose';

export interface INotification extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  channel: 'app' | 'email' | 'sms' | 'whatsapp';
  relatedModel?: 'Application' | 'Certificate' | 'Instrument';
  relatedId?: mongoose.Types.ObjectId;
  isRead: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    channel: { type: String, enum: ['app', 'email', 'sms', 'whatsapp'], default: 'app' },
    relatedModel: { type: String, enum: ['Application', 'Certificate', 'Instrument'] },
    relatedId: { type: Schema.Types.ObjectId },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ createdAt: -1 });

const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
export default Notification;
