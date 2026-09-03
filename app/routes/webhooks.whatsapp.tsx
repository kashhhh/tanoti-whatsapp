import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

// Meta calls this with GET once, to verify you own this URL
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WHATSAPP WEBHOOK VERIFIED");
    return new Response(challenge, { status: 200 });
  }

  console.log("WHATSAPP WEBHOOK VERIFICATION FAILED");
  return new Response("Forbidden", { status: 403 });
};

// Meta calls this with POST for every event (delivery status, etc.)
export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await request.json();
  console.log("WHATSAPP WEBHOOK EVENT:", JSON.stringify(body, null, 2));
  return new Response("OK", { status: 200 });
};
