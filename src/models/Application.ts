import mongoose, { Schema, Model } from 'mongoose';

export interface IApplication {
  _id: mongoose.Types.ObjectId;
  applicationNo: string;
  instrumentId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  type: 'initial' | 'reverification';
  status: 'Pending' | 'Scheduled' | 'Inspected' | 'Approved' | 'Rejected' | 'Cancelled';
  submittedDate: Date;
  scheduledDate?: Date;
  completedDate?: Date;
  dueDate?: Date;
  feePaid: number;
  feeStatus: 'Unpaid' | 'Paid' | 'Refunded';
  paymentId?: string;
  orderId?: string;
  assignedTo?: mongoose.Types.ObjectId;
  assignedType?: 'LMO' | 'GATC';
  inspectionLocation: string;
  attachments: { name: string; url: string; type: string }[];
  certificateId?: mongoose.Types.ObjectId;
  inspectionData?: {
    readings: string;
    conformityChecks: { item: string; passed: boolean }[];
    remarks: string;
    photos: { url: string; gpsLat?: number; gpsLng?: number; timestamp?: Date }[];
    result: 'Pass' | 'Fail' | 'Pending';
  };
  remarks: string;
  nextVerificationDue?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApplicationSchema = new Schema<IApplication>(
  {
    applicationNo: { type: String, unique: true, required: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['initial', 'reverification'], required: true },
    status: {
      type: String,
      enum: ['Pending', 'Scheduled', 'Inspected', 'Approved', 'Rejected', 'Cancelled'],
      default: 'Pending',
    },
    submittedDate: { type: Date, default: Date.now },
    scheduledDate: { type: Date },
    completedDate: { type: Date },
    dueDate: { type: Date },
    feePaid: { type: Number, default: 0 },
    feeStatus: { type: String, enum: ['Unpaid', 'Paid', 'Refunded'], default: 'Unpaid' },
    paymentId: { type: String },
    orderId: { type: String },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedType: { type: String, enum: ['LMO', 'GATC'] },
    inspectionLocation: { type: String, required: true },
    certificateId: { type: Schema.Types.ObjectId, ref: 'Certificate' },
    attachments: [
      {
        name: { type: String },
        url: { type: String },
        type: { type: String },
      },
    ],
    inspectionData: {
      readings: { type: String },
      conformityChecks: [
        {
          item: { type: String },
          passed: { type: Boolean },
        },
      ],
      remarks: { type: String },
      photos: [
        {
          url: { type: String },
          gpsLat: { type: Number },
          gpsLng: { type: Number },
          timestamp: { type: Date },
        },
      ],
      result: { type: String, enum: ['Pass', 'Fail', 'Pending'], default: 'Pending' },
    },
    remarks: { type: String, default: '' },
    nextVerificationDue: { type: Date },
  },
  { timestamps: true }
);

ApplicationSchema.index({ applicationNo: 1 }, { unique: true });
ApplicationSchema.index({ ownerId: 1, status: 1 });
ApplicationSchema.index({ assignedTo: 1, status: 1 });
ApplicationSchema.index({ status: 1 });
ApplicationSchema.index({ dueDate: 1 });

const Application: Model<IApplication> =
  mongoose.models.Application || mongoose.model<IApplication>('Application', ApplicationSchema);
export default Application;
