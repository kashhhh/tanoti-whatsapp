export async function sendWhatsAppMessage(
  phone: string,
  customerName: string,
  orderNumber: string,
  delivery: string,
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
          name: "order_confirmed_test",
          language: {
            code: "en_US",
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: customerName },
                { type: "text", text: orderNumber },
                // { type: "text", text: delivery },
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