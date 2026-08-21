Our website name -> VTULA

# Executive Summary  
Indian law mandates strict verification and stamping of all commercial weights and measures.  The Legal Metrology Act 2009 and its Rules require initial verification by government officers or approved labs and periodic re-verification (e.g. every 24 months for most scales).  Currently these processes are manual or state‑specific, leading to delays and poor oversight.  A unified web/mobile system (such as the national eMaap portal) will automate applications, scheduling, field inspections, digital certificates with QR codes, and expiry reminders.  Key stakeholders – instrument owners, Legal Metrology Officers (LMOs), Government Approved Test Centres (GATCs), consumers and admins – will use role-based interfaces.  Core features include online registration, application submission, scheduling, report dashboards, and QR-enabled digital stamping.  Security (TLS, JWT, OWASP controls), cryptographic signing of certificates, and audit logging ensure trust.  Unique Indian enhancements might include Aadhaar/UMANG login, DigiLocker e-signature, geo‑tagged verification photos, a public QR verification portal, and analytics with ML for anomaly detection.  We propose a Next.js frontend with MongoDB backend: a robust data model, RESTful (or GraphQL) APIs, and components/pages for each workflow.  Below we detail legal context, personas, user flows, data schema, API design, security, certificate format, notifications, mobile support, deployment, and a development roadmap.

## Regulatory Context  
Section 24 of the Legal Metrology Act, 2009 makes it mandatory that any weight or measure “used or intended to be used in any transaction or for protection” must be verified and stamped by an LMO before use.  Rule 27 of the Legal Metrology (General) Rules 2011 (amended 2021) reinforces this, requiring periodic re-verification.  For example, weights and length measures must be re-verified every 24 months, storage tanks every 6 months, and certain vehicles annually.  Amended rules also specify *which state* conducts verification: initial stamping occurs in the state of manufacture/import or installation, while re-verification happens in the state of use.  Non-verified instruments can incur fines up to ₹10,000 or imprisonment.  

To modernize compliance, India is building the national eMaap portal to unify all state systems.  eMaap will handle licensing, packaging approvals, and the entire verification/stamping lifecycle.  A recent press release notes that eMaap “simplifies issuing, renewing, and amending licenses, as well as handling verification & stamping of weighing & measuring instruments” in a transparent, digital way.  The government is also expanding private testing: amendments allow Government Approved Test Centres (GATCs) to verify 23 categories of instruments (healthcare devices, energy meters, transport scales, etc.).  These GATCs are now on-boarded via eMaap with an online application process, making the ecosystem faster and more accessible.  

## Stakeholder Personas  
- **Instrument Owners (Traders/Manufacturers):** Businesses that own weights and measures (e.g. shopkeepers, factories).  They need to register, submit (re)verification applications, pay fees, and receive certificates.  They will use a portal/mobile app to manage their instruments and applications.  
- **Legal Metrology Officers (LMOs):** State officers who perform inspections and stamping.  They receive assigned verification tasks, record inspection data (readings, photos, remarks), approve or reject instruments, and issue certificates.  They need a mobile-friendly interface for fieldwork (with GPS/photo support) and dashboards to track work.  
- **Government Approved Test Centres (GATCs):** Accredited labs or institutions authorized to verify special instruments (e.g. large weighbridges, medical devices).  GATCs submit credentials, receive shipments of instruments, test them, and digitally report results.  Their workflow parallels LMOs but may include lab reports.  
- **Consumers:** End buyers or general public.  They benefit from accurate instruments.  Via a public portal or scanning a certificate QR code, they should verify a machine’s certificate validity.  This increases trust in market transactions.  
- **System Administrators:** Portal administrators at state or central level.  They configure rules (fees, regions, instrument categories), manage user accounts (LMOs, GATCs), monitor system health, and generate reports on compliance metrics.  

Each persona has a distinct user journey (below) and role-based access.

