/**
 * Client-safe shared constants, enums and state machines.
 *
 * IMPORTANT: this module must stay free of Node-only imports (`crypto`, `fs`,
 * mongoose, ...) because it is imported by `'use client'` components. Anything
 * that needs Node APIs belongs in `src/lib/utils.ts` (server-only).
 */

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

/**
 * Canonical role values. The spec names these
 * BUSINESS/Owner, LMO, GATC Admin, GATC Technician, State Admin, System Admin.
 * We keep the short historical values (`Owner`, `LMO`, `GATC`, `Admin`) so
 * existing records keep working, and add the two roles that were missing.
 */
export const ROLES = [
  'Owner',
  'LMO',
  'GATC',
  'GATCTechnician',
  'StateAdmin',
  'Admin',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  Owner: 'Business Owner',
  LMO: 'Legal Metrology Officer',
  GATC: 'GATC Administrator',
  GATCTechnician: 'GATC Technician',
  StateAdmin: 'State Administrator',
  Admin: 'System Administrator',
};

/** Roles a visitor may pick during self-registration. Everything else is provisioned. */
export const SELF_REGISTERABLE_ROLES: Role[] = ['Owner'];

/** Roles that can see data beyond their own organisation. */
export const OFFICIAL_ROLES: Role[] = ['LMO', 'GATC', 'GATCTechnician', 'StateAdmin', 'Admin'];

/** Roles with unrestricted (cross-jurisdiction) read access. */
export const GLOBAL_SCOPE_ROLES: Role[] = ['Admin'];

/** Roles scoped to a state jurisdiction. */
export const STATE_SCOPE_ROLES: Role[] = ['StateAdmin'];

/** Roles that may take a final approve/reject decision on an application. */
export const DECISION_ROLES: Role[] = ['LMO', 'StateAdmin', 'Admin'];

/** Roles that may perform an inspection / submit readings. */
export const INSPECTOR_ROLES: Role[] = ['LMO', 'GATC', 'GATCTechnician'];

/** Roles that may administer users, rules and jurisdictions. */
export const ADMIN_ROLES: Role[] = ['StateAdmin', 'Admin'];

/* ------------------------------------------------------------------ *
 * Application lifecycle
 * ------------------------------------------------------------------ */

export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUERY_RAISED',
  'RESUBMITTED',
  'APPROVED_FOR_SCHEDULING',
  'SCHEDULED',
  'INSPECTION_IN_PROGRESS',
  'INSPECTION_SUBMITTED',
  'UNDER_DECISION',
  'APPROVED',
  'REJECTED',
  'CERTIFICATE_GENERATED',
  'ACTIVE',
  'CANCELLED',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  QUERY_RAISED: 'Query Raised',
  RESUBMITTED: 'Resubmitted',
  APPROVED_FOR_SCHEDULING: 'Approved for Scheduling',
  SCHEDULED: 'Scheduled',
  INSPECTION_IN_PROGRESS: 'Inspection in Progress',
  INSPECTION_SUBMITTED: 'Inspection Submitted',
  UNDER_DECISION: 'Under Decision',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CERTIFICATE_GENERATED: 'Certificate Generated',
  ACTIVE: 'Active',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  SUSPENDED: 'Suspended',
  REVOKED: 'Revoked',
};

/**
 * Statuses at which an application is finished with — no officer owes it work and
 * no further transition is expected from the department.
 *
 * Defined once because "is this application still open?" is asked by the officer
 * workload counts, the duplicate-application guard, the dashboard tiles and the
 * deactivation check. Each of those had grown its own hand-written `$nin` list,
 * which is how one of them ends up quietly disagreeing with the others.
 */
export const CLOSED_APPLICATION_STATUSES = [
  'REJECTED',
  'CANCELLED',
  'CERTIFICATE_GENERATED',
  'ACTIVE',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
] as const satisfies readonly ApplicationStatus[];

/** Statuses at which an application is still moving through the workflow. */
export const OPEN_APPLICATION_STATUSES = APPLICATION_STATUSES.filter(
  (s) => !(CLOSED_APPLICATION_STATUSES as readonly string[]).includes(s)
) as readonly ApplicationStatus[];

/**
 * Open *and* already submitted — i.e. sitting in somebody's queue. Excludes
 * `DRAFT`, which is the applicant's own unsent work and not the department's
 * problem.
 */
export const IN_FLIGHT_APPLICATION_STATUSES = OPEN_APPLICATION_STATUSES.filter(
  (s) => s !== 'DRAFT'
) as readonly ApplicationStatus[];

