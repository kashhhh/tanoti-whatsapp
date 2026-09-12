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