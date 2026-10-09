import { NextRequest, NextResponse } from "next/server";
import { createAgentClient } from "@/lib/agent-client";
import {
  createJob,
  jobStore,
  pushJobEvent,
  setJobThread,
  setLastFixJobId,
} from "@/lib/audit-store";
import { isValidIdentifier, sanitizeForPrompt } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Per-process lock to prevent concurrent fix jobs
let fixJobActive = false;

export function isFixActive(): boolean {
  return fixJobActive;
}

export function setFixActive(active: boolean) {
  fixJobActive = active;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { finding, database } = body as {
    finding?: Record<string, unknown>;
    database?: string;
  };

  if (!finding || !database) {
    return NextResponse.json(
      { error: "finding and database are required" },
      { status: 400 },
    );
  }

  if (!isValidIdentifier(database)) {
    return NextResponse.json({ error: "Invalid database name" }, { status: 400 });
  }

  if (isFixActive()) {
    return NextResponse.json(
      {
        error:
          "A fix is already in progress. Wait for it to finish or dismiss it.",
      },
      { status: 409 },
    );
  }

  setFixActive(true);

  const jobId = `fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = createJob(jobId);
  setLastFixJobId(jobId);

  const response = NextResponse.json({ jobId, token });

  runSuggestFixJob(jobId, finding, database)
    .catch((err) => {
      console.error("Suggest fix job error:", err);
    })
    .finally(() => {
      setFixActive(false);
    });

  return response;
}

async function runSuggestFixJob(
  jobId: string,
  finding: Record<string, unknown>,
  database: string,
) {
  const job = jobStore.get(jobId);
  if (!job) return;

  // Sanitize all finding fields before interpolation into prompts
  const severity = sanitizeForPrompt(finding.severity, 20);
  const category = sanitizeForPrompt(finding.category, 50);
  const object = sanitizeForPrompt(finding.object, 200);
  const message = sanitizeForPrompt(finding.message, 500);
  const details = finding.details
    ? sanitizeForPrompt(JSON.stringify(finding.details), 500)
    : "";

  const systemPrompt = `You are a Snowflake pipeline remediation expert. When given a finding, respond with a clear, actionable fix. Use SQL code blocks for any commands. Give the answer directly from your expertise. If the user asks you to run SQL, you may use sql_execute to run it against Snowflake. Target database: ${database}.`;

  const userPrompt = `Suggest a concrete fix for this pipeline audit finding on the ${database} database.

Finding:
- Severity: ${severity}
- Category: ${category}
- Object: ${object}
- Message: ${message}${details ? `\n- Details: ${details}` : ""}

Rules:
- Do NOT run any tools or queries. Respond with your answer directly.
- Provide exact SQL commands in fenced code blocks where applicable.
- Explain briefly why the fix works.
- Keep the response under 500 words.`;

  const messages: Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
  }> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: systemPrompt + "\n\n" + userPrompt,
        },
      ],
    },
  ];

  try {
    const client = createAgentClient();

    const stream = client.codingAgent.stream({
      permissionPolicy: "always_allow",
      messages,
    });

    stream.on("text", (delta: string) => {
      pushJobEvent(jobId, {
        type: "text",
        text: delta,
      });
    });

    stream.on("error", (error: Error) => {
      pushJobEvent(jobId, { type: "error", message: error.message });
    });

    await stream.done();

    const accumulatedText = stream.currentText;

    // Store thread scoped to this fix job
    const thread = [...messages];
    if (accumulatedText) {
      thread.push({
        role: "assistant",
        content: [{ type: "text", text: accumulatedText }],
      });
    }
    setJobThread(jobId, thread);

    pushJobEvent(jobId, {
      type: "result",
      isError: false,
      numTurns: 0,
      durationMs: 0,
    });

    job.done = true;
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error("Suggest-fix error:", msg);
    pushJobEvent(jobId, { type: "error", message: msg });
    job.done = true;
    job.error = msg;
  }
}