/**
 * Allowed transitions. Anything not listed here is rejected by
 * `assertTransition` in `src/lib/workflow.ts` — the state machine is enforced
 * server-side, not just hidden in the UI.
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['QUERY_RAISED', 'APPROVED_FOR_SCHEDULING', 'REJECTED', 'CANCELLED'],
  QUERY_RAISED: ['RESUBMITTED', 'CANCELLED', 'REJECTED'],
  RESUBMITTED: ['UNDER_REVIEW', 'CANCELLED'],
  APPROVED_FOR_SCHEDULING: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['INSPECTION_IN_PROGRESS', 'APPROVED_FOR_SCHEDULING', 'CANCELLED'],
  INSPECTION_IN_PROGRESS: ['INSPECTION_SUBMITTED', 'SCHEDULED', 'CANCELLED'],
  INSPECTION_SUBMITTED: ['UNDER_DECISION', 'INSPECTION_IN_PROGRESS'],
  UNDER_DECISION: ['APPROVED', 'REJECTED', 'QUERY_RAISED', 'INSPECTION_IN_PROGRESS'],
  APPROVED: ['CERTIFICATE_GENERATED'],
  REJECTED: ['DRAFT'],
  CERTIFICATE_GENERATED: ['ACTIVE'],
  ACTIVE: ['EXPIRED', 'SUSPENDED', 'REVOKED'],
  CANCELLED: [],
  EXPIRED: [],
  SUSPENDED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
};

/** Statuses the owner is still expected to act on. */
export const OWNER_ACTION_STATUSES: ApplicationStatus[] = ['DRAFT', 'QUERY_RAISED'];

/** Statuses that sit in an officer's work queue. */
export const OFFICER_QUEUE_STATUSES: ApplicationStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'RESUBMITTED',
  'APPROVED_FOR_SCHEDULING',
  'SCHEDULED',
  'INSPECTION_IN_PROGRESS',
  'INSPECTION_SUBMITTED',
  'UNDER_DECISION',
  // Approved is not finished: `APPROVED → CERTIFICATE_GENERATED` is an officer
  // action, and leaving it out of the queue meant a decided application waited
  // for its certificate where nobody was looking for it.
  'APPROVED',
];

/** Terminal statuses — no further transitions are possible. */
export const APPLICATION_TERMINAL_STATUSES: ApplicationStatus[] = [
  'CANCELLED',
  'EXPIRED',
  'REVOKED',
];

/** Maps the pre-state-machine status values onto the current enum. */
export const LEGACY_APPLICATION_STATUS_MAP: Record<string, ApplicationStatus> = {
  Pending: 'SUBMITTED',
  Submitted: 'SUBMITTED',
  UnderReview: 'UNDER_REVIEW',
  Scheduled: 'SCHEDULED',
  Inspected: 'INSPECTION_SUBMITTED',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  Cancelled: 'CANCELLED',
};

/* ------------------------------------------------------------------ *
 * Inspection scheduling
 * ------------------------------------------------------------------ */

/**
 * The state of a booked inspection slot, mirroring the enum declared inline on
 * `src/models/Schedule.ts`.
 *
 * Mirrored here rather than imported because this module is client-safe and the
 * model is not, and the schedule page needs the labels.
 */
export const SCHEDULE_STATUSES = [
  'PROPOSED',
  'CONFIRMED',
  'RESCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/**
 * Said as an appointment rather than as a state.
 *
 * `NO_SHOW` is the one worth explaining: it does not mean the inspector failed to
 * turn up, it means the site was closed or the instrument was unavailable when
 * they did. The label says so, because read the other way round it is an
 * accusation against the wrong party.
 */
export const SCHEDULE_STATUS_LABELS: Record<ScheduleStatus, string> = {
  PROPOSED: 'Date proposed',
  CONFIRMED: 'Confirmed',
  RESCHEDULED: 'Moved to a new date',
  IN_PROGRESS: 'Inspector on site',
  COMPLETED: 'Visit completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Site unavailable on the day',
};

/** Slots that still represent a visit that is going to happen. */
export const LIVE_SCHEDULE_STATUSES: ScheduleStatus[] = [
  'PROPOSED',
  'CONFIRMED',
  'RESCHEDULED',
  'IN_PROGRESS',
];

export function scheduleStatusBadgeClass(status: string): string {
  switch (status) {
    case 'IN_PROGRESS':
      return 'clay-badge-primary';
    case 'CONFIRMED':
      return 'clay-badge-info';
    case 'PROPOSED':
    case 'RESCHEDULED':
      return 'clay-badge-warning';
    case 'COMPLETED':
      return 'clay-badge-success';
    case 'NO_SHOW':
      return 'clay-badge-error';
    // A cancelled slot is grey rather than red: most cancellations are a date the
    // business could not keep, which is a rebooking and not a failure.
    case 'CANCELLED':
      return 'clay-badge-charcoal';
    default:
      return 'clay-badge-info';
  }
}

/* ------------------------------------------------------------------ *
 * Certificate lifecycle
 * ------------------------------------------------------------------ */

export const CERTIFICATE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'EXPIRING_SOON',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
  'SUPERSEDED',
] as const;