## User Journeys  
1. **Instrument Owner / Trader:** Registers on the portal (possibly via Aadhaar e-KYC).  Adds their profile and registers one or more instruments (specifying type, model, serial no., installation location, etc.).  Creates a new verification application by selecting an instrument, indicating whether it’s initial or renewal, and attaching supporting documents/photos.  System calculates fees; owner pays online.  Upon submission, an application ID is generated. The owner can log in to track status (pending, scheduled, completed) and receive notifications. When the LMO completes verification, the digital certificate (with QR) is posted to their account, and an alert is sent.  The owner can download/print the certificate for display on the instrument. Before expiry, the system auto-alerts the owner to reapply.  

2. **Legal Metrology Officer (LMO):** Logs in to a dashboard showing tasks. Sees new or pending applications in their jurisdiction. Can filter/sort by due date or priority. Clicks an application to view instrument details and attached docs. Either schedules an inspection or performs it immediately (field visit). In the field (using the mobile app), the LMO updates inspection results: e.g. instrument readings, conformity checks, and can upload tamper-proof photos (auto geo-tagged). The LMO then approves or rejects the instrument. If approved, the system generates a digital verification certificate with QR. If rejected, a notice is sent requesting repairs and re-submission. The LMO marks the application complete, and the instrument’s next due date is set in the system.  

3. **GATC Technician:** Similar to LMO, but for specialized instruments. After portal assignment (or owner choice), the center receives the instrument. They run tests and enter calibration data into the system. They then sign off the result (possibly with a digital signature) which generates a certificate.  

4. **Consumer (Public):** Goes to a public portal or scans the QR on an instrument’s sticker. Either method brings up certificate details (instrument ID, owner, certified date, expiry, LMO/GATC signer) and verifies its authenticity (by checking the digital signature or blockchain entry). This reassures consumers the scale is legitimate.  

5. **Administrator:** Accesses an admin console to configure instrument categories, fee schedules, and user roles. Monitors system reports (e.g. numbers of applications pending or certifications issued per region). Reviews audit logs for compliance. Onboards new LMOs or adds GATC organization credentials. May also handle grievance appeals by linking to legal cases or fines.  

## Functional Requirements (Pages & APIs)  

**Key Features (Web & Mobile):**  
- **User Management:** Secure registration and login (with role-based dashboards). Profile edit for owners, officers, GATCs, etc. Password reset, multi-factor/Aadhaar login.  
- **Instrument Registry:** CRUD pages for owners to add and manage instruments (fields: type, serial, model, capacity, location, photos, installation date, etc.).  
- **Application Workflow:** Pages/forms for new verification or re-verification applications. Includes instrument selection, inspection location (e.g. “at client site” vs “at office”), fee preview, and document upload.  
- **Scheduling & Assignment:** LMO interface to view and assign verification tasks (by date, region, or LMO workload). Calendar or kanban view of appointments.  
- **Inspection Entry:** Mobile-enabled forms for field officers to input inspection data (e.g. actual measurements, error tolerance, remarks). Support for uploading/drawing stamp placement photos (auto geo-tagged).  
- **Certificate Generation:** Automated creation of digital certificates (PDF/JSON) with QR code after approval. Pages to preview/print certificates.  
- **Notifications:** UI and backend for email/SMS/push notifications (e.g. application received, inspection scheduled, certificate issued, expiry reminders).  
- **Dashboards & Reports:** Role-based dashboards. Owner sees their instruments’ status; LMOs see pending workload; admins see compliance metrics. Chart and table views (e.g. number of applications by status, upcoming expiries). Exportable reports (CSV/PDF).  
- **Search & Filters:** Global search across instruments, applications, certificates. Filters by state, date, status, LMO, etc.  
- **Audit Trail:** Secure logs of critical actions (logins, status changes, certificate issuances) viewable by admin.  

Below is an illustrative mapping of key pages/components and corresponding API endpoints (for a RESTful design; GraphQL alternatives could also be considered for complex querying).

