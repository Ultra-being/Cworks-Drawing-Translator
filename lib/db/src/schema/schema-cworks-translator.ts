import { pgTable, serial, text, timestamp, integer, varchar, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './schema';

// Cworks Drawing Translator — standalone long-running, drawing-aware PDF
// translation jobs. Fresh tables: this app never reads Navigator's
// cad_translation_* records. Original/output files and thumbnails live in
// private Object Storage under the `cworks-translator/` prefix; only metadata
// is kept in Postgres.
export const cworksTranslationJobs = pgTable('cworks_translation_jobs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  sourceLanguage: varchar('source_language', { length: 24 }).notNull().default('auto'),
  targetLanguage: varchar('target_language', { length: 8 }).notNull().default('en'),
  scope: varchar('scope', { length: 24 }).notNull().default('full'),
  drawingDepth: varchar('drawing_depth', { length: 24 }).notNull().default('major-text'),
  status: varchar('status', { length: 24 }).notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  progressNote: text('progress_note'),
  pageCount: integer('page_count').notNull().default(0),
  pagesDone: integer('pages_done').notNull().default(0),
  originalFilename: text('original_filename').notNull(),
  // PDF remains the legacy vector-overlay path. Native DXF is always retained
  // and released as DXF; it is never converted into editable PDF data.
  sourceFormat: varchar('source_format', { length: 8 }).notNull().default('pdf'),
  sourceStoredName: text('source_stored_name').notNull(),
  outputStoredName: text('output_stored_name'),
  summaryStoredName: text('summary_stored_name'),
  ledgerStoredName: text('ledger_stored_name'),
  preservationStoredName: text('preservation_stored_name'),
  machineAuditStatus: varchar('machine_audit_status', { length: 24 }).notNull().default('pending'),
  machineAuditModel: text('machine_audit_model'),
  approvedRevision: integer('approved_revision'),
  approvedAt: timestamp('approved_at'),
  feedbackNotes: text('feedback_notes'),
  repairBrief: jsonb('repair_brief'),
  errorMessage: text('error_message'),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  costEstimate: varchar('cost_estimate', { length: 24 }).notNull().default('0'),
  revisionCount: integer('revision_count').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  runToken: text('run_token'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const cworksTranslationPages = pgTable('cworks_translation_pages', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),
  thumbnailStoredName: text('thumbnail_stored_name').notNull(),
  sourceThumbnailStoredName: text('source_thumbnail_stored_name'),
  sourceBlockCount: integer('source_block_count').notNull().default(0),
  translatedBlockCount: integer('translated_block_count').notNull().default(0),
  warnings: jsonb('warnings'),
  previewMetadata: jsonb('preview_metadata'),
  machineAuditStatus: varchar('machine_audit_status', { length: 24 }).notNull().default('pending'),
  machineAuditFindings: jsonb('machine_audit_findings'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('cworks_translation_pages_job_page_uq').on(t.jobId, t.pageNumber),
]);

// Completed translation pages are checkpointed by revision so a replacement
// worker can resume after an instance sleep or expired lease without sending
// the same confidential drawing text to the provider again.
export const cworksTranslationCheckpoints = pgTable('cworks_translation_checkpoints', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  revisionCount: integer('revision_count').notNull(),
  pageNumber: integer('page_number').notNull(),
  sourceHash: text('source_hash').notNull(),
  translations: jsonb('translations').notNull(),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('cworks_translation_checkpoints_revision_page_uq').on(t.jobId, t.revisionCount, t.pageNumber),
  index('cworks_translation_checkpoints_job_revision_idx').on(t.jobId, t.revisionCount),
]);

// Rendered translated-PDF pages are checkpointed by revision so a replacement
// worker can resume rendering without re-rendering pages already stored in
// private Object Storage. Server-only hidden manifest.
export const cworksTranslationRenderCheckpoints = pgTable('cworks_translation_render_checkpoints', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  revisionCount: integer('revision_count').notNull(),
  pageNumber: integer('page_number').notNull(),
  renderHash: text('render_hash').notNull(),
  // processing → ready
  status: varchar('status', { length: 24 }).notNull().default('processing'),
  runToken: text('run_token'),
  fragmentStoredName: text('fragment_stored_name'),
  thumbnailStoredName: text('thumbnail_stored_name'),
  fragmentSha256: text('fragment_sha256'),
  thumbnailSha256: text('thumbnail_sha256'),
  sourceBlockCount: integer('source_block_count').notNull().default(0),
  translatedBlockCount: integer('translated_block_count').notNull().default(0),
  warnings: jsonb('warnings'),
  previewMetadata: jsonb('preview_metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('cworks_translation_render_checkpoints_revision_page_uq').on(t.jobId, t.revisionCount, t.pageNumber),
  index('cworks_translation_render_checkpoints_job_revision_idx').on(t.jobId, t.revisionCount),
]);

// Mutable page-check state for the active review revision. Prior revisions are
// retained so a revision never erases what a reviewer previously inspected.
export const cworksTranslationPageReviews = pgTable('cworks_translation_page_reviews', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  revisionCount: integer('revision_count').notNull(),
  pageNumber: integer('page_number').notNull(),
  checked: boolean('checked').notNull().default(false),
  resolvedFindingIndexes: jsonb('resolved_finding_indexes').notNull(),
  notes: text('notes'),
  reviewerSessionId: text('reviewer_session_id'),
  checkedAt: timestamp('checked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('cworks_translation_page_reviews_revision_page_uq').on(
    t.jobId,
    t.revisionCount,
    t.pageNumber,
  ),
  index('cworks_translation_page_reviews_job_revision_idx').on(t.jobId, t.revisionCount),
]);

