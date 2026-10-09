import { NextResponse } from "next/server";
import { setFixActive } from "@/app/api/suggest-fix/route";

export const dynamic = "force-dynamic";

export async function POST() {
  setFixActive(false);
  return NextResponse.json({ ok: true });
}