export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  EXPIRING_SOON: 'Expiring Soon',
  EXPIRED: 'Expired',
  SUSPENDED: 'Suspended',
  REVOKED: 'Revoked',
  SUPERSEDED: 'Superseded',
};

/** A certificate in one of these states is legally valid right now. */
export const CERTIFICATE_VALID_STATUSES: CertificateStatus[] = ['ACTIVE', 'EXPIRING_SOON'];

export const CERTIFICATE_TRANSITIONS: Record<CertificateStatus, CertificateStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['EXPIRING_SOON', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'SUPERSEDED'],
  EXPIRING_SOON: ['ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'SUPERSEDED'],
  EXPIRED: ['SUPERSEDED', 'REVOKED'],
  SUSPENDED: ['ACTIVE', 'EXPIRING_SOON', 'REVOKED', 'EXPIRED'],
  REVOKED: [],
  SUPERSEDED: [],
};

export const LEGACY_CERTIFICATE_STATUS_MAP: Record<string, CertificateStatus> = {
  Active: 'ACTIVE',
  Expired: 'EXPIRED',
  Revoked: 'REVOKED',
  Suspended: 'SUSPENDED',
  Superseded: 'SUPERSEDED',
};

/** Certificate audit-trail event kinds (spec: certificateEvents). */
export const CERTIFICATE_EVENT_TYPES = [
  'ISSUED',
  'RENEWED',
  'SUPERSEDED',
  'SUSPENDED',
  'REINSTATED',
  'REVOKED',
  'EXPIRY_WARNING',
  'EXPIRED',
  'DOWNLOADED',
  'REPORTED',
] as const;

