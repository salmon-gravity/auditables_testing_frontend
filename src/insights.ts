import type { AuditableReviewRow, HistoryRecord, ReviewStatus } from "./types";

export interface AccuracyCounts {
  total: number;
  reviewed: number;
  unmarked: number;
  correct: number;
  partial: number;
  incorrect: number;
  weightedScore: number;
  accuracy: number | null;
  coverage: number | null;
}

export interface FieldAccuracySet {
  auditable: AccuracyCounts;
  penalty: AccuracyCounts;
  deadline: AccuracyCounts;
  combined: AccuracyCounts;
}

export interface PdfInsight {
  id: string;
  title: string;
  uploadedAt: string;
  status: string;
  failedChapters: number;
  counts: AccuracyCounts;
  fieldCounts: FieldAccuracySet;
  hasLowAccuracy: boolean;
  hasLowCoverage: boolean;
}

export interface DepartmentInsight {
  department: string;
  counts: AccuracyCounts;
  fieldCounts: FieldAccuracySet;
}

export interface HistoryInsights {
  recordCount: number;
  pdfsWithExtractionIssues: number;
  totals: AccuracyCounts;
  fieldTotals: FieldAccuracySet;
  averageScore: number | null;
  scoredRows: number;
  highConfidenceIncorrect: number;
  lowConfidenceCorrect: number;
  perPdf: PdfInsight[];
  departments: DepartmentInsight[];
}

const reviewWeights: Record<ReviewStatus, number | null> = {
  unmarked: null,
  correct: 1,
  partially_correct: 0.5,
  incorrect: 0
};

export function computeHistoryInsights(records: HistoryRecord[]): HistoryInsights {
  const allRows = records.flatMap((record) => record.auditables);
  const scores = allRows
    .map((row) => row.auditable.score_of_acceptance)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));

  const perPdf = records.map((record) => {
    const fieldCounts = computeFieldAccuracySet(record.auditables);
    const failedChapters = record.chapterResults.filter((chapter) => chapter.error).length;

    return {
      id: record.id,
      title: record.documentMeta.title || record.originalFilename,
      uploadedAt: record.uploadedAt,
      status: record.status,
      failedChapters,
      counts: fieldCounts.auditable,
      fieldCounts,
      hasLowAccuracy: fieldCounts.combined.accuracy !== null && fieldCounts.combined.accuracy < 0.7,
      hasLowCoverage: fieldCounts.combined.total > 0 && (fieldCounts.combined.coverage ?? 0) < 0.5
    };
  });

  return {
    recordCount: records.length,
    pdfsWithExtractionIssues: records.filter(
      (record) => record.status === "partial_failure" || record.status === "failed" || record.chapterResults.some((chapter) => chapter.error)
    ).length,
    totals: computeAccuracyCounts(allRows, (row) => row.reviewStatus),
    fieldTotals: computeFieldAccuracySet(allRows),
    averageScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    scoredRows: scores.length,
    highConfidenceIncorrect: allRows.filter(
      (row) => normalizeReviewStatus(row.reviewStatus) === "incorrect" && typeof row.auditable.score_of_acceptance === "number" && row.auditable.score_of_acceptance >= 0.8
    ).length,
    lowConfidenceCorrect: allRows.filter(
      (row) => normalizeReviewStatus(row.reviewStatus) === "correct" && typeof row.auditable.score_of_acceptance === "number" && row.auditable.score_of_acceptance < 0.5
    ).length,
    perPdf,
    departments: computeDepartmentInsights(allRows)
  };
}

function computeFieldAccuracySet(rows: AuditableReviewRow[]): FieldAccuracySet {
  return {
    auditable: computeAccuracyCounts(rows, (row) => row.reviewStatus),
    penalty: computeAccuracyCounts(rows, (row) => row.penaltyReviewStatus),
    deadline: computeAccuracyCounts(rows, (row) => row.deadlineReviewStatus),
    combined: computeCombinedAccuracyCounts(rows)
  };
}

function computeCombinedAccuracyCounts(rows: AuditableReviewRow[]): AccuracyCounts {
  return computeAccuracyCountsFromStatuses(
    rows.flatMap((row) => [row.reviewStatus, row.penaltyReviewStatus, row.deadlineReviewStatus])
  );
}

function computeAccuracyCounts(rows: AuditableReviewRow[], getStatus: (row: AuditableReviewRow) => ReviewStatus | undefined): AccuracyCounts {
  return computeAccuracyCountsFromStatuses(rows.map((row) => getStatus(row)));
}

function computeAccuracyCountsFromStatuses(statuses: Array<ReviewStatus | undefined>): AccuracyCounts {
  const counts = statuses.reduce(
    (current, rawStatus) => {
      const status = normalizeReviewStatus(rawStatus);
      if (status === "correct") {
        current.correct += 1;
      } else if (status === "partially_correct") {
        current.partial += 1;
      } else if (status === "incorrect") {
        current.incorrect += 1;
      } else {
        current.unmarked += 1;
      }

      const weight = reviewWeights[status];
      if (weight !== null) {
        current.reviewed += 1;
        current.weightedScore += weight;
      }

      return current;
    },
    {
      total: statuses.length,
      reviewed: 0,
      unmarked: 0,
      correct: 0,
      partial: 0,
      incorrect: 0,
      weightedScore: 0,
      accuracy: null,
      coverage: null
    } satisfies AccuracyCounts
  );

  return {
    ...counts,
    accuracy: counts.reviewed ? counts.weightedScore / counts.reviewed : null,
    coverage: counts.total ? counts.reviewed / counts.total : null
  };
}

function computeDepartmentInsights(rows: AuditableReviewRow[]): DepartmentInsight[] {
  const groups = new Map<string, AuditableReviewRow[]>();

  for (const row of rows) {
    const department = getPrimaryDepartment(row);
    if (!department) {
      continue;
    }

    groups.set(department, [...(groups.get(department) || []), row]);
  }

  return Array.from(groups.entries())
    .map(([department, departmentRows]) => {
      const fieldCounts = computeFieldAccuracySet(departmentRows);
      return {
        department,
        counts: fieldCounts.auditable,
        fieldCounts
      };
    })
    .sort((first, second) => {
      const reviewedDelta = second.fieldCounts.combined.reviewed - first.fieldCounts.combined.reviewed;
      if (reviewedDelta !== 0) {
        return reviewedDelta;
      }
      return second.fieldCounts.combined.total - first.fieldCounts.combined.total;
    });
}

function getPrimaryDepartment(row: AuditableReviewRow): string {
  const topDepartment = row.auditable.department_top2?.[0];
  if (topDepartment?.department_name) {
    return topDepartment.department_name;
  }

  const departmentId = row.auditable.department?.[0];
  if (departmentId !== undefined && departmentId !== null && departmentId !== "") {
    return `Department ${String(departmentId)}`;
  }

  return "";
}

function normalizeReviewStatus(status: ReviewStatus | undefined): ReviewStatus {
  if (status === "correct" || status === "partially_correct" || status === "incorrect") {
    return status;
  }
  return "unmarked";
}
