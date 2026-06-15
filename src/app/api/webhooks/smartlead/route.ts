export const runtime = "nodejs";

type ParsedPayload =
  | string
  | Record<string, FormDataEntryValue>
  | Record<string, unknown>
  | unknown[]
  | null;

const SLACK_MESSAGE_LIMIT = 3000;

function serializePayload(payload: ParsedPayload) {
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}

function truncateForSlack(message: string) {
  if (message.length <= SLACK_MESSAGE_LIMIT) {
    return message;
  }

  return `${message.slice(0, SLACK_MESSAGE_LIMIT)}\n...truncated`;
}

async function parseWebhookPayload(request: Request): Promise<ParsedPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as ParsedPayload;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  const rawBody = await request.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as ParsedPayload;
  } catch {
    return rawBody;
  }
}

async function sendSlackNotification(payload: ParsedPayload) {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!slackWebhookUrl) {
    console.warn("Missing SLACK_WEBHOOK_URL for Smartlead webhook notification.");
    return;
  }

  const payloadPreview = truncateForSlack(serializePayload(payload));
  const response = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: `Smartlead webhook received\n\`\`\`${payloadPreview}\`\`\``,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack webhook failed: ${response.status} ${errorText}`);
  }
}

export async function GET() {
  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  const payload = await parseWebhookPayload(request);

  console.log("Smartlead webhook payload:", payload);

  try {
    await sendSlackNotification(payload);
  } catch (error) {
    console.error("Failed to send Smartlead Slack notification:", error);
  }

  return Response.json({ ok: true });
}
