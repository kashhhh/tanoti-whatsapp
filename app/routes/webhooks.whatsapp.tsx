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
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        const summary = JSON.stringify({
          messageId: status.id,
          recipient: `ending ${String(status.recipient_id ?? "").slice(-4)}`,
          status: status.status,
          errors: status.errors?.map((error: {
            code?: number; title?: string; message?: string;
            error_data?: { details?: string };
          }) => ({
            code: error.code,
            details: error.error_data?.details ?? error.message ?? error.title,
          })),
        });
        if (status.status === "failed") {
          console.error("WHATSAPP DELIVERY FAILED:", summary);
        } else {
          console.log("WHATSAPP DELIVERY STATUS:", summary);
        }
      }
    }
  }
  return new Response("OK", { status: 200 });
};
