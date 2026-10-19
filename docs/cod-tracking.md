# COD order tracking

Use **Enable COD WhatsApp messages** on the app home page or **COD orders** page to turn the flow on or off. This feature tracks new COD orders after it is enabled; it does not backfill old orders. The switch is independent of general WhatsApp notifications. Turning it off pauses new COD tracking and all outgoing COD messages for existing orders. History, status updates and replies to previously sent messages are preserved. Unsent messages stay queued and can resume through sync or the scheduled sweep after enabling again; messages already being sent may still arrive. Enabling validates permissions, credentials and approved templates; a setup error leaves the switch off.

## Staff workflow

- New COD orders get `COD Pending` and one order-specific WhatsApp request.
- YES/CONFIRM, a manual **Save tag → COD Confirmed**, a confirmed call, or adding `COD Confirmed` directly in Shopify confirms the order. The follow-up confirmation message is paused: the app does not read, validate or send `order_confirmation_test` as part of this COD workflow. The template itself is unchanged.
- Once confirmed, YES/NO can no longer change the order. Buttons may remain visible in WhatsApp, but the server ignores their actions. Even deleting the confirmed tag does not reopen this workflow.
- Prepaid orders marked paid when created still receive the existing `order_confirmation_test` notification when general WhatsApp notifications are enabled. The template is unchanged. COD orders do not fall back to this notification when COD messaging is off; their follow-up confirmation message remains paused. Skipped orders are logged with their payment gateway names, payment status and COD switch state.
- NO/CANCEL changes the order tag to `COD Cancel Requested`. Staff open the linked Shopify order and cancel manually. There is no cancellation API call or automatic deadline.
- A cancellation notice is sent only after Shopify reports the order actually cancelled.
- Record call 1 and call 2 as No answer, Confirmed, Declined, or Call back later. No answer and callback do not confirm or cancel an order. Recorded attempts are immutable; use the order status action for a later decision.
- Reminder: one after three business hours from WhatsApp accepting the initial request. Calendar: Monday–Saturday, 10:00–18:30 Asia/Kolkata. Sundays are excluded; holidays are not configured. A delayed reminder is sent only during business hours. Initial requests are immediate, including outside calling hours.
- Actual message delivery/read/failure tracking, courier control, fulfillment holds and partial prepayments are outside this feature.

The table refreshes every 30 seconds while visible. **Sync Shopify status** reads Shopify immediately and retries template preparation if a message is still queued. History is stored in the app; unrelated Shopify tags and order notes are preserved.

## Deployment prerequisites

1. Run `npm run setup` on the deployed app to generate Prisma and apply the migration. Back up the persistent SQLite database first as part of normal deployment.
2. Deploy the updated Shopify configuration and obtain the new `write_orders` grant. Ensure any deployment `SCOPES` override also contains `write_orders`. The new `orders/updated` subscription catches manual tag changes; the existing `orders/cancelled` subscription handles actual cancellation.
3. Set `WHATSAPP_APP_SECRET` to the **Meta application secret**, not the Shopify secret or webhook verify token. Existing Meta POST events now require a valid `x-hub-signature-256`; the GET verification token is unchanged.
4. Keep `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, and `WHATSAPP_VERIFY_TOKEN` configured. Subscribe the Meta app to WhatsApp `messages` webhooks at `/webhooks/whatsapp`.
5. Set up approved templates below and the business's applicable messaging consent process.
6. Configure an external scheduler to POST `/internal/sweep-cod-orders` every five minutes, passing `x-sweep-secret: <SWEEP_SECRET>`. Use HTTPS. This is a server endpoint, not a browser timer; opening the app does not schedule reminders. Each invocation processes up to 100 orders, rotating by last update time. Monitor scheduler failures and tune frequency for order volume; avoid overlapping long-running invocations.
7. Enable tracking from **COD orders**. Enabling checks permissions, credentials and approved template structures before accepting new COD orders.

No production settings, templates, scheduler, or store permissions are changed merely by adding these files.

## Templates

Template names and parameter mappings are defined in app code. They do not require environment variables:

| Template | Body variables in order |
|---|---|
| `cod_request` | First name, order number, items, delivery address |
| `cod_reminder` | First name, order number, items, delivery address |
| `order_confirmation_test` | Paused; excluded from COD enable checks and sends |
| `cod_cancelled` | First name, order number |

`cod_request`, `cod_reminder` and `cod_cancelled` have been submitted to Meta. The app checks approval before enabling or sending; submission alone does not allow sending. Template text stays in Meta, including the finalized cancellation wording. Templates use numbered body variables (`{{1}}`, `{{2}}`, etc.) in the order above. The approved template language is read from Meta. Legacy `COD_*_TEMPLATE` and `COD_*_PARAMS` settings are ignored and can be removed from the host.

`COD_GATEWAY_NAMES` remains an optional comma-separated list of exact COD gateway names; it defaults to `Cash on Delivery (COD),Cash on Delivery,COD,cash_on_delivery`. WhatsApp credentials and scheduler secrets remain environment settings.

Request and reminder templates must have exactly two quick-reply buttons: **YES or CONFIRM first**, **NO or CANCEL second**. Each payload contains the internal COD record and Shopify order ID. The cancellation template must have no buttons. The existing confirmation template is untouched and its buttons do not block enabling COD. Static text headers are supported; media headers, variable headers and named body parameters are not.

Plain text YES/CONFIRM/NO/CANCEL is accepted only when the customer uses WhatsApp's reply-to action on a tracked request/reminder. Unthreaded text is deliberately ignored because one phone can have multiple orders. Sender number, business phone ID, stored outbound message ID and button order identity must all match.

## Message acceptance and recovery

The table reports **Accepted by WhatsApp**, not delivered. Template setup errors for active messages remain queued and are retried on sync/sweep. Definitive API rejections and ambiguous timeouts are not automatically resent. A crash during a send can leave `sending`; inspect Meta before any operator reset to avoid duplicate messages. Previously queued confirmation messages stay paused even after sync, sweep, or re-enabling COD messaging. Order confirmation and YES/NO locks still take effect immediately.

Order-level database leases serialize incoming replies, staff actions and background work. Unique message records prevent duplicate request/reminder/confirmation/cancellation sends during ordinary webhook retries. The periodic sweep also reconciles missed Shopify update webhooks. External systems can still change orders concurrently; this feature does not control dispatch.

## Verification

Run `node --test tests/cod.test.mjs tests/cod-messages.test.mjs tests/whatsapp-template.test.mjs` for isolated database and mocked API tests. These tests apply SQL migrations to a temporary SQLite database; they do not contact customers or mutate a shop.

Before enabling production, test one COD order and one prepaid order, same-phone multiple orders, direct Shopify confirmation, both call outcomes, repeated YES/NO, Sunday reminder timing, and a manual Shopify cancellation with approved templates on the real WhatsApp number.