export type CertificateEventType = (typeof CERTIFICATE_EVENT_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Instruments
 * ------------------------------------------------------------------ */

export const INSTRUMENT_STATUSES = [
  'REGISTERED',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'EXPIRING_SOON',
  'EXPIRED',
  'REJECTED',
  'SUSPENDED',
  'DECOMMISSIONED',
] as const;

export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

export const INSTRUMENT_STATUS_LABELS: Record<InstrumentStatus, string> = {
  REGISTERED: 'Registered',
  PENDING_VERIFICATION: 'Pending Verification',
  VERIFIED: 'Verified',
  EXPIRING_SOON: 'Expiring Soon',
  EXPIRED: 'Expired',
  REJECTED: 'Verification Failed',
  SUSPENDED: 'Suspended',
  DECOMMISSIONED: 'Decommissioned',
};

export const LEGACY_INSTRUMENT_STATUS_MAP: Record<string, InstrumentStatus> = {
  Active: 'REGISTERED',
  PendingVerification: 'PENDING_VERIFICATION',
  Verified: 'VERIFIED',
  Expired: 'EXPIRED',
  Rejected: 'REJECTED',
};

/** Digital-passport timeline event kinds (spec §9, §74, §75). */
export const INSTRUMENT_EVENT_TYPES = [
  'REGISTERED',
  'UPDATED',
  'APPLICATION_SUBMITTED',
  'INSPECTION_SCHEDULED',
  'INSPECTION_COMPLETED',
  'CERTIFICATE_ISSUED',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_REVOKED',
  'OWNERSHIP_TRANSFERRED',
  'LOCATION_CHANGED',
  'FLAGGED',
  'ENFORCEMENT_ACTION',
  'DECOMMISSIONED',
] as const;

export type InstrumentEventType = (typeof INSTRUMENT_EVENT_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Instrument categories & jurisdictions
 * ------------------------------------------------------------------ */

/**
 * Instrument categories.
 *
 * Includes every value the previous `src/lib/utils.ts` list used, so records
 * already in the database stay valid against the new `enum` on the Instrument
 * schema, plus the categories the domain actually needs.
 */
export const INSTRUMENT_TYPES = [
  // Weighing instruments
  'Weighing Scale',
  'Platform Scale',
  'Counter Scale',
  'Weighbridge',
  'Electronic Balance',
  'Spring Balance',
  'Beam Scale',
  'Crane Scale',
  'Hopper Scale',
  // Measuring instruments
  'Fuel Dispenser',
  'Flow Meter',
  'Water Meter',
  'Energy Meter',
  'Storage Tank',
  'Capacity Measure',
  'Volumetric Measure',
  'Length Measure',
  'Measuring Tape',
  // Metered services
  'Taxi Meter',
  'Auto Fare Meter',
  'Speed Meter',
  // Medical & laboratory
  'Clinical Thermometer',
  'Sphygmomanometer',
  'Milk Analyzer',
  'Pressure Gauge',
  // Standards
  'Weights (Standard)',
] as const;

export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

/**
 * Which broad family a category belongs to. Drives the default tolerance table
 * and the unit shown on the inspection form.
 */
export const INSTRUMENT_TYPE_FAMILY: Record<string, 'MASS' | 'VOLUME' | 'LENGTH' | 'FLOW' | 'PRESSURE' | 'OTHER'> = {
  'Weighing Scale': 'MASS',
  'Platform Scale': 'MASS',
  'Counter Scale': 'MASS',
  Weighbridge: 'MASS',
  'Electronic Balance': 'MASS',
  'Spring Balance': 'MASS',
  'Beam Scale': 'MASS',
  'Crane Scale': 'MASS',
  'Hopper Scale': 'MASS',
  'Weights (Standard)': 'MASS',
  'Fuel Dispenser': 'VOLUME',
  'Storage Tank': 'VOLUME',
  'Capacity Measure': 'VOLUME',
  'Volumetric Measure': 'VOLUME',
  'Milk Analyzer': 'VOLUME',
  'Flow Meter': 'FLOW',
  'Water Meter': 'FLOW',
  'Energy Meter': 'FLOW',
  'Length Measure': 'LENGTH',
  'Measuring Tape': 'LENGTH',
  'Taxi Meter': 'OTHER',
  'Auto Fare Meter': 'OTHER',
  'Speed Meter': 'OTHER',
  'Clinical Thermometer': 'OTHER',
  Sphygmomanometer: 'PRESSURE',
  'Pressure Gauge': 'PRESSURE',
};

export const FAMILY_DEFAULT_UNIT: Record<string, string> = {
  MASS: 'kg',
  VOLUME: 'L',
  LENGTH: 'm',
  FLOW: 'L/min',
  PRESSURE: 'kPa',
  OTHER: 'unit',
};

export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

/* ------------------------------------------------------------------ *
 * Notifications & alerts
 * ------------------------------------------------------------------ */

/** Expiry reminder offsets in days before expiry (spec: 60 / 30 / 7 + expired). */
export const EXPIRY_ALERT_OFFSETS_DAYS = [60, 30, 7] as const;

/** A certificate within this many days of expiry is flagged EXPIRING_SOON. */
export const EXPIRING_SOON_WINDOW_DAYS = 60;

export const NOTIFICATION_CHANNELS = ['app', 'email', 'sms', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = ['info', 'success', 'warning', 'error'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Risk / compliance
 * ------------------------------------------------------------------ */

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_FLAG_TYPES = [
  'DUPLICATE_SERIAL',
  'CERTIFICATE_CONFLICT',
  'OVERDUE_VERIFICATION',
  'READING_OUT_OF_TOLERANCE',
  'REPEATED_FAILURE',
  'EVIDENCE_MISSING',
  'GPS_MISMATCH',
  'RAPID_RESUBMISSION',
  'HIGH_FOOTFALL_UNVERIFIED',
] as const;

export type RiskFlagType = (typeof RISK_FLAG_TYPES)[number];

export const RISK_FLAG_STATUSES = ['OPEN', 'REVIEWING', 'DISMISSED', 'CONFIRMED'] as const;
export type RiskFlagStatus = (typeof RISK_FLAG_STATUSES)[number];

/**
 * What each detector is actually claiming, in words an officer can act on.
 *
 * The enum values are database tokens. `READING_OUT_OF_TOLERANCE` describes the
 * detector; "Reading outside permissible error" describes the finding, and the
 * finding is what goes in front of the person who has to decide whether it is a
 * clerical slip or a cloned seal.
 */
export const RISK_FLAG_TYPE_LABELS: Record<RiskFlagType, string> = {
  DUPLICATE_SERIAL: 'Duplicate serial number',
  CERTIFICATE_CONFLICT: 'Conflicting certificates',
  OVERDUE_VERIFICATION: 'Verification overdue',
  READING_OUT_OF_TOLERANCE: 'Reading outside permissible error',
  REPEATED_FAILURE: 'Repeated inspection failures',
  EVIDENCE_MISSING: 'Evidence missing',
  GPS_MISMATCH: 'Location does not match record',
  RAPID_RESUBMISSION: 'Rapid resubmission',
  HIGH_FOOTFALL_UNVERIFIED: 'High-footfall instrument unverified',
};

/** One line on what the detector looks for, shown beside the filter. */
export const RISK_FLAG_TYPE_DESCRIPTIONS: Record<RiskFlagType, string> = {
  DUPLICATE_SERIAL:
    'The same serial number is registered against more than one instrument, which is either a clerical duplicate or a cloned identity.',
  CERTIFICATE_CONFLICT:
    'An instrument holds two certificates whose validity periods overlap, so one of them should not exist.',
  OVERDUE_VERIFICATION:
    'The instrument is in trade use past the date its certificate expired.',
  READING_OUT_OF_TOLERANCE:
    'A recorded test reading exceeds the maximum permissible error for its class, yet the inspection passed.',
  REPEATED_FAILURE:
    'The instrument has failed inspection more than once, which points at a fault rather than a bad day.',
  EVIDENCE_MISSING:
    'An inspection was recorded with fewer photographs than the rule for its jurisdiction requires.',
  GPS_MISMATCH:
    'The geotag on the inspection evidence sits further from the instrument’s recorded address than the rule allows.',
  RAPID_RESUBMISSION:
    'A rejected application was resubmitted almost immediately, too fast for the fault to have been repaired.',
  HIGH_FOOTFALL_UNVERIFIED:
    'A fuel dispenser, weighbridge or retail scale — the categories the public meets most — has never been verified.',
};

export const RISK_FLAG_STATUS_LABELS: Record<RiskFlagStatus, string> = {
  OPEN: 'Awaiting triage',
  REVIEWING: 'Under review',
  DISMISSED: 'Dismissed',
  CONFIRMED: 'Confirmed',
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

/**
 * Badge class for a risk level.
 *
 * Separate from `statusBadgeClass` because the vocabularies collide: `OPEN` and
 * `DISMISSED` are both a risk flag status and an enforcement case status, and
 * `HIGH` means "urgent" here while meaning nothing at all there. One switch trying
 * to serve every enum is how `clay-badge-danger` — a class that does not exist —
 * got returned for the statuses that most needed to be visible.
 */
export function riskLevelBadgeClass(level: string): string {
  switch (level) {
    case 'CRITICAL':
    case 'HIGH':
      return 'clay-badge-error';
    case 'MEDIUM':
      return 'clay-badge-warning';
    case 'LOW':
      return 'clay-badge-info';
    default:
      return 'clay-badge-charcoal';
  }
}

export function riskFlagStatusBadgeClass(status: string): string {
  switch (status) {
    // A confirmed finding is the serious outcome, not the tidy one: it means the
    // suspicion held up.
    case 'CONFIRMED':
      return 'clay-badge-error';
    case 'REVIEWING':
      return 'clay-badge-pending';
    case 'OPEN':
      return 'clay-badge-warning';
    case 'DISMISSED':
      return 'clay-badge-charcoal';
    default:
      return 'clay-badge-info';
  }
}

/* ------------------------------------------------------------------ *
 * Enforcement
 * ------------------------------------------------------------------ */

export const ENFORCEMENT_CASE_STATUSES = [
  'OPEN',
  'INVESTIGATING',
  'NOTICE_ISSUED',
  'HEARING',
  'PENALTY_IMPOSED',
  'CLOSED',
  'DISMISSED',
] as const;

export type EnforcementCaseStatus = (typeof ENFORCEMENT_CASE_STATUSES)[number];

export const ENFORCEMENT_CASE_TYPES = [
  'UNVERIFIED_INSTRUMENT',
  'EXPIRED_CERTIFICATE',
  'TAMPERED_SEAL',
  'FAKE_CERTIFICATE',
  'PUBLIC_COMPLAINT',
  'REPEAT_OFFENDER',
  'OTHER',
] as const;

export type EnforcementCaseType = (typeof ENFORCEMENT_CASE_TYPES)[number];

export const ENFORCEMENT_CASE_TYPE_LABELS: Record<EnforcementCaseType, string> = {
  UNVERIFIED_INSTRUMENT: 'Instrument in use without verification',
  EXPIRED_CERTIFICATE: 'Certificate expired',
  TAMPERED_SEAL: 'Seal tampered with',
  FAKE_CERTIFICATE: 'Forged certificate',
  PUBLIC_COMPLAINT: 'Public complaint',
  REPEAT_OFFENDER: 'Repeat offender',
  OTHER: 'Other',
};

/**
 * The stage a case has reached, in the language of the process rather than of the
 * enum. `NOTICE_ISSUED` is a step in a statutory sequence — notice, then hearing,
 * then penalty — and a label that says so is what stops an officer treating the
 * order as arbitrary.
 */
export const ENFORCEMENT_CASE_STATUS_LABELS: Record<EnforcementCaseStatus, string> = {
  OPEN: 'Open — awaiting triage',
  INVESTIGATING: 'Under investigation',
  NOTICE_ISSUED: 'Notice issued',
  HEARING: 'Hearing scheduled',
  PENALTY_IMPOSED: 'Penalty imposed',
  CLOSED: 'Closed',
  DISMISSED: 'Dismissed',
};

/** Severity is declared inline on the enforcement model, so it is mirrored here. */
export const ENFORCEMENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type EnforcementSeverity = (typeof ENFORCEMENT_SEVERITIES)[number];

export function enforcementStatusBadgeClass(status: string): string {
  switch (status) {
    case 'PENALTY_IMPOSED':
      return 'clay-badge-error';
    case 'NOTICE_ISSUED':
    case 'HEARING':
      return 'clay-badge-warning';
    case 'INVESTIGATING':
      return 'clay-badge-pending';
    case 'OPEN':
      return 'clay-badge-info';
    // Both endings are grey. A dismissal is not a success — it means the
    // department found nothing to act on — and a closure is not a failure.
    case 'CLOSED':
    case 'DISMISSED':
      return 'clay-badge-charcoal';
    default:
      return 'clay-badge-info';
  }
}

/* ------------------------------------------------------------------ *
 * Documents & evidence
 * ------------------------------------------------------------------ */

export const DOCUMENT_TYPES = [
  'OWNERSHIP_PROOF',
  'PURCHASE_INVOICE',
  'MODEL_APPROVAL',
  'PREVIOUS_CERTIFICATE',
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'GST_CERTIFICATE',
  'CALIBRATION_REPORT',
  /**
   * Photographs taken by the inspector during the field visit.
   *
   * Distinct from the applicant's own uploads: this is the department's evidence,
   * it is what `rule.minEvidencePhotos` counts, and it is what a prosecution would
   * rest on. Without its own type it had to be filed as OTHER, alongside the
   * trader's registration photos, and nobody reviewing a case could tell which
   * images the inspector had actually taken.
   */
  'INSPECTION_EVIDENCE',
  'OTHER',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  OWNERSHIP_PROOF: 'Proof of Ownership',
  PURCHASE_INVOICE: 'Purchase Invoice',
  MODEL_APPROVAL: 'Model Approval Certificate',
  PREVIOUS_CERTIFICATE: 'Previous Verification Certificate',
  IDENTITY_PROOF: 'Identity Proof',
  ADDRESS_PROOF: 'Address Proof',
  GST_CERTIFICATE: 'GST Registration',
  CALIBRATION_REPORT: 'Calibration Report',
  INSPECTION_EVIDENCE: 'Field Inspection Evidence',
  OTHER: 'Other Supporting Document',
};

/** Maximum size accepted for a single uploaded document/evidence file. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/* ------------------------------------------------------------------ *
 * Verification / application types
 * ------------------------------------------------------------------ */

export const VERIFICATION_TYPES = ['initial', 'reverification', 'repair', 'transfer'] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_TYPE_LABELS: Record<VerificationType, string> = {
  initial: 'Initial Verification',
  reverification: 'Periodic Re-verification',
  repair: 'Post-repair Verification',
  transfer: 'Ownership / Location Transfer',
};

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

export const FEE_STATUSES = ['Unpaid', 'Pending', 'Paid', 'Refunded', 'Waived', 'Failed'] as const;
export type FeeStatus = (typeof FEE_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * Businesses
 * ------------------------------------------------------------------ */

/**
 * Constitution of the business that owns the instruments. The list lived only in
 * the `Organization` schema's `enum`, so no form could offer it without a client
 * component importing a Mongoose model; the model now takes it from here.
 */
export const ORGANIZATION_TYPES = [
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'PRIVATE_LIMITED',
  'PUBLIC_LIMITED',
  'LLP',
  'COOPERATIVE',
  'GOVERNMENT',
  'OTHER',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const ORGANIZATION_TYPE_LABELS: Record<OrganizationType, string> = {
  PROPRIETORSHIP: 'Sole proprietorship',
  PARTNERSHIP: 'Partnership firm',
  PRIVATE_LIMITED: 'Private limited company',
  PUBLIC_LIMITED: 'Public limited company',
  LLP: 'Limited liability partnership',
  COOPERATIVE: 'Co-operative society',
  GOVERNMENT: 'Government body',
  OTHER: 'Other',
};

/* ------------------------------------------------------------------ *
 * Display helpers (safe on both client and server)
 * ------------------------------------------------------------------ */

/**
 * Maps a status onto one of the `clay-badge-*` utility classes.
 *
 * These must be classes that `globals.css` actually defines. It previously
 * returned `clay-badge-danger` and `clay-badge-muted`, neither of which exists —
 * so every REVOKED, EXPIRED and REJECTED badge in the product rendered as an
 * uncoloured pill, which is precisely the set of statuses that most needs to be
 * unmissable. The real classes are `-error` and `-charcoal`.
 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'ACTIVE':
    case 'APPROVED':
    case 'VERIFIED':
    case 'CERTIFICATE_GENERATED':
    case 'Paid':
      return 'clay-badge-success';
    case 'EXPIRING_SOON':
    case 'QUERY_RAISED':
    case 'SUSPENDED':
    case 'Pending':
    // An unpaid fee is something somebody has to act on, so it reads as a
    // warning. Left to the `default` it came out as a calm blue "Unpaid".
    case 'Unpaid':
      return 'clay-badge-warning';
    case 'REJECTED':
    case 'REVOKED':
    case 'EXPIRED':
    case 'Failed':
      return 'clay-badge-error';
    case 'DRAFT':
    case 'CANCELLED':
    case 'DECOMMISSIONED':
    case 'Refunded':
    case 'Waived':
      return 'clay-badge-charcoal';
    default:
      return 'clay-badge-info';
  }
}

export function applicationStatusLabel(status: string): string {
  return (
    APPLICATION_STATUS_LABELS[status as ApplicationStatus] ??
    APPLICATION_STATUS_LABELS[LEGACY_APPLICATION_STATUS_MAP[status]] ??
    status
  );
}

export function certificateStatusLabel(status: string): string {
  return (
    CERTIFICATE_STATUS_LABELS[status as CertificateStatus] ??
    CERTIFICATE_STATUS_LABELS[LEGACY_CERTIFICATE_STATUS_MAP[status]] ??
    status
  );
}

export function instrumentStatusLabel(status: string): string {
  return (
    INSTRUMENT_STATUS_LABELS[status as InstrumentStatus] ??
    INSTRUMENT_STATUS_LABELS[LEGACY_INSTRUMENT_STATUS_MAP[status]] ??
    status
  );
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Whole days from now until `date`. Negative when the date has passed. */
export function daysUntil(date: string | Date | null | undefined): number | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

/*
 * Fees are stored in whole rupees. Razorpay is the only place paise appear, and
 * `/api/payments/create-order` multiplies by 100 at the boundary — so nothing
 * reaching the UI ever needs dividing.
 */

/** `₹1,20,500` — Indian digit grouping, no decimals on whole amounts. */
export function formatInr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '₹0';
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

/**
 * `₹1.21L` / `₹4.3Cr` — for stat tiles and axis ticks, where a full figure would
 * wrap. Lakh and crore rather than K/M: this is read by Indian district offices,
 * and the full figure is always available in the table and the CSV export.
 */
export function formatInrCompact(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '₹0';
  const n = Math.round(amount);
  if (Math.abs(n) >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)}Cr`;
  if (Math.abs(n) >= 100_000) return `₹${(n / 100_000).toFixed(2)}L`;
  if (Math.abs(n) >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toLocaleString('en-IN')}`;
}

/** `2026-08` → `Aug 2026`, for the month buckets the analytics endpoint returns. */
export function formatMonthKey(key: string): string {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric',
  });
}

/* ------------------------------------------------------------------ *
 * Certificate numbers
 * ------------------------------------------------------------------ *
 * These live here rather than in `ids.ts` because the QR scanner on the public
 * trust page is a client component and has to read a scanned code the same way
 * the server does. Two implementations would mean a scanned code and a typed
 * number could disagree about what was asked for, which is precisely the bug
 * that a public verification page cannot afford. `ids.ts` re-exports them, so
 * server callers are unaffected.
 */

/**
 * Accepts both the current `VT-CERT-YYYY-NNNNNN` format and the historical
 * `CERT-YYYY-XXXXXX` / `LMO-CERT-…` shapes, so QR codes and printed
 * certificates issued before this change still resolve.
 */
export function normalizeCertNo(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

/** Loose validation used before hitting the database on public lookups. */
export function looksLikeCertNo(input: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{4,63}$/.test(normalizeCertNo(input));
}

/**
 * Accepts a raw certificate number, or the full URL encoded in a VTULA QR code.
 * A scanner hands us whatever the code contained, so unwrapping it here keeps
 * every caller from re-implementing the same parsing.
 */
export function extractCertNo(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const fromPath = url.pathname.split('/').filter(Boolean).pop();
      const candidate = url.searchParams.get('certNo') || fromPath;
      if (candidate && looksLikeCertNo(decodeURIComponent(candidate))) {
        return normalizeCertNo(decodeURIComponent(candidate));
      }
      return null;
    } catch {
      return null;
    }
  }

  return looksLikeCertNo(raw) ? normalizeCertNo(raw) : null;
}

/* ------------------------------------------------------------------ *
 * Public complaints
 *
 * The one workflow in this system a member of the public drives themselves.
 * Everything else assumes an account and a role; a customer who thinks the
 * shop's scale is short-weighing them has neither, and requiring them to
 * register would mean the complaint never gets filed.
 * ------------------------------------------------------------------ */

export const COMPLAINT_TYPES = [
  'SHORT_WEIGHT',
  'NO_VERIFICATION_STICKER',
  'EXPIRED_CERTIFICATE',
  'TAMPERED_SEAL',
  'FAULTY_DISPLAY',
  'REFUSED_INSPECTION',
  'FUEL_PUMP_SHORT_DELIVERY',
  'OTHER',
] as const;

export type ComplaintType = (typeof COMPLAINT_TYPES)[number];

export const COMPLAINT_TYPE_LABELS: Record<ComplaintType, string> = {
  SHORT_WEIGHT: 'Short weight / less quantity delivered',
  NO_VERIFICATION_STICKER: 'No verification sticker or stamp on the instrument',
  EXPIRED_CERTIFICATE: 'Verification certificate has expired',
  TAMPERED_SEAL: 'Seal or stamp appears tampered with',
  FAULTY_DISPLAY: 'Display is faulty, hidden or unreadable',
  REFUSED_INSPECTION: 'Trader refused to let the instrument be checked',
  FUEL_PUMP_SHORT_DELIVERY: 'Fuel pump delivering less than the amount paid for',
  OTHER: 'Something else',
};

export const COMPLAINT_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ASSIGNED',
  'FIELD_VISIT_DONE',
  'ACTION_TAKEN',
  'RESOLVED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  ASSIGNED: 'Assigned to an officer',
  FIELD_VISIT_DONE: 'Field visit completed',
  ACTION_TAKEN: 'Action taken',
  RESOLVED: 'Resolved',
  REJECTED: 'Not upheld',
  WITHDRAWN: 'Withdrawn',
};

/**
 * What the complainant is told at each stage.
 *
 * Separate from the label because a status name is a word and a citizen needs a
 * sentence. These are written to be read by someone with no knowledge of how
 * the department works.
 */
export const COMPLAINT_STATUS_PUBLIC_NOTE: Record<ComplaintStatus, string> = {
  SUBMITTED: 'Your complaint has been received and is waiting to be picked up by an officer.',
  UNDER_REVIEW: 'An officer is reading your complaint and the evidence you attached.',
  ASSIGNED: 'A Legal Metrology Officer has been assigned and will visit the premises.',
  FIELD_VISIT_DONE: 'The officer has inspected the premises. A decision is being prepared.',
  ACTION_TAKEN: 'Action has been taken against the trader. See the officer’s note below.',
  RESOLVED: 'This complaint is closed. Thank you for reporting it.',
  REJECTED: 'After inspection the complaint could not be upheld. The reason is below.',
  WITHDRAWN: 'This complaint was withdrawn.',
};

/** Statuses that mean the complaint is finished and needs no further action. */
export const COMPLAINT_CLOSED_STATUSES: ComplaintStatus[] = [
  'RESOLVED',
  'REJECTED',
  'WITHDRAWN',
];

export const COMPLAINT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

/**
 * Video is allowed on complaint evidence and nowhere else.
 *
 * A short clip of a pump dispensing is often the only proof a customer can
 * capture, and telling them to submit a still photograph of a moving needle
 * loses the thing that makes the complaint actionable. Inspection evidence
 * stays images-and-PDF: that path feeds prosecutions and is reviewed offline.
 */
export const ALLOWED_COMPLAINT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

/** Videos need more room than the 5 MB the document pipeline allows. */
export const MAX_COMPLAINT_UPLOAD_BYTES = 25 * 1024 * 1024;

/** How many files one complaint may carry. */
export const MAX_COMPLAINT_EVIDENCE_FILES = 6;

/** `VT-CMP-2026-000112`, case-insensitively, with or without the prefix. */
export function normalizeComplaintNo(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

export function looksLikeComplaintNo(input: string): boolean {
  return /^VT-CMP-\d{4}-\d{6}$/.test(normalizeComplaintNo(input));
}
