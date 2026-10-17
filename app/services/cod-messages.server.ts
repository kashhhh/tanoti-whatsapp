import type { CodOrder } from "@prisma/client";
import { checkTemplateExists, formatWhatsAppError } from "./whatsapp.server";

export const messageKinds = ["request", "reminder", "confirmed", "cancelled"] as const;
export type MessageKind = typeof messageKinds[number];

const COD_TEMPLATES = {
  request: { name: "cod_request", params: ["customerName", "orderNumber", "products", "address"] },
  reminder: { name: "cod_reminder", params: ["customerName", "orderNumber", "products", "address"] },
  confirmed: { name: "order_confirmation_test", params: ["customerName", "orderNumber", "products", "address"] },
  cancelled: { name: "cod_cancelled", params: ["customerName", "orderNumber"] },
} as const;

export async function prepareCodMessage(order: CodOrder, kind: MessageKind) {
  const { name, params: mapping } = COD_TEMPLATES[kind];
  const { template, approved } = await checkTemplateExists(name);
  if (!template || !approved) throw new Error(`Template ${name} must be approved.`);
  const components: Array<Record<string, unknown>> = [];
  const body = template.components?.find((component) => component.type === "BODY");
  const placeholders = [...new Set(body?.text?.match(/\{\{[^}]+\}\}/g) ?? [])];
  if (placeholders.length !== mapping.length || placeholders.some((p, i) => p !== `{{${i + 1}}}`)) {
    throw new Error(`${name} must have ${mapping.length} numbered body variables in order: ${mapping.join(", ")}.`);
  }
  components.push({ type: "body", parameters: mapping.map((key) => ({ type: "text", text: order[key] || "—" })) });
  for (const component of template.components ?? []) {
    if (component.type === "HEADER" && (component.format !== "TEXT" || component.text?.includes("{{"))) {
      throw new Error("COD templates support static text headers only.");
    }
  }
  const buttons = template.components?.find((component) => component.type === "BUTTONS")?.buttons ?? [];
  if (kind === "request" || kind === "reminder") {
    if (buttons.length !== 2 || buttons.some((button) => button.type !== "QUICK_REPLY")) {
      throw new Error(`${name} needs two quick-reply buttons: YES/CONFIRM first, NO/CANCEL second.`);
    }
    if (!["YES", "CONFIRM"].includes(buttons[0].text?.trim().toUpperCase() || "") ||
        !["NO", "CANCEL"].includes(buttons[1].text?.trim().toUpperCase() || "")) {
      throw new Error(`${name} button labels must be YES/CONFIRM first and NO/CANCEL second.`);
    }
    ["yes", "no"].forEach((action, index) => components.push({
      type: "button", sub_type: "quick_reply", index: String(index),
      parameters: [{ type: "payload", payload: `cod:${order.id}:${order.orderId}:${action}` }],
    }));
  } else if (buttons.length) {
    throw new Error(`${name} must have no buttons.`);
  }
  return { name: template.name, language: { code: template.language }, components };
}

export async function submitCodMessage(phone: string, template: Awaited<ReturnType<typeof prepareCodMessage>>) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const number = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !number) throw new Error("WhatsApp credentials are missing.");
  const response = await fetch(`https://graph.facebook.com/v23.0/${number}/messages`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "template", template }),
  });
  const data = await response.json();
  if (!response.ok) return { error: formatWhatsAppError(data), id: null };
  if (!data.messages?.[0]?.id) throw new Error("WhatsApp acceptance is unknown; inspect Meta before retrying.");
  return { id: String(data.messages[0].id), error: null };
}
