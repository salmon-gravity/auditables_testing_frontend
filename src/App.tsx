import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Circle,
  ClipboardList,
  FileText,
  History,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { deleteHistory, fetchHistory, updateAuditableReview, uploadPdf } from "./api";
import { computeHistoryInsights } from "./insights";
import type { DepartmentInsight, HistoryInsights, PdfInsight } from "./insights";
import type { AuditableReviewRow, HistoryRecord, ReviewStatus, UploadDiagnosticEvent } from "./types";

const defaultApiBaseUrl = "http://dev.gravity.ind.in:8001";
const largePdfWarningSize = 100 * 1024 * 1024;
const statusLabels: Record<ReviewStatus, string> = {
  unmarked: "Unmarked",
  correct: "Correct",
  partially_correct: "Partial",
  incorrect: "Incorrect"
};

type QueueStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

interface QueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: QueueStatus;
  message: string;
  done: number;
  total: number;
  error: string;
  recordId: string;
  requestId: string;
  diagnostics: UploadDiagnosticEvent[];
}

type ReviewPatch = Partial<Pick<AuditableReviewRow, "reviewStatus" | "penaltyReviewStatus" | "deadlineReviewStatus" | "remark">>;
type AppPage = "review" | "insights";

export default function App() {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [activePage, setActivePage] = useState<AppPage>(() => getPageFromPath(window.location.pathname));
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedAuditableId, setSelectedAuditableId] = useState<string>("");
  const [apiBaseUrl, setApiBaseUrl] = useState(() => localStorage.getItem("apiBaseUrl") || defaultApiBaseUrl);
  const [historyError, setHistoryError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [query, setQuery] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queueItemsRef = useRef<QueueItem[]>([]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedId) || records[0] || null,
    [records, selectedId]
  );
  const insights = useMemo(() => computeHistoryInsights(records), [records]);
  const queueStats = useMemo(() => computeQueueStats(queueItems), [queueItems]);
  const hasActiveQueueItem = queueItems.some((item) => item.status === "processing");
  const canStartQueue = queueItems.some((item) => item.status === "queued") && !isQueueRunning;
  const canClearCompleted = queueItems.some((item) =>
    item.status === "completed" || item.status === "failed" || item.status === "cancelled"
  );

  const filteredAuditables = useMemo(() => {
    const auditables = selectedRecord?.auditables || [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return auditables;
    }

    return auditables.filter((row) => {
      const searchable = [
        row.auditable.auditable_point_text,
        row.auditable.reason,
        row.auditable.penalty,
        row.auditable.deadline,
        row.source.chapter_name,
        row.remark,
        row.reviewStatus,
        getDepartmentLabel(row)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalized);
    });
  }, [query, selectedRecord]);

  const selectedAuditable = useMemo(
    () => filteredAuditables.find((row) => row.id === selectedAuditableId) || filteredAuditables[0] || null,
    [filteredAuditables, selectedAuditableId]
  );

  useEffect(() => {
    localStorage.setItem("apiBaseUrl", apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    queueItemsRef.current = queueItems;
  }, [queueItems]);

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    function handlePopState() {
      setActivePage(getPageFromPath(window.location.pathname));
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedRecord) {
      setSelectedAuditableId("");
      return;
    }

    if (!selectedRecord.auditables.some((row) => row.id === selectedAuditableId)) {
      setSelectedAuditableId(selectedRecord.auditables[0]?.id || "");
    }
  }, [selectedRecord, selectedAuditableId]);

  useEffect(() => {
    if (!filteredAuditables.length) {
      setSelectedAuditableId("");
      return;
    }

    if (!filteredAuditables.some((row) => row.id === selectedAuditableId)) {
      setSelectedAuditableId(filteredAuditables[0].id);
    }
  }, [filteredAuditables, selectedAuditableId]);

  async function loadHistory() {
    setHistoryError("");
    try {
      const nextRecords = await fetchHistory();
      setRecords(nextRecords);
      setSelectedId((current) => current || nextRecords[0]?.id || "");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleAddFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) {
      setUploadError("Choose one or more PDFs before adding to the queue.");
      return;
    }

    const invalidFile = files.find((file) => !isPdfFile(file));
    if (invalidFile) {
      setUploadError(`Only PDF files can be queued. Remove "${invalidFile.name}" and try again.`);
      return;
    }

    setUploadError("");
    setQueueItems((current) => {
      const next = [...current, ...files.map(createQueueItem)];
      queueItemsRef.current = next;
      return next;
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function startQueue() {
    if (isQueueRunning) {
      return;
    }

    setIsQueueRunning(true);
    setUploadError("");

    try {
      while (true) {
        const item = queueItemsRef.current.find((candidate) => candidate.status === "queued");
        if (!item) {
          break;
        }

        updateQueueItem(item.id, {
          status: "processing",
          message: "Uploading PDF",
          done: 0,
          total: 0,
          error: "",
          requestId: "",
          diagnostics: []
        });

        try {
          const record = await uploadPdf(item.file, apiBaseUrl, (event) => {
            updateQueueItem(item.id, {
              status: "processing",
              message: event.message || event.phase,
              done: event.done,
              total: event.total
            });
          }, (event) => appendQueueDiagnostic(item.id, event));

          updateQueueItem(item.id, {
            status: "completed",
            message: "Completed",
            recordId: record.id,
            error: ""
          });
          setRecords((current) => [record, ...current.filter((existing) => existing.id !== record.id)]);
          setSelectedId(record.id);
          setSelectedAuditableId(record.auditables[0]?.id || "");
          setQuery("");
        } catch (error) {
          const requestId = getErrorRequestId(error);
          updateQueueItem(item.id, {
            status: "failed",
            message: "Failed",
            error: error instanceof Error ? error.message : String(error),
            requestId: requestId || queueItemsRef.current.find((current) => current.id === item.id)?.requestId || ""
          });
        }
      }
    } finally {
      setIsQueueRunning(false);
    }
  }

  function updateQueueItem(itemId: string, patch: Partial<QueueItem>) {
    const next = queueItemsRef.current.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
    queueItemsRef.current = next;
    setQueueItems(next);
  }

  function appendQueueDiagnostic(itemId: string, event: UploadDiagnosticEvent) {
    const next = queueItemsRef.current.map((item) => {
      if (item.id !== itemId) {
        return item;
      }

      return {
        ...item,
        requestId: item.requestId || event.requestId || "",
        diagnostics: [...item.diagnostics, event].slice(-40)
      };
    });
    queueItemsRef.current = next;
    setQueueItems(next);
  }

  function cancelQueuedItem(itemId: string) {
    updateQueueItem(itemId, {
      status: "cancelled",
      message: "Cancelled",
      done: 0,
      total: 0,
      error: ""
    });
  }

  function clearCompletedQueueItems() {
    setQueueItems((current) => {
      const next = current.filter((item) => item.status === "queued" || item.status === "processing");
      queueItemsRef.current = next;
      return next;
    });
  }

  async function handleReviewChange(row: AuditableReviewRow, patch: ReviewPatch) {
    if (!selectedRecord) {
      return;
    }

    const optimisticRecord = replaceAuditable(selectedRecord, row.id, {
      ...patch,
      reviewUpdatedAt: new Date().toISOString()
    });
    replaceRecord(optimisticRecord);

    try {
      const savedRecord = await updateAuditableReview(selectedRecord.id, row.id, patch);
      replaceRecord(savedRecord);
    } catch (error) {
      replaceRecord(selectedRecord);
      setUploadError(error instanceof Error ? error.message : String(error));
    }
  }

  function replaceRecord(record: HistoryRecord) {
    setRecords((current) => current.map((item) => (item.id === record.id ? record : item)));
  }

  function selectRecord(recordId: string) {
    setSelectedId(recordId);
    setSelectedAuditableId("");
    setQuery("");
    if (activePage !== "review") {
      navigate("review");
    }
  }

  function navigate(page: AppPage) {
    const path = page === "review" ? "/review" : "/insights";
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setActivePage(page);
  }

  async function handleDeleteAll(password: string) {
    await deleteHistory(password);
    setRecords([]);
    setSelectedId("");
    setSelectedAuditableId("");
    setQuery("");
    setDeleteOpen(false);
  }

  return (
    <div className="app-shell">
      <aside className="history-panel" aria-label="Upload history">
        <div className="panel-header">
          <div>
            <p className="eyebrow">History</p>
            <h1>Circular Review</h1>
          </div>
          <button className="icon-button" type="button" onClick={() => void loadHistory()} title="Refresh history">
            <RefreshCcw size={18} />
          </button>
        </div>

        {historyError ? <p className="inline-error">{historyError}</p> : null}

        <nav className="side-nav" aria-label="Main navigation">
          <button className={activePage === "review" ? "is-active" : ""} type="button" onClick={() => navigate("review")}>
            <ClipboardList size={16} />
            Review
          </button>
          <button className={activePage === "insights" ? "is-active" : ""} type="button" onClick={() => navigate("insights")}>
            <BarChart3 size={16} />
            Insights
          </button>
        </nav>

        <div className="record-list">
          {records.length ? (
            records.map((record) => (
              <button
                className={`record-item ${selectedRecord?.id === record.id ? "is-active" : ""}`}
                key={record.id}
                type="button"
                onClick={() => selectRecord(record.id)}
              >
                <span className="record-title">{record.documentMeta.title || record.originalFilename}</span>
                <span className="record-meta">
                  {formatDate(record.uploadedAt)} - {record.auditables.length} auditables
                </span>
                <span className={`status-pill ${record.status}`}>{formatRecordStatus(record.status)}</span>
              </button>
            ))
          ) : (
            <div className="empty-history">
              <History size={28} />
              <span>No uploads yet</span>
            </div>
          )}
        </div>

        <button className="danger-button" type="button" onClick={() => setDeleteOpen(true)} disabled={!records.length}>
          <Trash2 size={16} />
          Delete history
        </button>
      </aside>

      {activePage === "review" ? (
        <main className="workspace">
          <ReviewPage
            apiBaseUrl={apiBaseUrl}
            canClearCompleted={canClearCompleted}
            canStartQueue={canStartQueue}
            fileInputRef={fileInputRef}
            filteredAuditables={filteredAuditables}
            hasActiveQueueItem={hasActiveQueueItem}
            isQueueRunning={isQueueRunning}
            queueItems={queueItems}
            queueStats={queueStats}
            query={query}
            selectedAuditable={selectedAuditable}
            selectedRecord={selectedRecord}
            uploadError={uploadError}
            onAddFiles={handleAddFiles}
            onApiBaseUrlChange={setApiBaseUrl}
            onCancelQueuedItem={cancelQueuedItem}
            onClearCompletedQueueItems={clearCompletedQueueItems}
            onQueryChange={setQuery}
            onReviewChange={handleReviewChange}
            onSelectAuditable={setSelectedAuditableId}
            onStartQueue={startQueue}
          />
        </main>
      ) : (
        <main className="workspace">
          <InsightsPage insights={insights} />
        </main>
      )}

      {deleteOpen ? (
        <DeleteDialog onCancel={() => setDeleteOpen(false)} onConfirm={(password) => handleDeleteAll(password)} />
      ) : null}
    </div>
  );
}

function QueuePanel({
  items,
  stats,
  onCancelItem
}: {
  items: QueueItem[];
  stats: ReturnType<typeof computeQueueStats>;
  onCancelItem: (itemId: string) => void;
}) {
  if (!items.length) {
    return null;
  }

  return (
    <section className="queue-panel" aria-label="Upload queue">
      <div className="queue-header">
        <div>
          <p className="eyebrow">Processing queue</p>
          <h2>{stats.total} PDFs selected</h2>
        </div>
        <div className="queue-stats" aria-label="Queue summary">
          <span>{stats.queued} queued</span>
          <span>{stats.processing} processing</span>
          <span>{stats.completed} completed</span>
          <span>{stats.failed} failed</span>
        </div>
      </div>

      <div className="queue-list">
        {items.map((item) => (
          <div className={`queue-row ${item.status}`} key={item.id}>
            <div className="queue-row-main">
              <div>
                <strong>{item.name}</strong>
                <span>
                  {formatFileSize(item.size)}
                  {isLargePdf(item.size) ? <em className="large-pdf-warning">Large PDF</em> : null}
                </span>
              </div>
              <span className={`queue-status ${item.status}`}>{formatQueueStatus(item.status)}</span>
            </div>

            <div className="queue-row-progress">
              <div className="queue-progress-copy">
                <span>{item.message}</span>
                <span>{formatQueueProgress(item)}</span>
              </div>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${getQueueProgressPercent(item)}%` }} />
              </div>
            </div>

            {item.error ? (
              <div className="queue-error">
                <AlertTriangle size={15} />
                <span>{item.error}</span>
                {item.requestId ? <code>Request ID: {item.requestId}</code> : null}
              </div>
            ) : null}

            <QueueDiagnostics events={item.diagnostics} />

            {item.status === "queued" ? (
              <button className="ghost-button queue-cancel" type="button" onClick={() => onCancelItem(item.id)}>
                Cancel
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function QueueDiagnostics({ events }: { events: UploadDiagnosticEvent[] }) {
  const recentEvents = events.slice(-12);

  if (!recentEvents.length) {
    return null;
  }

  return (
    <details className="queue-diagnostics">
      <summary>Diagnostics ({events.length})</summary>
      <div className="diagnostic-list">
        {recentEvents.map((event, index) => (
          <div className={`diagnostic-row ${event.level}`} key={`${event.timestamp}-${event.event}-${index}`}>
            <div className="diagnostic-row-head">
              <span>{formatDiagnosticTime(event.timestamp)}</span>
              <span className={`diagnostic-level ${event.level}`}>{event.level}</span>
              <strong>{event.message}</strong>
            </div>
            <div className="diagnostic-row-meta">
              <span>{event.event}</span>
              {event.chapter ? <span>{formatDiagnosticChapter(event.chapter)}</span> : null}
              {event.requestId ? <code>{event.requestId}</code> : null}
              {event.recordId ? <code>{event.recordId}</code> : null}
            </div>
            {event.details && Object.keys(event.details).length ? (
              <div className="diagnostic-details">
                {Object.entries(event.details).slice(0, 8).map(([key, value]) => (
                  <span key={key}>
                    {key}: {formatDiagnosticValue(value)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function ReviewPage({
  apiBaseUrl,
  canClearCompleted,
  canStartQueue,
  fileInputRef,
  filteredAuditables,
  hasActiveQueueItem,
  isQueueRunning,
  queueItems,
  queueStats,
  query,
  selectedAuditable,
  selectedRecord,
  uploadError,
  onAddFiles,
  onApiBaseUrlChange,
  onCancelQueuedItem,
  onClearCompletedQueueItems,
  onQueryChange,
  onReviewChange,
  onSelectAuditable,
  onStartQueue
}: {
  apiBaseUrl: string;
  canClearCompleted: boolean;
  canStartQueue: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  filteredAuditables: AuditableReviewRow[];
  hasActiveQueueItem: boolean;
  isQueueRunning: boolean;
  queueItems: QueueItem[];
  queueStats: ReturnType<typeof computeQueueStats>;
  query: string;
  selectedAuditable: AuditableReviewRow | null;
  selectedRecord: HistoryRecord | null;
  uploadError: string;
  onAddFiles: (event: FormEvent<HTMLFormElement>) => void;
  onApiBaseUrlChange: (value: string) => void;
  onCancelQueuedItem: (itemId: string) => void;
  onClearCompletedQueueItems: () => void;
  onQueryChange: (value: string) => void;
  onReviewChange: (row: AuditableReviewRow, patch: ReviewPatch) => Promise<void>;
  onSelectAuditable: (id: string) => void;
  onStartQueue: () => Promise<void>;
}) {
  return (
    <>
      <section className="toolbar" aria-label="Upload controls">
        <form className="upload-form" onSubmit={onAddFiles}>
          <label className="file-picker">
            <FileText size={18} />
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" multiple />
          </label>
          <button className="secondary-button" type="submit">
            <Upload size={17} />
            Add PDFs
          </button>
          <button className="primary-button" type="button" disabled={!canStartQueue} onClick={() => void onStartQueue()}>
            {isQueueRunning ? <Loader2 className="spin" size={17} /> : <Upload size={17} />}
            Start queue
          </button>
          <button className="ghost-button" type="button" disabled={!canClearCompleted} onClick={onClearCompletedQueueItems}>
            Clear completed
          </button>
        </form>

        <label className="api-control">
          <span>API base URL</span>
          <input
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            disabled={hasActiveQueueItem || isQueueRunning}
          />
        </label>
      </section>

      {uploadError ? (
        <section className="run-state" aria-live="polite">
          <div className="state-error">
            <AlertTriangle size={18} />
            {uploadError}
          </div>
        </section>
      ) : null}

      <QueuePanel items={queueItems} stats={queueStats} onCancelItem={onCancelQueuedItem} />

      {selectedRecord ? (
        <>
          <RecordSummary record={selectedRecord} />

          <ReviewWorkspace
            query={query}
            rows={filteredAuditables}
            selectedRow={selectedAuditable}
            totalRows={selectedRecord.auditables.length}
            onQueryChange={onQueryChange}
            onSelectRow={onSelectAuditable}
            onReviewChange={onReviewChange}
          />

          <FailedChapters record={selectedRecord} />
        </>
      ) : (
        <section className="blank-workspace">
          <Upload size={36} />
          <h2>Upload a circular PDF to start a review</h2>
        </section>
      )}
    </>
  );
}

function InsightsPage({ insights }: { insights: HistoryInsights }) {
  return (
    <section className="insights-page" aria-label="Insights page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Insights</p>
          <h2>Extraction quality dashboard</h2>
        </div>
        <BarChart3 size={24} />
      </div>
      <InsightsSection insights={insights} />
    </section>
  );
}

function RecordSummary({ record }: { record: HistoryRecord }) {
  const reviewed = record.auditables.filter((row) => row.reviewStatus !== "unmarked").length;
  const failedChapters = record.chapterResults.filter((chapter) => chapter.error).length;

  return (
    <section className="summary-strip" aria-label="Selected PDF summary">
      <div className="summary-title">
        <p className="eyebrow">Selected PDF</p>
        <h2>{record.documentMeta.title || record.originalFilename}</h2>
        <div className="summary-tags">
          <span>{record.documentMeta.circular_number || "No circular number"}</span>
          <span>{record.documentMeta.regulator || "No regulator"}</span>
          <span>{record.documentMeta.circular_issue_date || "No issue date"}</span>
        </div>
      </div>
      <div className="summary-actions">
        <Metric label="Auditables" value={record.auditables.length} />
        <Metric label="Marked" value={reviewed} />
        <Metric label="Failed" value={failedChapters} />
        <a className="pdf-link" href={record.pdfPath} target="_blank" rel="noreferrer">
          <FileText size={16} />
          Open PDF
        </a>
      </div>
    </section>
  );
}

function InsightsSection({ insights }: { insights: HistoryInsights }) {
  if (!insights.recordCount) {
    return (
      <section className="insights-section is-light" aria-label="Accuracy insights">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Insights</p>
            <h2>Accuracy overview</h2>
          </div>
          <BarChart3 size={20} />
        </div>
        <div className="empty-insights">
          <Circle size={24} />
          <span>Upload and mark auditables to see accuracy trends across PDFs.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="insights-section is-light" aria-label="Accuracy insights">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Insights</p>
          <h2>Accuracy overview</h2>
        </div>
        <BarChart3 size={20} />
      </div>

      <div className="insight-grid">
        <InsightMetric label="PDFs" value={insights.recordCount} />
        <InsightMetric label="Auditables" value={insights.totals.total} />
        <InsightMetric label="Fields reviewed" value={insights.fieldTotals.combined.reviewed} />
        <InsightMetric label="Fields unmarked" value={insights.fieldTotals.combined.unmarked} />
        <InsightMetric label="Field accuracy" value={formatPercent(insights.fieldTotals.combined.accuracy, "Not enough")} emphasis />
        <InsightMetric label="Field coverage" value={formatPercent(insights.fieldTotals.combined.coverage, "No rows")} />
        <InsightMetric label="Auditable acc" value={formatPercent(insights.fieldTotals.auditable.accuracy, "Not enough")} />
        <InsightMetric label="Penalty acc" value={formatPercent(insights.fieldTotals.penalty.accuracy, "Not enough")} />
        <InsightMetric label="Deadline acc" value={formatPercent(insights.fieldTotals.deadline.accuracy, "Not enough")} />
        <InsightMetric label="Incorrect fields" value={insights.fieldTotals.combined.incorrect} />
        <InsightMetric label="Issue PDFs" value={insights.pdfsWithExtractionIssues} />
      </div>

      <div className="attention-row">
        <InsightNote label="Avg confidence" value={formatPercent(insights.averageScore, "No scores")} />
        <InsightNote label="High confidence but incorrect" value={insights.highConfidenceIncorrect} />
        <InsightNote label="Low confidence but correct" value={insights.lowConfidenceCorrect} />
      </div>

      <div className="insight-tables">
        <PdfInsightsTable rows={insights.perPdf} />
        <DepartmentInsightsTable rows={insights.departments} />
      </div>
    </section>
  );
}

function InsightMetric({ label, value, emphasis = false }: { label: string; value: string | number; emphasis?: boolean }) {
  return (
    <div className={`insight-card ${emphasis ? "is-emphasis" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InsightNote({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="insight-note">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PdfInsightsTable({ rows }: { rows: PdfInsight[] }) {
  return (
    <div className="insight-table-card">
      <h3>Per PDF accuracy</h3>
      <div className="compact-table-wrap">
        <table className="compact-table">
          <thead>
            <tr>
              <th>PDF</th>
              <th>Uploaded</th>
              <th>Total</th>
              <th>Reviewed</th>
              <th>Coverage</th>
              <th>Field acc</th>
              <th>Auditable</th>
              <th>Penalty</th>
              <th>Deadline</th>
              <th>Failed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={row.hasLowAccuracy || row.hasLowCoverage ? "needs-review" : ""} key={row.id}>
                <td>{row.title}</td>
                <td>{formatDate(row.uploadedAt)}</td>
                <td>{row.counts.total}</td>
                <td>{row.fieldCounts.combined.reviewed}</td>
                <td>{formatPercent(row.fieldCounts.combined.coverage, "No rows")}</td>
                <td>{formatPercent(row.fieldCounts.combined.accuracy, "Not enough")}</td>
                <td>{formatPercent(row.fieldCounts.auditable.accuracy, "Not enough")}</td>
                <td>{formatPercent(row.fieldCounts.penalty.accuracy, "Not enough")}</td>
                <td>{formatPercent(row.fieldCounts.deadline.accuracy, "Not enough")}</td>
                <td>{row.failedChapters}</td>
                <td>{formatRecordStatus(row.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DepartmentInsightsTable({ rows }: { rows: DepartmentInsight[] }) {
  return (
    <div className="insight-table-card">
      <h3>Department accuracy</h3>
      {rows.length ? (
        <div className="compact-table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Total</th>
                <th>Reviewed</th>
                <th>Coverage</th>
                <th>Field acc</th>
                <th>Auditable</th>
                <th>Penalty</th>
                <th>Deadline</th>
                <th>Incorrect</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.department}>
                  <td>{row.department}</td>
                  <td>{row.counts.total}</td>
                  <td>{row.fieldCounts.combined.reviewed}</td>
                  <td>{formatPercent(row.fieldCounts.combined.coverage, "No rows")}</td>
                  <td>{formatPercent(row.fieldCounts.combined.accuracy, "Not enough")}</td>
                  <td>{formatPercent(row.fieldCounts.auditable.accuracy, "Not enough")}</td>
                  <td>{formatPercent(row.fieldCounts.penalty.accuracy, "Not enough")}</td>
                  <td>{formatPercent(row.fieldCounts.deadline.accuracy, "Not enough")}</td>
                  <td>{row.fieldCounts.combined.incorrect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-insights compact">
          <Circle size={22} />
          <span>No department data found in extracted auditables.</span>
        </div>
      )}
    </div>
  );
}

function ReviewWorkspace({
  query,
  rows,
  selectedRow,
  totalRows,
  onQueryChange,
  onSelectRow,
  onReviewChange
}: {
  query: string;
  rows: AuditableReviewRow[];
  selectedRow: AuditableReviewRow | null;
  totalRows: number;
  onQueryChange: (value: string) => void;
  onSelectRow: (id: string) => void;
  onReviewChange: (
    row: AuditableReviewRow,
    patch: ReviewPatch
  ) => Promise<void>;
}) {
  return (
    <section className="review-section" aria-label="Auditable review">
      <div className="review-toolbar">
        <div>
          <p className="eyebrow">Auditables</p>
          <h2>
            {rows.length} of {totalRows} rows
          </h2>
        </div>
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search text, source, department, marking"
          />
        </label>
      </div>

      <div className="review-split">
        <AuditableList rows={rows} selectedId={selectedRow?.id || ""} onSelectRow={onSelectRow} />
        <AuditableDetail row={selectedRow} onReviewChange={onReviewChange} />
      </div>
    </section>
  );
}

function AuditableList({
  rows,
  selectedId,
  onSelectRow
}: {
  rows: AuditableReviewRow[];
  selectedId: string;
  onSelectRow: (id: string) => void;
}) {
  if (!rows.length) {
    return (
      <div className="review-list empty-table">
        <Circle size={26} />
        <span>No auditables found for this selection</span>
      </div>
    );
  }

  return (
    <div className="review-list" aria-label="Auditable list">
      {rows.map((row, index) => (
        <button
          aria-pressed={selectedId === row.id}
          className={`review-list-row ${selectedId === row.id ? "is-selected" : ""} ${row.reviewStatus}`}
          key={row.id}
          type="button"
          onClick={() => onSelectRow(row.id)}
        >
          <span className={`review-dot ${row.reviewStatus}`} aria-hidden="true" />
          <span className="review-row-body">
            <span className="review-row-topline">
              <strong>#{index + 1}</strong>
              <StatusBadge status={row.reviewStatus} />
              <span>{formatScore(row.auditable.score_of_acceptance)}</span>
            </span>
            <span className="review-row-text">{row.auditable.auditable_point_text || "Untitled auditable"}</span>
            <span className="review-row-meta">
              {getChapterLabel(row)} - {getDepartmentLabel(row) || "No department"}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function AuditableDetail({
  row,
  onReviewChange
}: {
  row: AuditableReviewRow | null;
  onReviewChange: (
    row: AuditableReviewRow,
    patch: ReviewPatch
  ) => Promise<void>;
}) {
  const [remark, setRemark] = useState(row?.remark || "");

  useEffect(() => {
    setRemark(row?.remark || "");
  }, [row?.id, row?.remark]);

  if (!row) {
    return (
      <div className="detail-panel empty-detail">
        <ClipboardList size={32} />
        <h2>No auditable selected</h2>
        <p>Select an auditable from the list to inspect details and mark quality.</p>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <div>
          <p className="eyebrow">Review detail</p>
          <h2>{statusLabels[row.reviewStatus]}</h2>
        </div>
        <StatusBadge status={row.reviewStatus} />
      </div>

      <div className="detail-primary">
        <p>{row.auditable.auditable_point_text || "Untitled auditable"}</p>
      </div>

      <div className="primary-review-control">
        <span>Auditable text quality</span>
        <div className="detail-actions" aria-label="Auditable text marking">
          <ReviewButton
            status="correct"
            active={row.reviewStatus === "correct"}
            onClick={() => onReviewChange(row, { reviewStatus: "correct", remark })}
          />
          <ReviewButton
            status="partially_correct"
            active={row.reviewStatus === "partially_correct"}
            onClick={() => onReviewChange(row, { reviewStatus: "partially_correct", remark })}
          />
          <ReviewButton
            status="incorrect"
            active={row.reviewStatus === "incorrect"}
            onClick={() => onReviewChange(row, { reviewStatus: "incorrect", remark })}
          />
        </div>
      </div>

      <div className="detail-grid">
        <DetailField label="Reason" value={row.auditable.reason} wide />
        <DetailField label="Confidence" value={formatScore(row.auditable.score_of_acceptance)} />
        <DetailField label="Source" value={getChapterLabel(row)} />
      </div>

      <div className="field-review-grid">
        <FieldReviewCard
          label="Penalty"
          value={row.auditable.penalty}
          status={row.penaltyReviewStatus}
          onChange={(status) => onReviewChange(row, { penaltyReviewStatus: status, remark })}
        />
        <FieldReviewCard
          label="Deadline"
          value={row.auditable.deadline}
          status={row.deadlineReviewStatus}
          onChange={(status) => onReviewChange(row, { deadlineReviewStatus: status, remark })}
        />
      </div>

      <DepartmentDetails row={row} />

      <label className="remark-editor">
        <span>Remark</span>
        <textarea
          value={remark}
          onChange={(event) => setRemark(event.target.value)}
          onBlur={() => {
            if (remark !== row.remark) {
              void onReviewChange(row, { remark });
            }
          }}
          placeholder="Write remark for this auditable"
          rows={5}
        />
      </label>

      <p className="save-hint">
        Remarks save when the field loses focus. Last updated: {row.reviewUpdatedAt ? formatDate(row.reviewUpdatedAt) : "Not marked yet"}
      </p>
    </div>
  );
}

function DetailField({ label, value, wide = false }: { label: string; value: unknown; wide?: boolean }) {
  return (
    <div className={`detail-field ${wide ? "is-wide" : ""}`}>
      <span>{label}</span>
      <strong>{emptyText(value)}</strong>
    </div>
  );
}

function FieldReviewCard({
  label,
  value,
  status,
  onChange
}: {
  label: string;
  value: unknown;
  status: ReviewStatus;
  onChange: (status: Exclude<ReviewStatus, "unmarked">) => void;
}) {
  return (
    <div className="field-review-card">
      <div className="field-review-head">
        <span>{label}</span>
        <StatusBadge status={status} />
      </div>
      <strong>{emptyText(value)}</strong>
      <div className="mini-marking-control">
        <ReviewButton status="correct" active={status === "correct"} onClick={() => onChange("correct")} />
        <ReviewButton status="partially_correct" active={status === "partially_correct"} onClick={() => onChange("partially_correct")} />
        <ReviewButton status="incorrect" active={status === "incorrect"} onClick={() => onChange("incorrect")} />
      </div>
    </div>
  );
}

function DepartmentDetails({ row }: { row: AuditableReviewRow }) {
  const top2 = row.auditable.department_top2;
  if (Array.isArray(top2) && top2.length) {
    return (
      <div className="department-panel">
        <span>Department predictions</span>
        <div className="department-pills">
          {top2.map((item) => (
            <span className="department-pill" key={`${item.department_id}-${item.department_name}`}>
              {item.department_name} ({formatScore(item.score)})
            </span>
          ))}
        </div>
      </div>
    );
  }

  const department = row.auditable.department;
  if (Array.isArray(department) && department.length) {
    return (
      <div className="department-panel">
        <span>Department ids</span>
        <div className="department-pills">
          {department.map((item, index) => (
            <span className="department-pill" key={`${String(item)}-${index}`}>
              {String(item)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReviewButton({
  status,
  active,
  onClick
}: {
  status: Exclude<ReviewStatus, "unmarked">;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = status === "correct" ? CheckCircle2 : status === "incorrect" ? XCircle : Circle;
  return (
    <button className={`mark-button ${status} ${active ? "is-active" : ""}`} type="button" onClick={onClick} title={statusLabels[status]}>
      <Icon size={16} />
      <span>{statusLabels[status]}</span>
    </button>
  );
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  return <span className={`review-status ${status}`}>{statusLabels[status]}</span>;
}

function FailedChapters({ record }: { record: HistoryRecord }) {
  const failed = record.chapterResults.filter((chapter) => chapter.error);
  if (!failed.length) {
    return null;
  }

  return (
    <section className="failed-section" aria-label="Failed chapters">
      <p className="eyebrow">Failed chapters</p>
      {failed.map((chapter, index) => (
        <div className="failed-row" key={`${chapter.chapter_number || index}-${chapter.chapter_name || "chapter"}`}>
          <AlertTriangle size={16} />
          <span>{chapter.chapter_name || `Chapter ${chapter.chapter_number || index + 1}`}</span>
          <small>{chapter.error}</small>
        </div>
      ))}
    </section>
  );
}

function DeleteDialog({
  onCancel,
  onConfirm
}: {
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={(event) => void submit(event)}>
        <h2>Delete all history</h2>
        <p>This clears all saved PDFs, auditables, markings, and remarks from local storage.</p>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
        />
        {error ? <p className="inline-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="danger-button" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            Delete
          </button>
        </div>
      </form>
    </div>
  );
}

function replaceAuditable(
  record: HistoryRecord,
  auditableId: string,
  patch: ReviewPatch & Pick<AuditableReviewRow, "reviewUpdatedAt">
): HistoryRecord {
  return {
    ...record,
    auditables: record.auditables.map((row) => (row.id === auditableId ? { ...row, ...patch } : row))
  };
}

function getChapterLabel(row: AuditableReviewRow) {
  const chapter = row.source.chapter_name || `Chapter ${row.source.chapter_number || "unknown"}`;
  const fromPage = emptyText(row.source.from_page);
  const toPage = emptyText(row.source.to_page);
  return `${chapter} | Pages ${fromPage}-${toPage}`;
}

function getDepartmentLabel(row: AuditableReviewRow) {
  const topDepartment = row.auditable.department_top2?.[0];
  if (topDepartment?.department_name) {
    return topDepartment.department_name;
  }

  const department = row.auditable.department?.[0];
  if (department !== undefined && department !== null && department !== "") {
    return `Department ${String(department)}`;
  }

  return "";
}

function createQueueItem(file: File): QueueItem {
  return {
    id: createQueueItemId(),
    file,
    name: file.name,
    size: file.size,
    status: "queued",
    message: "Waiting to start",
    done: 0,
    total: 0,
    error: "",
    recordId: "",
    requestId: "",
    diagnostics: []
  };
}

function createQueueItemId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function computeQueueStats(items: QueueItem[]) {
  return {
    total: items.length,
    queued: items.filter((item) => item.status === "queued").length,
    processing: items.filter((item) => item.status === "processing").length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isLargePdf(bytes: number) {
  return bytes >= largePdfWarningSize;
}

function formatQueueStatus(status: QueueStatus) {
  return status.replace(/_/g, " ");
}

function formatQueueProgress(item: QueueItem) {
  if (item.status === "completed") {
    return "Complete";
  }
  if (item.status === "failed") {
    return "Failed";
  }
  if (item.status === "cancelled") {
    return "Cancelled";
  }
  if (item.total > 0) {
    return `${item.done} / ${item.total} chapters`;
  }
  return item.status === "processing" ? "Starting" : "Pending";
}

function getQueueProgressPercent(item: QueueItem) {
  if (item.status === "completed") {
    return 100;
  }
  if (item.status === "failed" || item.status === "cancelled") {
    return item.total > 0 ? Math.round((item.done / item.total) * 100) : 100;
  }
  if (item.total > 0) {
    return Math.max(6, Math.round((item.done / item.total) * 100));
  }
  return item.status === "processing" ? 8 : 0;
}

function getErrorRequestId(error: unknown) {
  if (error && typeof error === "object" && "requestId" in error) {
    const requestId = (error as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? requestId : "";
  }
  return "";
}

function formatDiagnosticTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDiagnosticChapter(chapter: UploadDiagnosticEvent["chapter"]) {
  if (!chapter) {
    return "";
  }
  const name = chapter.chapter_name || `Chapter ${chapter.chapter_number || "unknown"}`;
  const fromPage = emptyText(chapter.from_page);
  const toPage = emptyText(chapter.to_page);
  return `${name} | Pages ${fromPage}-${toPage}`;
}

function formatDiagnosticValue(value: string | number | boolean | null) {
  if (value === null || value === "") {
    return "none";
  }
  return String(value);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRecordStatus(status: string) {
  return status.replace(/_/g, " ");
}

function getPageFromPath(pathname: string): AppPage {
  return pathname === "/insights" ? "insights" : "review";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatScore(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Not mentioned";
  }
  return `${Math.round(value * 100)}%`;
}

function formatPercent(value: number | null, emptyTextValue: string) {
  if (value === null || Number.isNaN(value)) {
    return emptyTextValue;
  }
  return `${(value * 100).toFixed(1)}%`;
}

function emptyText(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "Not mentioned";
  }
  return String(value);
}