| **Page/Component**            | **API Endpoint**                    | **Method** | **Purpose**                           | **Auth & Roles**             |
| ----------------------------- | ----------------------------------- | ---------- | ------------------------------------- | ---------------------------- |
| **/register** (User Signup)   | `/api/auth/register`                | POST       | Create new user account               | Public                       |
| **/login**                    | `/api/auth/login`                   | POST       | User authentication (return JWT)      | Public                       |
| **/profile**                  | `/api/users/me`                     | GET / PUT  | Get/update own profile               | Authenticated (any role)     |
| **/users/:id**                | `/api/users/:id`                    | GET/PUT    | Admin: manage user account           | Admin                        |
| **/instruments**              | `/api/instruments`                  | GET/POST   | List or add instruments              | Auth (owner)                 |
| **/instruments/:id**          | `/api/instruments/:id`              | GET/PUT/DELETE | View/edit instrument             | Owner / Admin                |
| **/applications**             | `/api/applications`                 | GET/POST   | List or apply for verif.             | Auth (owner submits)         |
| **/applications/:id**         | `/api/applications/:id`             | GET/PUT    | View/update application              | Owner / LMO / Admin          |
| **/applications/:id/assign**  | `/api/applications/:id/assign`      | POST       | LMO assigns themselves or others     | LMO/GATC                     |
| **/applications/:id/submit**  | `/api/applications/:id/submit`      | POST       | Owner submits docs/pays fees         | Owner                        |
| **/applications/:id/status**  | `/api/applications/:id/status`      | PUT        | LMO updates status/remarks           | LMO / Admin                  |
| **/certificates**             | `/api/certificates`                 | GET        | List certificates                    | Authenticated (owner sees theirs) |
| **/certificates/:id**         | `/api/certificates/:id`             | GET        | View certificate details / QR        | Authenticated                |
| **/certificates/verify**      | `/api/certificates/verify?qr=...`   | GET        | Public QR code verification          | Public                       |
| **/notifications**            | `/api/notifications`                | GET        | List user notifications              | Authenticated                |
| **/notifications/:id/read**   | `/api/notifications/:id/read`       | POST       | Mark notification as read            | Authenticated                |
| **/dashboard/metrics**        | `/api/reports/metrics`              | GET        | Aggregated stats for dashboard       | LMO/Admin                    |
| **/search**                   | `/api/search?q=...`                 | GET        | Full-text search query               | Authenticated                |

Each POST/PUT endpoint will validate its payload (e.g. required fields, formats). For instance, `/api/applications` might accept JSON: 
```json
{
  "instrumentId": "INSTR123",
  "type": "reverification",
  "location": "At my premises",
  "documents": ["photonumeric.jpg", "calibration_doc.pdf"]
}
``` 
with the server checking that `instrumentId` exists for the user, `type` is allowed, and files meet size/type rules.  Responses follow a consistent JSON format (e.g. including a status and data or error message).  Sample success response for a new application:  
```json
{
  "success": true,
  "applicationId": "APP-000456",
  "message": "Application submitted successfully"
}
```  
The API could also support GraphQL, especially for flexible queries (e.g. filtering certificates), but REST is straightforward and aligns with Next.js API routes.

## Data Model (MongoDB Schema)  

A **non-exhaustive schema** might include the following collections.  Each document’s fields should be indexed appropriately (e.g. userID, serialNo, application status):

| **Collection**    | **Fields (examples)**                                                                                                                                     | **Indexes**                             | **Relationships**                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| **Users**         | `_id`, name, email, **passwordHash**, role (enum: Owner, LMO, GATC, Admin), Aadhaar-linkedID, mobile, state/district, profileDetails                      | `email` (unique), `role`, `state`       | -                                  |
| **Instruments**   | `_id`, ownerId (User), type (e.g. scale, meter), brand, model, serialNo, capacity, accuracyClass, installationState, location (address/GPS)               | `serialNo` (unique), `ownerId`, `type`  | Owned by User; linked to Application(s) |
| **Applications**  | `_id`, instrumentId, ownerId, type (initial/reverification), submittedDate, dueDate, status (pending/scheduled/inspected/approved/rejected), feePaid, assignedTo (LMO/GATC ID), attachments (file references), remarks | `ownerId`, `status`, `dueDate`, `assignedTo` | Belongs to Instrument, Owner      |
| **Certificates**  | `_id`, applicationId, certNo (unique), issuedDate, expiryDate, issuedBy (LMO/GATC ID), dataHash, digitalSignature, qrCode (data or link)                   | `certNo`, `issuedBy`                   | Based on Application              |
| **Notifications** | `_id`, userId, message, type (email/SMS/app), relatedId (e.g. application), isRead, createdAt                                                             | `userId`, `isRead`                      | Linked to User, possibly Application |
| **AuditLogs**     | `_id`, action (login/application/issueCert/etc.), userId, timestamp, details                                                                             | `userId`, `timestamp`                   | (No foreign key, logs by user)    |
| **GATCApps**      | `_id`, orgName, address, categoriesApplied (list), status (pending/approved), contactInfo                                                               | `orgName`, `status`                     | -                                  |

