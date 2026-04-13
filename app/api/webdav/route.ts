import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Files feature has been removed. Use B-Drive instead.' },
    { status: 410 },
  );
}
