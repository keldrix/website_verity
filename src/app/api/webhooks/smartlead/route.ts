export const runtime = "nodejs";

type ParsedPayload =
  | string
  | Record<string, FormDataEntryValue>
  | Record<string, unknown>
  | unknown[]
  | null;

const SLACK_MESSAGE_LIMIT = 3000;
const SMARTLEAD_INBOX_URL = "https://app.smartlead.ai/app/master-inbox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = value;

    for (const key of path) {
      if (!isRecord(current) || !(key in current)) {
        current = undefined;
        break;
      }

      current = current[key];
    }

    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }

  return undefined;
}

function truncateForSlack(message: string) {
  if (message.length <= SLACK_MESSAGE_LIMIT) {
    return message;
  }

  return `${message.slice(0, SLACK_MESSAGE_LIMIT)}\n...truncated`;
}

function formatSlackMessage(payload: ParsedPayload) {
  const campaign = getNestedString(payload, [
    ["campaign_name"],
    ["campaign"],
    ["campaign", "name"],
  ]);
  const leadName = getNestedString(payload, [
    ["lead_name"],
    ["name"],
    ["lead", "name"],
    ["lead", "full_name"],
    ["full_name"],
  ]);
  const email = getNestedString(payload, [
    ["email"],
    ["lead_email"],
    ["lead", "email"],
  ]);
  const company = getNestedString(payload, [
    ["company"],
    ["company_name"],
    ["lead", "company"],
    ["lead", "company_name"],
  ]);
  const replyText = getNestedString(payload, [
    ["reply_message", "text"],
    ["reply_message"],
    ["message", "text"],
    ["message"],
    ["text"],
    ["body"],
  ]);

  const lines = [
    "🎉 Smartlead Reply",
    "",
    `Campaign: ${campaign ?? "Unknown"}`,
    `Lead: ${leadName ?? "Unknown"}`,
    `Email: ${email ?? "Unknown"}`,
    `Company: ${company ?? "Unknown"}`,
    "",
    "Reply:",
    replyText ?? "No reply text provided.",
    "",
    "",
    "Open in Smartlead:",
    SMARTLEAD_INBOX_URL,
  ];

  return truncateForSlack(lines.join("\n"));
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

  const response = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: formatSlackMessage(payload),
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
