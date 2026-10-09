import { NextRequest, NextResponse } from "next/server";
import { createAgentClient } from "@/lib/agent-client";
import {
  buildSystemPrompt,
  buildAuditUserPrompt,
} from "@/lib/audit-engine";
import {
  createJob,
  jobStore,
  pushJobEvent,
  setJobThread,
  getJobThread,
  setLastAuditJobId,
} from "@/lib/audit-store";
import { isValidIdentifier } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    database = "",
    scope = [],
    schema = "",
  } = body as {
    database?: string;
    scope?: string[];
    schema?: string;
  };

  if (!database || !isValidIdentifier(database)) {
    return NextResponse.json({ error: "Invalid database name" }, { status: 400 });
  }
  if (schema && !isValidIdentifier(schema)) {
    return NextResponse.json({ error: "Invalid schema name" }, { status: 400 });
  }

  const jobId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = createJob(jobId);
  setLastAuditJobId(jobId);

  pushJobEvent(jobId, {
    type: "status",
    message: "Starting audit session...",
    database,
    _ts: Date.now(),
  });

  const response = NextResponse.json({ jobId, token });

  runAuditJob(jobId, database, scope, schema).catch((err) => {
    console.error("Audit job error:", err);
  });

  return response;
}

async function runAuditJob(
  jobId: string,
  database: string,
  scope: string[],
  schema: string,
) {
  const job = jobStore.get(jobId);
  if (!job) return;

  const toolCounter = { count: 0, start: Date.now() };

  try {
    const client = createAgentClient();
    const systemPrompt = buildSystemPrompt(database, scope, schema);
    const userPrompt = buildAuditUserPrompt(database, scope, schema);

    pushJobEvent(jobId, {
      type: "status",
      message: "Session connected. Running audit...",
    });

    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: systemPrompt + "\n\n" + userPrompt },
        ],
      },
    ];

    // Store thread scoped to this job
    setJobThread(jobId, [...messages]);

    const stream = client.codingAgent.stream({
      permissionPolicy: "always_allow",
      messages,
    });

    let report: unknown = null;
    let reportEmitted = false;

    stream.on("text", (delta: string, accumulated: string) => {
      try {
        const parsed = JSON.parse(accumulated);
        if (parsed.findings && !reportEmitted) {
          report = parsed;
          reportEmitted = true;
          pushJobEvent(jobId, { type: "report", report: parsed });
          pushJobEvent(jobId, {
            type: "result",
            isError: false,
            numTurns: 0,
            durationMs: Date.now() - toolCounter.start,
            toolCalls: toolCounter.count,
          });
        }
      } catch {
        // Not complete JSON yet
      }
    });

    stream.on("toolUse", (ev) => {
      toolCounter.count++;
      const elapsed = (
        (Date.now() - toolCounter.start) /
        1000
      ).toFixed(1);
      const toolName = ev.name || "unknown";
      const toolInput = (ev.input || {}) as Record<string, unknown>;

      const progressEvent: Record<string, unknown> = {
        type: "tool_progress",
        toolName,
        count: toolCounter.count,
        elapsed: Number(elapsed),
      };

      if (toolName === "sql_execute" && toolInput) {
        progressEvent.sqlPreview = String(toolInput.sql || "")
          .slice(0, 120)
          .replace(/\n/g, " ");
        progressEvent.description = toolInput.description || "";
      }

      pushJobEvent(jobId, progressEvent);
      pushJobEvent(jobId, {
        type: "tool_use",
        toolName,
        toolId: ev.tool_use_id || "",
        input: toolInput,
      });
    });

    stream.on("thinking", (delta: string) => {
      pushJobEvent(jobId, {
        type: "thinking",
        text: delta,
      });
    });

    stream.on("error", (error: Error) => {
      pushJobEvent(jobId, { type: "error", message: error.message });
    });

    await stream.done();

    const accumulatedText = stream.currentText;

    if (!report && accumulatedText.trim()) {
      try {
        const parsed = JSON.parse(accumulatedText.trim());
        if (parsed.findings) {
          report = parsed;
          pushJobEvent(jobId, { type: "report", report: parsed });
        }
      } catch {
        const jsonMatch = accumulatedText.match(/\{[\s\S]*"findings"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.findings) {
              report = parsed;
              pushJobEvent(jobId, { type: "report", report: parsed });
            }
          } catch {
            // Still not valid JSON
          }
        }
      }

      if (!report && accumulatedText.trim()) {
        pushJobEvent(jobId, { type: "text", text: accumulatedText });
      }
    }

    if (!reportEmitted) {
      pushJobEvent(jobId, {
        type: "result",
        isError: !report,
        numTurns: 0,
        durationMs: Date.now() - toolCounter.start,
        toolCalls: toolCounter.count,
        ...(report ? { report } : {}),
      });
    }

    // Store assistant response in job-scoped thread
    if (accumulatedText) {
      const thread = getJobThread(jobId) || [];
      thread.push({
        role: "assistant",
        content: [{ type: "text", text: accumulatedText }],
      });
      setJobThread(jobId, thread);
    }

    job.done = true;
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error("Audit job error:", msg);
    pushJobEvent(jobId, { type: "error", message: msg });
    job.done = true;
    job.error = msg;
  }
}
