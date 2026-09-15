import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);

  const settings = await db.settings.findUnique({ where: { shop } });
  if (!settings?.whatsappEnabled) {
    console.log("WhatsApp notifications are OFF. Skipping abandoned checkout tracking.");
    return new Response();
  }

  const phone = payload.phone ?? payload.customer?.phone ?? payload.shipping_address?.phone ?? null;
  const customerName = payload.customer?.first_name ?? "there";
  const checkoutUrl = payload.abandoned_checkout_url ?? null;
  const lineItems = payload.line_items ?? [];
  const checkoutToken = payload.token;

  console.log("CHECKOUT CREATE:", { checkoutToken, phone, checkoutUrl });

  if (!phone || !checkoutUrl || lineItems.length === 0 || !checkoutToken) {
    console.log("Missing phone, checkout URL, token, or line items. Skipping.");
    return new Response();
  }

  const orderDetails = lineItems
    .map((item: any) => `${item.title}${item.variant_title ? " (" + item.variant_title + ")" : ""}`)
    .join(", ");

  let imageUrl = null;
  const firstItem = lineItems[0];
  if (admin && firstItem.product_id) {
    const productResponse = await admin.graphql(
      `#graphql
        query getProductImage($id: ID!) {
          product(id: $id) {
            featuredImage {
              url
            }
          }
        }`,
      { variables: { id: `gid://shopify/Product/${firstItem.product_id}` } },
    );
    const productJson = await productResponse.json();
    imageUrl = productJson.data?.product?.featuredImage?.url ?? null;
  }

  await db.abandonedCheckout.upsert({
    where: { checkoutToken },
    update: { phone, customerName, orderDetails, imageUrl, checkoutUrl },
    create: {
      shop,
      checkoutToken,
      phone,
      customerName,
      orderDetails,
      imageUrl,
      checkoutUrl,
    },
  });

  console.log("ABANDONED CHECKOUT SAVED:", checkoutToken);

  return new Response();
};