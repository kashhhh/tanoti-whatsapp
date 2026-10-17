import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { registerCodOrder } from "../services/cod.server";
import { isCodOrder } from "../services/cod-rules";
import { sendWhatsAppMessage } from "../services/whatsapp.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (payload.checkout_token) {
    await db.abandonedCheckout.updateMany({
      where: { checkoutToken: payload.checkout_token },
      data: { converted: true },
    });
  }
  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    return new Response("Invalid order ID", { status: 400 });
  }
  if (await registerCodOrder(shop, { ...payload, id: payload.id })) return new Response();
  const settings = await db.settings.findUnique({
    where: { shop },
  });

  const cod = isCodOrder(payload.payment_gateway_names ?? []);
  // Only paid, non-COD orders use the existing confirmation template.
  // A disabled COD switch must never turn a COD order into a prepaid send.
  if (!cod && payload.financial_status === "paid") {
    if (!settings?.whatsappEnabled) return new Response();
    const phone = payload.phone || payload.shipping_address?.phone || payload.customer?.phone;
    if (!phone) return new Response();
    const customerName = [payload.customer?.first_name || payload.shipping_address?.first_name,
      payload.customer?.last_name || payload.shipping_address?.last_name].filter(Boolean).join(" ") || "Customer";
    const products = (payload.line_items ?? [])
      .map((item: { title: string; variant_title?: string | null }) => `${item.title} | ${item.variant_title ?? "-"}`)
      .join(" • ");
    const address = [payload.shipping_address?.address1, payload.shipping_address?.address2,
      payload.shipping_address?.city, payload.shipping_address?.province,
      payload.shipping_address?.zip, payload.shipping_address?.country].filter(Boolean).join(", ");
    const result = await sendWhatsAppMessage(phone, customerName, payload.name, products, address);
    console.info("PREPAID ORDER CONFIRMATION:", JSON.stringify({ shop, orderId: String(payload.id), accepted: result.success }));
    return new Response();
  }
  console.info("ORDER NOT TRACKED BY COD; CONFIRMATION SKIPPED:", JSON.stringify({
    shop,
    orderId: String(payload.id),
    paymentGateways: payload.payment_gateway_names ?? [],
    codEnabled: settings?.codEnabled ?? false,
    financialStatus: payload.financial_status ?? null,
  }));

  return new Response();
};
