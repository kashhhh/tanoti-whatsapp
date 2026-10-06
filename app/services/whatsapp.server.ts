export async function sendWhatsAppMessage(
  phone: string,
  customerName: string,
  orderNumber: string,
  products: string,
  address: string
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "order_confirmation_test",
          language: {
            code: "en_US",
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: customerName },
                { type: "text", text: orderNumber },
                { type: "text", text: products },
                { type: "text", text: address },
              ],
            },
          ],
        },
      }),
    },
  );

  const data = await response.json();

  console.log("WHATSAPP API RESPONSE:", data);

  if (!response.ok) {
    console.error("WhatsApp error:", data);

    return {
      success: false,
      error: data,
    };
  }

  return {
    success: true,
    data,
  };
}


export async function orderDeliveredMessage(
  phone: string,
  orderNumber: string,
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "delivery_confirmation_test",
          language: {
            code: "en_US",
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: orderNumber },
              ],
            },
          ],
        },
      }),
    },
  );

  const data = await response.json();

  console.log("WHATSAPP API RESPONSE:", data);

  if (!response.ok) {
    console.error("WhatsApp error:", data);

    return {
      success: false,
      error: data,
    };
  }

  return {
    success: true,
    data,
  };
}


export async function orderPackedMessage(
  phone: string,
  customerName: string,
  orderNumber: string,
  trackingUrl: string
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "order_packed",
          language: {
            code: "en_US",
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: customerName },
                { type: "text", text: orderNumber },
                { type: "text", text: trackingUrl },
              ],
            },
          ],
        },
      }),
    },
  );

  const data = await response.json();

  console.log("WHATSAPP API RESPONSE:", data);

  if (!response.ok) {
    console.error("WhatsApp error:", data);

    return {
      success: false,
      error: data,
    };
  }

  return {
    success: true,
    data,
  };
}

export async function checkTemplateExists(templateName: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!token || !wabaId) {
    throw new Error("WhatsApp access token and business account ID must be configured.");
  }

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}&fields=name,status,language,category,components&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatWhatsAppError(data));
  }
  const matches = data.data?.filter((t: WhatsAppTemplateDefinition) => t.name === templateName) ?? [];
  const template: WhatsAppTemplateDefinition | undefined =
    matches.find((t: WhatsAppTemplateDefinition) => t.status === "APPROVED") ?? matches[0];

  if (!template) {
    return { exists: false, approved: false, template: undefined };
  }

  return { exists: true, approved: template.status === "APPROVED", template };
}

interface WhatsAppTemplateDefinition {
  name: string;
  status: string;
  language: string;
  components?: Array<{
    type: string;
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; url?: string }>;
  }>;
}

export interface WhatsAppTemplatePayload {
  name: string;
  language: { code: string };
  components?: Array<{
    type: "header";
    parameters: Array<{ type: "image"; image: { link: string } }>;
  }>;
}

export function formatWhatsAppError(data: {
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}) {
  const error = data.error;
  const details = error?.error_data?.details || error?.message || "WhatsApp request failed.";
  return error?.code ? `Meta error ${error.code}: ${details}` : details;
}

export async function prepareWhatsAppTemplate(templateName: string, imageUrl = ""): Promise<WhatsAppTemplatePayload> {
  const { template, approved } = await checkTemplateExists(templateName);
  if (!template) throw new Error(`Template "${templateName}" not found.`);
  if (!approved) throw new Error(`Template "${templateName}" is not approved yet.`);
  if (!template.language) throw new Error("The template has no approved language code.");

  const payload: WhatsAppTemplatePayload = {
    name: template.name,
    language: { code: template.language },
  };

  for (const component of template.components ?? []) {
    if (component.text?.includes("{{") || component.buttons?.some((button) => button.url?.includes("{{"))) {
      throw new Error("This template requires variable values. This send form supports templates without variables.");
    }
    if (component.type === "HEADER" && component.format === "IMAGE") {
      let url: URL;
      try {
        url = new URL(imageUrl.trim());
      } catch {
        throw new Error(`Template "${templateName}" requires a public image URL. Enter it in Header image URL.`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Header image URL must be a public HTTP or HTTPS URL.");
      }
      payload.components = [{
        type: "header",
        parameters: [{ type: "image", image: { link: url.href } }],
      }];
    } else if (component.type === "HEADER" && component.format !== "TEXT") {
      throw new Error(`This send form does not support ${component.format ?? "this"} template headers.`);
    } else if (component.type === "BUTTONS" && component.buttons?.some((button) => !["URL", "PHONE_NUMBER", "QUICK_REPLY"].includes(button.type))) {
      throw new Error("This template requires button parameters that this send form does not support.");
    } else if (!["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(component.type)) {
      throw new Error(`This send form does not support ${component.type} template components.`);
    }
  }
  return payload;
}

export async function sendWhatsAppTemplate(
  phone: string,
  template: WhatsAppTemplatePayload,
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WhatsApp access token and phone number ID must be configured.");
  }

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template,
      }),
    },
  );

  const data = await response.json();
  return { success: response.ok, data, error: response.ok ? undefined : formatWhatsAppError(data) };
}

export async function sendAbandonedCartTemplate(
  phone: string,
  templateName: string,
  imageUrl: string,
  customerName: string,
  orderDetails: string,
  checkoutUrl: string,
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en_US" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { link: imageUrl } }],
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: customerName },
                { type: "text", text: orderDetails },
                { type: "text", text: checkoutUrl },
              ],
            },
          ],
        },
      }),
    },
  );

  const data = await response.json();
  return { success: response.ok, data };
}
