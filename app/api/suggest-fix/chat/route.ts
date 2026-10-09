import { NextRequest, NextResponse } from "next/server";
import { createAgentClient } from "@/lib/agent-client";
import {
  createJob,
  jobStore,
  pushJobEvent,
  getJobThread,
  setJobThread,
  getLastFixJobId,
} from "@/lib/audit-store";
import { isFixActive, setFixActive } from "@/app/api/suggest-fix/route";

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

  const fixJobId = getLastFixJobId();
  if (!fixJobId || !getJobThread(fixJobId)) {
    return NextResponse.json(
      { error: "No active fix session. Request a fix first." },
      { status: 400 },
    );
  }

  if (isFixActive()) {
    return NextResponse.json(
      { error: "A fix response is still generating." },
      { status: 409 },
    );
  }

  setFixActive(true);
  const jobId = `fixchat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = createJob(jobId);

  const response = NextResponse.json({ jobId, token });

  runFixChatJob(jobId, fixJobId, message)
    .catch((err) => {
      console.error("Fix chat job error:", err);
    })
    .finally(() => {
      setFixActive(false);
    });

  return response;
}

async function runFixChatJob(
  jobId: string,
  fixJobId: string,
  message: string,
) {
  const job = jobStore.get(jobId);
  const fixThread = getJobThread(fixJobId);
  if (!job || !fixThread) {
    if (job) {
      pushJobEvent(jobId, {
        type: "error",
        message: "No active fix session.",
      });
      job.done = true;
    }
    return;
  }

  try {
    const client = createAgentClient();

    fixThread.push({
      role: "user",
      content: [{ type: "text", text: message }],
    });

    const stream = client.codingAgent.stream({
      permissionPolicy: "always_allow",
      messages: fixThread,
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

    if (accumulatedText) {
      fixThread.push({
        role: "assistant",
        content: [{ type: "text", text: accumulatedText }],
      });
      setJobThread(fixJobId, fixThread);
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
    console.error("Fix chat error:", msg);
    pushJobEvent(jobId, { type: "error", message: msg });
    job.done = true;
    job.error = msg;
  }
}
