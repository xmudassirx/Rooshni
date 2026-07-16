import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient, createSignup } from "@rooshni/db";

export const dynamic = "force-dynamic";

/**
 * Signup step 1 → a pre-active account (decision 79). Public by design: the
 * signer has no session yet. Holds name, business name, email, phone and
 * website URL — nothing else exists until payment clears, nothing here
 * spends anything, and an abandoned signup is swept by the lifecycle job.
 * Idempotent on the signup email: pressing Continue twice resumes the same
 * pre-active record.
 */
export async function POST(request: NextRequest) {
  let body: {
    name?: string;
    businessName?: string;
    email?: string;
    phone?: string;
    websiteUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!body.name?.trim() || !body.businessName?.trim() || !body.email?.includes("@")) {
    return NextResponse.json(
      { error: "A name, business name and valid email are required." },
      { status: 400 }
    );
  }

  try {
    const record = await createSignup(createServiceClient(), {
      name: body.name,
      businessName: body.businessName,
      email: body.email,
      phone: body.phone ?? "",
      websiteUrl: body.websiteUrl ?? "",
    });
    return NextResponse.json({
      accountId: record.accountId,
      resumeToken: record.resumeToken,
    });
  } catch (err) {
    console.error("signup failed:", err);
    return NextResponse.json(
      { error: "Could not hold your details — please try again." },
      { status: 500 }
    );
  }
}