Indexes: e.g. an index on `{ ownerId: 1, status: 1 }` on Applications for fast lookup.  Use text indexes on fields like instrument type/model for search.

## Authentication & Role-Based Access  
The system will use secure authentication (e.g. JSON Web Tokens or NextAuth).  Passwords are hashed (bcrypt/argon2).  Roles determine access: an **Owners** can only see and edit their own instruments/applications, **LMOs** see applications in their jurisdiction, **GATCs** see assigned lab tasks, **Admins** can manage all records.  Session tokens (JWTs) are stored in HttpOnly cookies or local storage with same-site flags.  Optionally, allow integration with government identity providers: e.g. Aadhaar-based e-KYC via UIDAI (such as eSign through DigiLocker or UMANG).  That would let users log in using their Aadhaar-linked mobile OTP, reducing password hassles.  

A **role-permissions matrix** (simplified) might be:  

| **Role**       | **Can Submit Application** | **Can Schedule/Inspect** | **Can Issue Certificate** | **Can View All Records** | **Admin Console** |
| -------------- | -------------------------- | ------------------------ | ------------------------- | ------------------------ | ----------------- |
| Owner/Trader   | ✓ (own)                    | ✗                        | ✗                         | ✗ (own only)             | ✗                 |
| LMO            | ✗                          | ✓ (in region)            | ✓ (for passed)            | ✓ (region only)          | ✗ (limited)       |
| GATC           | ✗                          | ✓ (in assigned center)   | ✓ (for lab tests)         | ✓ (assigned only)        | ✗ (limited)       |
| Admin          | ✓ (all)                    | ✓                        | ✓                         | ✓ (global)               | ✓ (full access)   |

APIs enforce these rules on every request. For example, `/api/applications` GET will filter by owner or region based on JWT role.  Middleware (e.g. express.js or Next.js middleware) will validate tokens and check scopes.

## Security Controls  
We follow OWASP best practices.  All inputs (forms, query params) are validated and sanitized.  Use parameterized queries/ORM to prevent injection.  Implement CSRF protection (via tokens or same-site cookies) for state-changing endpoints.  Set Content Security Policy headers to mitigate XSS, and escape all dynamic HTML.  Use HTTPS/TLS for all traffic; strict TLS settings and HSTS.  

Sensitive data (user credentials, encryption keys) are securely stored (e.g. environment variables, Vault).  Encrypt critical fields at rest if needed (MongoDB supports at-rest encryption).  File uploads are scanned for malware and restricted by type/size.  Sessions expire or require re-auth.  

Maintain audit logs for all important events (logins, failed attempts, data edits, certificate issues).  Use monitoring/alerting (e.g. detect brute-force patterns or anomaly).  Regular security testing (SAST and penetration tests) should be part of the development cycle.

## QR-Enabled Digital Certificate Design  
Each issued certificate will be a digitally signed JSON or PDF with all verification details.  For example, fields might include certificate number, instrument details (type, serial), owner ID, verified date, expiry date, issuing officer ID, and signature of the issuing LMO/GATC.  This data is hashed and signed using a private key (e.g. government’s CA or departmental key).  The QR code printed on the instrument/sticker encodes either the certificate ID or the full certificate data+signature. 

