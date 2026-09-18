import mongoose, { Schema, Model, Document, Types } from 'mongoose';

/**
 * A scheduled inspection slot.
 *
 * Scheduling was entirely absent: `scheduledDate` sat on the application and
 * nothing ever set it, and `assignedTo` was only written retroactively at
 * approval time. This model makes step 6 of the workflow real and gives the
 * smart-assignment recommender something to write to.
 */
export interface ISchedule extends Document {
  applicationId: Types.ObjectId;
  instrumentId: Types.ObjectId;

  /** Officer or GATC technician who will attend. */
  assignedTo: Types.ObjectId;
  assignedToRole: string;
  assignedBy: Types.ObjectId;

  /** Slot window. */
  scheduledDate: Date;
  slotStart?: string;
  slotEnd?: string;

  location: {
    address?: string;
    district?: string;
    state?: string;
    gps?: { lat: number; lng: number };
  };

  status: 'PROPOSED' | 'CONFIRMED' | 'RESCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

  /** Date the owner asked for, when they expressed a preference. */
  ownerPreferredDate?: Date;

  /** Free-text reason captured on reschedule / cancel, for the audit trail. */
  statusReason?: string;

  /** Previous slots, kept so reschedules are visible in the timeline. */
  history: {
    scheduledDate: Date;
    status: string;
    changedBy?: Types.ObjectId;
    changedAt: Date;
    reason?: string;
  }[];

  /**
   * Why the system recommended this assignee. Stored so the recommendation is
   * explainable rather than a black box (spec: no unexplained AI decisions).
   */
  assignmentRationale?: string[];

  notifiedOwnerAt?: Date;
  notifiedAssigneeAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ScheduleSchema = new Schema<ISchedule>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true, index: true },
    instrumentId: { type: Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedToRole: { type: String, required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    scheduledDate: { type: Date, required: true, index: true },
    slotStart: { type: String },
    slotEnd: { type: String },

    location: {
      address: { type: String, trim: true },
      district: { type: String, trim: true, index: true },
      state: { type: String, trim: true, index: true },
      gps: { lat: { type: Number }, lng: { type: Number } },
    },

    status: {
      type: String,
      enum: ['PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
      default: 'PROPOSED',
      index: true,
    },

    ownerPreferredDate: { type: Date },
    statusReason: { type: String, trim: true },

    history: [
      {
        scheduledDate: { type: Date, required: true },
        status: { type: String, required: true },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        changedAt: { type: Date, default: Date.now },
        reason: { type: String, trim: true },
      },
    ],

    assignmentRationale: [{ type: String }],

    notifiedOwnerAt: { type: Date },
    notifiedAssigneeAt: { type: Date },
  },
  { timestamps: true }
);

ScheduleSchema.index({ assignedTo: 1, scheduledDate: 1 });

const Schedule: Model<ISchedule> =
  (mongoose.models.Schedule as Model<ISchedule>) ||
  mongoose.model<ISchedule>('Schedule', ScheduleSchema);

export default Schedule;
