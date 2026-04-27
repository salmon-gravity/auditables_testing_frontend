import type { HistoryRecord, ReviewStatus, UploadProgressEvent } from "./types";

export async function fetchHistory(): Promise<HistoryRecord[]> {
  const response = await fetch("/api/history");
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `History load failed: ${response.status}`);
  }

  return Array.isArray(body.records) ? body.records : [];
}

export async function uploadPdf(
  file: File,
  apiBaseUrl: string,
  onProgress: (event: UploadProgressEvent) => void
): Promise<HistoryRecord> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("apiBaseUrl", apiBaseUrl);

  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: {
      Accept: "text/event-stream"
    },
    body: formData
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Upload failed: ${response.status}`);
  }

  return readUploadStream(response.body, onProgress);
}

export async function updateAuditableReview(
  recordId: string,
  auditableId: string,
  patch: {
    reviewStatus?: ReviewStatus;
    penaltyReviewStatus?: ReviewStatus;
    deadlineReviewStatus?: ReviewStatus;
    remark?: string;
  }
): Promise<HistoryRecord> {
  const response = await fetch(`/api/history/${recordId}/auditables/${auditableId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(patch)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Review update failed: ${response.status}`);
  }

  return body.record;
}

export async function deleteHistory(password: string): Promise<void> {
  const response = await fetch("/api/history", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Delete failed: ${response.status}`);
  }
}

async function readUploadStream(
  stream: ReadableStream<Uint8Array>,
  onProgress: (event: UploadProgressEvent) => void
): Promise<HistoryRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedRecord: HistoryRecord | null = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseEvent(rawEvent);

      if (parsed.event === "progress") {
        onProgress(parsed.data as UploadProgressEvent);
      }

      if (parsed.event === "complete") {
        completedRecord = (parsed.data as { record: HistoryRecord }).record;
      }

      if (parsed.event === "error") {
        throw new Error((parsed.data as { error?: string }).error || "Upload failed.");
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  if (!completedRecord) {
    throw new Error("Upload stream ended without a completed record.");
  }

  return completedRecord;
}

function parseSseEvent(rawEvent: string): { event: string; data: unknown } {
  const eventLine = rawEvent.split("\n").find((line) => line.startsWith("event:"));
  const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
  const event = eventLine ? eventLine.replace(/^event:\s*/, "") : "message";
  const rawData = dataLine ? dataLine.replace(/^data:\s*/, "") : "{}";

  try {
    return { event, data: JSON.parse(rawData) };
  } catch {
    return { event, data: {} };
  }
}