Upon scanning the QR (via a mobile app or browser), the system fetches the certificate record and verifies the signature.  If valid, it displays details to the user; otherwise it shows “invalid certificate”.  We could also optionally record each certificate on a blockchain (as India’s “Certificate Chain” portal suggests) so anyone can audit-trail certificates immutably.  

**Sample certificate QR content (JSON, before QR encoding):** 
```json
{
  "certNo": "CERT2026-000987",
  "instrumentId": "INSTR-12345",
  "verifiedOn": "2026-07-15",
  "expiryOn": "2028-07-14",
  "verifiedBy": "LMO-GJ-AHMEDABAD-001",
  "signature": "MEYCIQC0...XYZ" // base64 signature
}
```
The QR code encodes this JSON. On the backend, `/api/certificates/verify` verifies the signature against the public key for that LMO’s state.  Only if signature checks out is the cert considered authentic.  

## Scheduling & Allocation Algorithms  
The system will automate scheduling.  By default, applications are queued by region and application date.  If the instrument’s installation location falls within an LMO’s district, it’s routed to that LMO.  If no LMO is available or if the instrument category matches a GATC’s expertise, the system can auto-assign to an appropriate GATC or alternate LMO.  A simple algorithm: sort unassigned applications by submission date (or expiry urgency), then assign them in round-robin fashion to available officers, considering their current load.  The system should allow manual reassignment by supervisors.  

We might implement a matching service: e.g. an LMO has capacity for X inspections per week; new jobs fill their schedule until capacity, then overflow to next officer.  GATC assignments follow similar logic.  Automated reminder emails can notify officers of assigned tasks.  For fairness, logging allocation times prevents any officer from being overloaded.  

## Notifications (Email/SMS/Push)  
Automated notifications keep stakeholders informed.  Examples include:
- **Email/SMS to Owner:** “Application received (ID 456), pending inspection.”; “Instrument X passed verification – download certificate”; “Your instrument’s certificate expires in 30 days (ID 123). Please reapply.”  
- **Email/SMS to LMO:** “New inspection scheduled on Date for application 789.”; “Document uploaded by user – please review.”  
- **Push (PWA/App) to Owner:** In-app alerts for status changes.  
Notifications are triggered by events (application submitted, status updated, certificate issued, upcoming expiry).  A background job (cron) checks for certificates expiring in configurable intervals (e.g. 30, 7, 1 days) and enqueues reminders.  Emails/SMS use services like SendGrid/Twilio, while push uses the browser’s Push API (via a service worker).  

## File/Photo Uploads  
Applications often require attachments (calibration certificates, purchase bills).  The system will allow multi-part uploads (photos, PDFs).  We recommend using a cloud storage (e.g. AWS S3 or MongoDB GridFS).  A pre-signed URL approach lets the client upload directly to storage.  Each uploaded file is scanned for type/size (e.g. images <5MB, PDF <2MB).  

For field inspection photos, the mobile interface will capture images via the device camera.  The app should embed GPS coordinates and timestamp (to deter fraud).  Example: when LMO snaps a photo of a scale’s dial, the app automatically adds EXIF with lat/long.  These geotagged images are uploaded and linked to the inspection record.  

All uploads are secured (SSL in transit) and access-controlled (only the owner, assigned LMO, and admins can view an application’s docs).  

## Search & Filters  
Robust search helps quickly find records.  We’ll implement a full-text search on relevant fields (instrument model, owner name, location) and indexes on numeric IDs.  Filtering options include instrument type, verification status, location, owner name, date ranges, and assigned LMO.  For example, an LMO can filter “All pending inspections in [State] assigned to me”.  The search API (`/api/search`) can combine multiple criteria.  MongoDB’s query capabilities (or ElasticSearch for full-text) support this.  

## Dashboards & Reports  
Dashboards provide at-a-glance metrics.  Possible widgets: total applications (new, pending, completed), instruments by type, upcoming expiries, LMO workload breakdown, number of GATC jobs.  Visual charts (bar, pie) can show trends (e.g. verifications per month).  Administrative reports (accessible via `/api/reports/*`) can be generated in CSV/PDF for archiving or offline analysis.  For example, an Enforcement dashboard might flag merchants with many inspection failures.  

