import { NextRequest, NextResponse } from "next/server";
import { jobStore, verifyJobToken } from "@/lib/audit-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId") || "";
  const token = request.nextUrl.searchParams.get("token") || "";
  const after = parseInt(
    request.nextUrl.searchParams.get("after") || "0",
    10,
  );

  if (!jobId || !token || !verifyJobToken(jobId, token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const job = jobStore.get(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const newEvents = job.events.slice(after);
  return NextResponse.json({
    events: newEvents,
    cursor: job.events.length,
    done: job.done,
  });
}
