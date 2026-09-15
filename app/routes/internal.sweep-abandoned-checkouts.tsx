import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { sendAbandonedCartTemplate } from "../services/whatsapp.server";

const TEMPLATE_NAME = "abandoned_checkout";
const WAIT_MINUTES = 15;

export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = request.headers.get("x-sweep-secret");
  if (secret !== process.env.SWEEP_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const cutoff = new Date(Date.now() - WAIT_MINUTES * 60 * 1000);

  const candidates = await db.abandonedCheckout.findMany({
    where: {
      converted: false,
      messaged: false,
      createdAt: { lte: cutoff },
    },
  });

  console.log(`SWEEP: found ${candidates.length} checkouts to message`);

  for (const checkout of candidates) {
    if (!checkout.imageUrl) {
      console.log(`Skipping ${checkout.checkoutToken}: no image URL`);
      continue;
    }

    const result = await sendAbandonedCartTemplate(
      checkout.phone,
      TEMPLATE_NAME,
      checkout.imageUrl,
      checkout.customerName,
      checkout.orderDetails,
      checkout.checkoutUrl,
    );

    console.log(`SWEEP SEND ${checkout.checkoutToken}:`, result);

    await db.abandonedCheckout.update({
      where: { id: checkout.id },
      data: { messaged: true },
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  return new Response(`Processed ${candidates.length}`, { status: 200 });
};
