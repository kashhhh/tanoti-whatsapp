import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncCodOrder } from "../services/cod.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const cod = await db.codOrder.findUnique({ where: { shop_orderId: { shop, orderId: String(payload.id) } } });
  if (cod) await syncCodOrder(cod.id);

  const settings = await db.settings.findUnique({
    where: { shop },
  });

  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping message.");
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  console.log("ORDER CANCELLED:");
  console.log({
    orderNumber: payload.name,
    customerName: payload.customer?.first_name,
    phone: payload.customer?.phone,
    cancelReason: payload.cancel_reason,
  });

  return new Response();
};