// Append-only human review decisions. The job row stores only current state;
// this event stream preserves reviewer identity, declaration, and the exact
// page checklist that authorized (or rejected) each revision.
export const cworksTranslationReviewEvents = pgTable('cworks_translation_review_events', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  revisionCount: integer('revision_count').notNull(),
  decision: varchar('decision', { length: 24 }).notNull(),
  reviewerName: text('reviewer_name').notNull(),
  reviewerQualification: text('reviewer_qualification').notNull(),
  reviewerUserId: varchar('reviewer_user_id').references(() => users.id),
  reviewerRole: varchar('reviewer_role', { length: 32 }),
  reviewerSessionId: text('reviewer_session_id'),
  declaration: text('declaration').notNull(),
  cadOperatorName: text('cad_operator_name'),
  cadOperatorQualification: text('cad_operator_qualification'),
  cadOperatorAttestation: text('cad_operator_attestation'),
  sourceSha256: text('source_sha256'),
  translatedOutputSha256: text('translated_output_sha256'),
  preservationReportSha256: text('preservation_report_sha256'),
  ledgerSha256: text('ledger_sha256'),
  // Derivative decisions are separate append-only review events. This is
  // intentionally not the parent revision approval foreign key.
  derivativeId: text('derivative_id'),
  derivativeEvidenceSnapshot: jsonb('derivative_evidence_snapshot'),
  pageReviewSnapshot: jsonb('page_review_snapshot').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('cworks_translation_review_events_job_revision_idx').on(t.jobId, t.revisionCount),
  index('cworks_translation_review_events_derivative_idx').on(t.jobId, t.derivativeId),
]);

export const cworksTranslationCadDerivatives = pgTable('cworks_translation_cad_derivatives', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  sourceRevision: integer('source_revision').notNull(),
  sourceOutputSha256: text('source_output_sha256').notNull(),
  sourceApprovalEventId: integer('source_approval_event_id')
    .references(() => cworksTranslationReviewEvents.id, { onDelete: 'cascade' }),
  lineageKind: varchar('lineage_kind', { length: 32 }).notNull().default('approved_source_touchup'),
  evidence: jsonb('evidence').notNull().default({}),
  originalFilename: text('original_filename').notNull(),
  format: varchar('format', { length: 8 }).notNull(),
  storedName: text('stored_name').notNull().unique(),
  sha256: text('sha256').notNull(),
  operatorName: text('operator_name').notNull(),
  operatorQualification: text('operator_qualification').notNull(),
  operatorUserId: varchar('operator_user_id').references(() => users.id),
  operatorNotes: text('operator_notes').notNull(),
  operatorAttestation: text('operator_attestation').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('cworks_translation_cad_derivatives_job_created_idx').on(t.jobId, t.createdAt),
  index('cworks_translation_cad_derivatives_source_revision_idx').on(t.jobId, t.sourceRevision),
]);
export const cworksTranslationTouchups = pgTable('cworks_translation_touchups', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => cworksTranslationJobs.id, { onDelete: 'cascade' }),
  sourceRevision: integer('source_revision').notNull(),
  committedRevision: integer('committed_revision'),
  pageNumber: integer('page_number').notNull(),
  blockId: text('block_id').notNull(),
  sourceText: text('source_text').notNull(),
  beforeTranslation: text('before_translation').notNull(),
  afterTranslation: text('after_translation').notNull(),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('previewed'),
  reviewerSessionId: text('reviewer_session_id').notNull(),
  previewStoredName: text('preview_stored_name'),
  previewWarnings: jsonb('preview_warnings').notNull(),
  renderFingerprint: text('render_fingerprint').notNull(),
  renderLayoutVersion: integer('render_layout_version').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  committedAt: timestamp('committed_at'),
}, (t) => [
  index('cworks_translation_touchups_job_revision_idx').on(t.jobId, t.sourceRevision),
]);

// Durable private-object cleanup queue. Rows deliberately do not reference the
// job table so cleanup survives job deletion and process restarts.
export const cworksTranslationCleanup = pgTable('cworks_translation_cleanup', {
  id: serial('id').primaryKey(),
  storedName: text('stored_name').notNull().unique(),
  jobId: text('job_id'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