**Example metrics:** 
- *Applications in last 30 days:* 120 (40 new, 60 pending, 20 closed).  
- *Average turnaround time:* 5 days.  
- *Certificates expiring next month:* 45.  
- *Top 5 instrument types by volume:* retail scale, fuel pump meter, etc.  

Charts can be implemented with libraries like Chart.js or Recharts on React, fed by API endpoints that aggregate the MongoDB data (e.g. using MongoDB’s aggregation pipeline).  

## Expiry Alerts and Cron Jobs  
A scheduler service (Node-cron or serverless cron) will run daily.  It queries certificates nearing expiry (e.g. within 30 or 7 days).  For each, it creates a notification to the owner.  If expired, it marks the instrument as “due for re-verification” and may auto-generate a fine notice draft.  System logs these reminders and can escalate to the LMO if re-verification is overdue.  

Additionally, the cron might archive old data (move audits older than X years) or run health checks on the system (e.g. disk usage, broken links).  

## Offline Mobile Support (PWA)  
A Progressive Web App will enable limited offline use for field inspectors.  Using Next.js PWA features, key pages (e.g. inspection form templates, past assigned cases) can be cached.  In offline mode, an LMO can still view pending tasks (cached) and fill in inspection data and photos.  These records are stored in local IndexedDB or device storage. When connectivity is restored, the app syncs pending inspections to the server via the API.  

Key PWA features:  
- **Installable app:** so LMOs can add it to home screen on Android.  
- **Service Worker:** for caching static assets and routes.  
- **Local Data Storage:** form data and photos hold until sync.  
- **Geolocation:** use device GPS to capture location of inspection.  

This ensures LMOs can function in remote areas with poor connectivity, improving field efficiency.  

## Scalability and Backup  
The architecture should be scalable.  We will deploy the Next.js frontend and API on a cloud platform (e.g. Vercel or AWS Lambda) enabling auto-scaling.  Use MongoDB Atlas for the database, which provides replica sets and scaling (sharding if needed).  Use a CDN for serving static assets (scripts, images).  

Design with stateless services so more instances can be added under load.  For performance, use caching (e.g. Redis or in-process) for frequently accessed data (lookups of instrument types, dropdown lists).  Implement rate limiting on APIs to prevent abuse.  

For backups, MongoDB Atlas can be configured to take daily snapshots.  Additionally, export critical collections (like Certificates) to secure storage (e.g. AWS S3) for disaster recovery.  Source code is managed in git with CI/CD pipelines for testing and deployment.  Environment-specific configs (e.g. database URI, email API keys) are injected as env variables.

## Testing Strategy  
A rigorous testing plan ensures reliability.  **Unit tests** (Jest, Mocha) cover utility functions, data validation, and small React components.  **Integration tests** verify API endpoints (using supertest or a similar HTTP assertion library) with a test database instance.  **End-to-End tests** (Cypress or Playwright) simulate user flows: e.g. owner logs in, submits application, LMO inspects it, certificate is issued, and public verification works.  

Include **security tests**: use automated tools (like OWASP ZAP) to scan for vulnerabilities (XSS, SQLi, etc).  **Load testing** (with tools like Artillery) can simulate many concurrent users to find bottlenecks.  All tests run on each commit via the CI system.  

### Sample API Contract  
For clarity, here is a sample REST API interaction:  

- **Request** (Create Application):  
  ```http
  POST /api/applications HTTP/1.1
  Authorization: Bearer <token>
  Content-Type: application/json

  {
    "instrumentId": "608c1f85a1b2c831d8f0e9ab",
    "type": "reverification",
    "inspectionLocation": "At my premises",
    "scheduledDate": "2026-09-15",
    "documents": [
      {"name": "calibration.pdf", "url": "https://s3/.../calibration.pdf"}
    ]
  }
  ```  
  **Response:**  
  ```json
  {
    "success": true,
    "application": {
      "id": "APP-000123",
      "status": "Pending",
      "feeDue": 500.00
    }
  }
  ```  

