import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const { username, linkToken } = await req.json();

    if (!username || !linkToken) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // In a real app, you would verify the linkToken against a Redis cache
    // that the Minecraft plugin populated when the user ran `/donut link`
    // For this mockup, we assume any token "dev-token-123" is valid for testing

    if (linkToken !== "dev-token-123") {
        return NextResponse.json({ error: "Invalid or expired link token" }, { status: 401 });
    }

    // Mock UUID mapping (plugin would send real UUID)
    const mockUuid = "00000000-0000-0000-0000-000000000000";

    const user = await prisma.user.upsert({
      where: { username },
      update: { minecraftUuid: mockUuid },
      create: {
        username,
        minecraftUuid: mockUuid,
        balance: 0.0,
      }
    });

    return NextResponse.json({ success: true, user });

  } catch (error) {
    console.error("Auth Link Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
