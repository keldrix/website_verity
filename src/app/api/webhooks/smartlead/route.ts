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

function getStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function getNestedString(
  value: unknown,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let current: unknown = value;

    for (const key of path) {
      if (!isRecord(current) || !(key in current)) {
        current = undefined;
        break;
      }

      current = current[key];
    }

    const stringValue = getStringValue(current);
    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function findFirstStringByKeys(
  value: unknown,
  keys: string[],
  visited = new Set<unknown>(),
): string | undefined {
  if (value === null || value === undefined || visited.has(value)) {
    return undefined;
  }

  const directValue = getStringValue(value);
  if (directValue && keys.length === 0) {
    return directValue;
  }

  if (Array.isArray(value)) {
    visited.add(value);

    for (const item of value) {
      const match = findFirstStringByKeys(item, keys, visited);
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  visited.add(value);

  for (const key of keys) {
    const directMatch = getStringValue(value[key]);
    if (directMatch) {
      return directMatch;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const match = findFirstStringByKeys(nestedValue, keys, visited);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function getLeadName(payload: ParsedPayload): string | undefined {
  const explicitName = getNestedString(payload, [
    ["lead_name"],
    ["name"],
    ["lead", "name"],
    ["lead", "full_name"],
    ["full_name"],
  ]);

  if (explicitName) {
    return explicitName;
  }

  const firstName = findFirstStringByKeys(payload, ["first_name", "firstname"]);
  const lastName = findFirstStringByKeys(payload, ["last_name", "lastname"]);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName) {
    return fullName;
  }

  return findFirstStringByKeys(payload, [
    "lead_name",
    "full_name",
    "sender_name",
    "from_name",
    "contact_name",
    "prospect_name",
  ]);
}

function truncateForSlack(message: string) {
  if (message.length <= SLACK_MESSAGE_LIMIT) {
    return message;
  }

  return `${message.slice(0, SLACK_MESSAGE_LIMIT)}\n...truncated`;
}

function formatSlackMessage(payload: ParsedPayload): string {
  const campaign =
    getNestedString(payload, [
      ["campaign_name"],
      ["campaign"],
      ["campaign", "name"],
    ]) ??
    findFirstStringByKeys(payload, [
      "campaign_name",
      "campaign",
      "campaign_title",
      "campaign_label",
    ]);
  const leadName = getLeadName(payload);
  const email =
    getNestedString(payload, [
      ["email"],
      ["lead_email"],
      ["lead", "email"],
    ]) ??
    findFirstStringByKeys(payload, [
      "email",
      "lead_email",
      "email_address",
      "from_email",
      "sender_email",
      "contact_email",
      "prospect_email",
    ]);
  const company =
    getNestedString(payload, [
      ["company"],
      ["company_name"],
      ["lead", "company"],
      ["lead", "company_name"],
    ]) ??
    findFirstStringByKeys(payload, [
      "company",
      "company_name",
      "organization",
      "organization_name",
      "account_name",
      "business_name",
    ]);
  const replyText =
    getNestedString(payload, [
      ["reply_message", "text"],
      ["reply_message"],
      ["message", "text"],
      ["message"],
      ["text"],
      ["body"],
    ]) ??
    findFirstStringByKeys(payload, [
      "reply_message",
      "message",
      "text",
      "body",
      "reply_text",
      "email_body",
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