- **Request** (Issue Certificate by LMO):  
  ```http
  PUT /api/applications/APP-000123/status HTTP/1.1
  Authorization: Bearer <LMO_token>
  Content-Type: application/json

  {
    "status": "Approved",
    "remarks": "Instrument accurate within limits",
    "nextVerificationDue": "2028-09-14"
  }
  ```  
  **Response:**  
  ```json
  {
    "success": true,
    "certificate": {
      "id": "CERT-2026-000987",
      "qrCodeUrl": "/qr/CERT-2026-000987.png"
    }
  }
  ```  

These endpoints include validation (e.g. only an assigned LMO can set status to Approved).  

## MongoDB Schema Example  
Below is a simplified Mongoose schema for Users and Applications as an illustration (actual schema would be more detailed):

```js
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  passwordHash: String,
  role: { type: String, enum: ["Owner","LMO","GATC","Admin"], required: true },
  state: String,
  createdAt: Date
});

const ApplicationSchema = new mongoose.Schema({
  instrumentId: { type: mongoose.ObjectId, ref: 'Instrument', required: true },
  ownerId: { type: mongoose.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ["initial","reverification"], required: true },
  status: { type: String, default: "Pending" },
  submittedAt: Date,
  scheduledFor: Date,
  assignedTo: { type: mongoose.ObjectId, ref: 'User' },
  feePaid: Number,
  documents: [{
    name: String,
    url: String
  }],
  remarks: String
});
```

Indexes would be created on fields like `email` (unique), `ownerId`, `status`, etc.  

## Prioritized Feature List  
- **MVP (Minimum Viable Product):**  
  - User registration/login (Owners, LMOs) and role management.  
  - Instrument registry CRUD.  
  - Application submission form (with file upload) and tracking.  
  - LMO dashboard to view/assign applications.  
  - Basic inspection entry and status update.  
  - Digital certificate generation (PDF/QR) upon approval.  
  - Database, auth, and security framework.  

- **V1 (Feature-Rich Release):**  
  - Notifications (email/SMS reminders, push).  
  - Advanced search and filters (state, instrument type).  
  - Comprehensive dashboards and reporting.  
  - GATC workflows and approvals.  
  - Admin console for configuring fees, regions, and users.  
  - Exportable reports (CSV/PDF).  
  - Basic PWA support (mobile offline form).  

- **V2 (Advanced/Innovative):**  
  - Aadhaar/UMANG single-sign-on and DigiLocker e-sign integration.  
  - Public QR verification portal/app (no login needed).  
  - Machine learning analytics: e.g. anomaly detection on inspections (fraud patterns, predictive scheduling).  
  - Blockchain integration for certificate storage/verifiability.  
  - Multi-language UI (Hindi, regional languages).  
  - IoT integration: auto-reporting scales (future scope).  

Each phase adds complexity.  MVP focuses on core legality and digital workflow, V1 adds convenience and oversight tools, V2 introduces cutting-edge features for transparency and convenience.  

## UI/UX Wireframe Suggestions  
While actual designs require UX work, here are key screen ideas:  
- **Login/Register Page:** Simple form with fields (email, password, role selector). Options for Aadhaar login.  
- **Owner Dashboard:** List of the owner’s instruments and applications (with statuses). Button to “Add Instrument” and “New Verification”. Tiles for “Upcoming Expiries” and “Notifications”.  
- **Application Form:** Step-by-step wizard: 1) Select instrument (or add new). 2) Enter details (type, location). 3) Upload documents (with preview). 4) Payment & submit. Show fee breakdown and unique application ID after submission.  
- **LMO Dashboard:** Pending tasks list or Kanban columns (Pending, Scheduled, Completed). A calendar view for scheduled inspections. Quick stats (e.g. total pending, today’s schedule).  
- **Inspection Entry (Mobile):** Form with fields for actual readings, checkboxes for compliance items, photo capture button (auto-add GPS), and “Approve” or “Reject” actions.  
- **Certificate View:** Page showing all certificate details and a large QR code. Buttons to “Download PDF” or “Print Sticker”.  

