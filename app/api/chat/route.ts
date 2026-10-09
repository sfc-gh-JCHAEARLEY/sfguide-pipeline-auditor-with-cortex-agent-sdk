import { NextRequest, NextResponse } from "next/server";
import { createAgentClient } from "@/lib/agent-client";
import {
  createJob,
  jobStore,
  pushJobEvent,
  getJobThread,
  setJobThread,
  getLastAuditJobId,
} from "@/lib/audit-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { message } = body as { message?: string };

  if (!message || typeof message !== "string") {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400 },
    );
  }

  const auditJobId = getLastAuditJobId();
  if (!auditJobId || !getJobThread(auditJobId)) {
    return NextResponse.json(
      { error: "No active audit session. Run an audit first." },
      { status: 400 },
    );
  }

  const jobId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = createJob(jobId);

  const response = NextResponse.json({ jobId, token });

  runChatJob(jobId, auditJobId, message).catch((err) => {
    console.error("Chat job error:", err);
  });

  return response;
}

async function runChatJob(
  jobId: string,
  auditJobId: string,
  message: string,
) {
  const job = jobStore.get(jobId);
  if (!job) return;

  const thread = getJobThread(auditJobId);
  if (!thread) {
    pushJobEvent(jobId, {
      type: "error",
      message: "No active audit session.",
    });
    job.done = true;
    return;
  }

  try {
    const client = createAgentClient();

    thread.push({
      role: "user",
      content: [{ type: "text", text: message }],
    });

    const stream = client.codingAgent.stream({
      permissionPolicy: "always_allow",
      messages: thread,
    });

    stream.on("text", (delta: string) => {
      pushJobEvent(jobId, {
        type: "text",
        text: delta,
      });
    });

    stream.on("toolUse", (ev) => {
      pushJobEvent(jobId, {
        type: "tool_use",
        toolName: ev.name || "unknown",
        toolId: ev.tool_use_id || "",
        input: (ev.input || {}) as Record<string, unknown>,
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

    if (accumulatedText) {
      thread.push({
        role: "assistant",
        content: [{ type: "text", text: accumulatedText }],
      });
      setJobThread(auditJobId, thread);
    }

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
    console.error("Chat error:", msg);
    pushJobEvent(jobId, { type: "error", message: msg });
    job.done = true;
    job.error = msg;
  }
}
