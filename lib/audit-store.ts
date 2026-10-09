/**
 * In-memory job store for audit/fix/chat jobs.
 * Each job accumulates events that the frontend polls via GET /api/audit/progress.
 * Thread messages are scoped per job to avoid cross-request leakage.
 */
import { createHmac, randomBytes } from "crypto";

type ThreadMessage = {
  role: string;
  content: Array<{ type: string; text: string }>;
};

export interface AuditJob {
  events: Record<string, unknown>[];
  done: boolean;
  error?: string;
  thread?: ThreadMessage[];
  token: string;
  createdAt: number;
}

const MAX_JOBS = 50;
const MAX_AGE_MS = 30 * 60 * 1000;

// Per-process secret for HMAC tokens — regenerated on each restart
const JOB_SECRET = randomBytes(32).toString("hex");

export const jobStore = new Map<string, AuditJob>();

function generateJobToken(jobId: string): string {
  return createHmac("sha256", JOB_SECRET).update(jobId).digest("hex").slice(0, 16);
}

export function verifyJobToken(jobId: string, token: string): boolean {
  return generateJobToken(jobId) === token;
}

// Evict oldest done jobs when over capacity or past max age
function evictStaleJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobStore) {
    if (job.done && job.createdAt < cutoff) {
      jobStore.delete(id);
    }
  }
  // If still over capacity, evict oldest done jobs
  if (jobStore.size >= MAX_JOBS) {
    const doneJobs = [...jobStore.entries()]
      .filter(([, j]) => j.done)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (jobStore.size >= MAX_JOBS && doneJobs.length > 0) {
      const [id] = doneJobs.shift()!;
      jobStore.delete(id);
    }
  }
}

/** Create a new job and return its auth token. */
export function createJob(jobId: string): string {
  evictStaleJobs();
  const token = generateJobToken(jobId);
  jobStore.set(jobId, { events: [], done: false, token, createdAt: Date.now() });
  return token;
}

// Track the most recent audit/fix jobId so chat can find its thread
let lastAuditJobId: string | null = null;
let lastFixJobId: string | null = null;

export function setLastAuditJobId(jobId: string) {
  lastAuditJobId = jobId;
}
export function getLastAuditJobId(): string | null {
  return lastAuditJobId;
}
export function setLastFixJobId(jobId: string) {
  lastFixJobId = jobId;
}
export function getLastFixJobId(): string | null {
  return lastFixJobId;
}

export function getJobThread(jobId: string): ThreadMessage[] | undefined {
  return jobStore.get(jobId)?.thread;
}

export function setJobThread(jobId: string, thread: ThreadMessage[]) {
  const job = jobStore.get(jobId);
  if (job) job.thread = thread;
}

export function pushJobEvent(
  jobId: string,
  event: Record<string, unknown>,
): void {
  const job = jobStore.get(jobId);
  if (job) {
    if (job.events.length === 0) event._ts = Date.now();
    job.events.push(event);
  }
}