Wireframes should be clean, mobile-friendly (responsive). Use clear status indicators (e.g. color-coded badges: Pending, Approved, Expired).  Accessibility (WCAG) should be considered (high contrast, screen-reader labels).  

## Development Roadmap (Task Breakdown)  
Below is a sample Agile-style breakdown with rough story points (SP).  We assume 1 SP ≈ 1 developer-day.  

| **Milestone / Sprint**        | **Features/Tasks**                                        | **Story Points** |
| ---------------------------- | --------------------------------------------------------- | ---------------: |
| **MVP - Sprint 1 (Setup)**    | Project setup (Next.js, MongoDB), CI/CD pipeline, auth infrastructure, user registration/login |       8        |
| **MVP - Sprint 2**           | Instrument CRUD (schema, pages), owner dashboard view             |       8        |
| **MVP - Sprint 3**           | Application form/page (submission flow, file upload)    |      13        |
| **MVP - Sprint 4**           | LMO dashboard (list of tasks), assignment logic         |      8         |
| **MVP - Sprint 5**           | Inspection entry form (mobile-friendly), status updates |      13        |
| **MVP - Sprint 6**           | Certificate generation (PDF & QR), certificate view page|      8         |
| **V1 - Sprint 7**            | Notifications service (email/SMS integration)           |      5         |
| **V1 - Sprint 8**            | Search/filters implementation, improved UI/UX tweaks     |      5         |
| **V1 - Sprint 9**            | Reports & dashboards (stats APIs, charts)               |      8         |
| **V1 - Sprint 10**          | Admin console (roles, fee schedules, settings)          |      8         |
| **V2 - Sprint 11**          | PWA features (offline support, service worker)          |      5         |
| **V2 - Sprint 12**          | Aadhaar/UMANG e-KYC integration, DigiLocker eSign       |     13         |
| **V2 - Sprint 13**          | Public QR/portal, analytics/ML modules                  |     13         |

(*Each sprint ~2 weeks; total ~65 story points for MVP, ~30 for V1, ~30 for V2.)  Milestones could be grouped by 3-month releases.  

## Unique/Cool India-Specific Features  
To leverage Indian digital infrastructure:  
- **Aadhaar/UMANG Login:** Allow users to log in using Aadhaar-based OTP via the UMANG platform or eKYC. This ensures only verified residents use the portal and streamlines registration.  
- **DigiLocker e-Signature:** Integrate with DigiLocker/eSign for digital signing of certificates or GATC test reports. LMOs could use their eSign token to sign PDF certificates, eliminating manual wet signatures.  
- **Geo-Tagged Photos & Tamper-Proofing:** The mobile app automatically captures GPS coordinates and timestamp with each inspection photo. This deters fraud (e.g. fake compliance photos) and can be printed on QR/code lock with each certificate.  
- **Public Verification QR Portal:** Build a public-facing portal where anyone can enter a certificate number or scan its QR to verify authenticity. Possibly link with certificatechain.nic.in to store certificate hashes on blockchain for public audit.  
- **Analytics & ML:** Collect data on verification patterns. Use ML to flag anomalies (e.g. if a particular instrument type frequently fails, or if re-verification intervals are being ignored). Provide predictive analytics (e.g. which regions need more LMO resources based on backlog).  
- **Consumer Awareness:** A simple mobile/web app for consumers to check MRP scanner or packaging labels against LM database (some states do this). Tie in a helpline or complaint submission (via UMANG or grievance redressal).  
- **Regional Languages:** Offer the portal in Hindi and major regional languages (Marathi, Tamil, etc.) since many traders and officers are more comfortable in local language.  

## References  
- Legal Metrology Act & Rules: Section 24 and Rule 27 mandate periodic stamping of weights/measures. The Act’s amendments clarify verification states.  
- eMaap Initiative: National portal to unify state systems for licenses, verifications, etc..  
- GATC Expansion: Press reports note the online GATC application (Aug 2026) and 23 instrument categories now authorized.  
- User Guide Example: Maharashtra’s Vaidhmapan portal requires user registration and generates a unique application number on submission.  

These sources underline the legal requirements and the drive for digital transformation in India’s legal metrology domain.