export type ReviewStatus = "unmarked" | "correct" | "partially_correct" | "incorrect";

export type RecordStatus = "completed" | "partial_failure" | "empty" | "failed";

export interface DocumentMeta {
  title?: string;
  circular_number?: string;
  regulator?: string;
  regulator_department?: string;
  circular_issue_date?: string;
  addressed_instiute?: string;
  circular_type?: string;
  referenced_documents?: string;
  [extraField: string]: unknown;
}

export interface ChapterContext {
  chapter_number?: string | number;
  chapter_name?: string;
  from_page?: string | number;
  to_page?: string | number;
}

export interface DepartmentPrediction {
  department_id: number;
  department_name: string;
  score: number;
}

export interface AuditablePoint {
  auditable_point_text?: string;
  reason?: string;
  penalty?: string;
  deadline?: string;
  score_of_acceptance?: number;
  system_derived_data?: Record<string, unknown>;
  department?: unknown[];
  department_top2?: DepartmentPrediction[];
  [extraField: string]: unknown;
}

export interface ChapterAuditableResult extends ChapterContext {
  auditable_points: AuditablePoint[];
  non_auditable: unknown[];
  error?: string;
}

export interface AuditableReviewRow {
  id: string;
  source: ChapterContext;
  auditable: AuditablePoint;
  reviewStatus: ReviewStatus;
  penaltyReviewStatus: ReviewStatus;
  deadlineReviewStatus: ReviewStatus;
  systemReviewStatus: ReviewStatus;
  remark: string;
  reviewUpdatedAt: string | null;
}

export interface HistoryRecord {
  id: string;
  originalFilename: string;
  storedFilename: string;
  pdfPath: string;
  uploadedAt: string;
  fileSize: number;
  apiBaseUrl: string;
  status: RecordStatus;
  error: string;
  documentMeta: DocumentMeta;
  chapterResults: ChapterAuditableResult[];
  auditables: AuditableReviewRow[];
}

export interface UploadProgressEvent {
  phase: string;
  message: string;
  done: number;
  total: number;
  chapter?: ChapterContext;
}

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface UploadDiagnosticEvent {
  timestamp: string;
  level: DiagnosticLevel;
  event: string;
  message: string;
  requestId?: string;
  recordId?: string;
  chapter?: ChapterContext;
  details?: Record<string, string | number | boolean | null>;
}
