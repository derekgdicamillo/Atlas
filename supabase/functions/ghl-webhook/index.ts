/**
 * GHL Webhook Receiver Edge Function
 *
 * Receives POST from GoHighLevel when events happen (contacts, opportunities,
 * appointments, messages, etc.). Stores events in ghl_events table and sends
 * Telegram alerts for high-priority events.
 *
 * URL: https://<project-ref>.supabase.co/functions/v1/ghl-webhook?secret=<GHL_WEBHOOK_SECRET>
 *
 * Secrets required:
 *   GHL_WEBHOOK_SECRET       -- shared secret for URL validation
 *   TELEGRAM_BOT_TOKEN       -- for sending alerts
 *   TELEGRAM_ALERT_CHAT_ID   -- Derek's Telegram user ID
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const HIGH_PRIORITY_EVENTS = new Set([
  "ContactCreate",
  "OpportunityCreate",
  "OpportunityStageUpdate",
  "OpportunityStatusUpdate",
  "InboundMessage",
  "AppointmentCreate",
]);

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // 1. Validate secret
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    const expectedSecret = Deno.env.get("GHL_WEBHOOK_SECRET");

    if (!expectedSecret || secret !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Parse payload
    const payload = await req.json();
    const eventType = payload.type || payload.event || "Unknown";

    // 3. Extract IDs from payload
    const contactId =
      payload.contactId || payload.contact_id || payload.contact?.id || null;
    const opportunityId =
      payload.opportunityId || payload.opportunity_id || payload.opportunity?.id || null;

    // 4. Store in Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const isHighPriority = HIGH_PRIORITY_EVENTS.has(eventType);

    const { error } = await supabase.from("ghl_events").insert({
      event_type: eventType,
      contact_id: contactId,
      opportunity_id: opportunityId,
      payload,
      processed: false,
      alerted: isHighPriority,
    });

    if (error) {
      console.error("Insert error:", error.message);
      return new Response(`DB error: ${error.message}`, { status: 500 });
    }

    // 5. Send Telegram alert for high-priority events
    if (isHighPriority) {
      const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
      const chatId = Deno.env.get("TELEGRAM_ALERT_CHAT_ID");

      if (botToken && chatId) {
        const alertText = formatAlert(eventType, payload, contactId);
        // Fire and forget -- don't block the webhook response
        fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: alertText,
            }),
          }
        ).catch((err) => console.error("Telegram alert failed:", err));
      }
    }

    // Log for observability
    supabase.from("logs").insert({
      level: "info",
      event: "ghl_webhook",
      message: `${eventType}${contactId ? ` contact=${contactId}` : ""}`,
      metadata: { event_type: eventType, contact_id: contactId, high_priority: isHighPriority },
    }).then(() => {});

    return new Response("ok");
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(String(error), { status: 500 });
  }
});

function formatAlert(
  eventType: string,
  payload: Record<string, unknown>,
  contactId: string | null
): string {
  const p = payload as Record<string, any>;
  const contactName =
    p.contact?.name ||
    p.contact?.firstName ||
    p.name ||
    p.full_name ||
    contactId ||
    "Unknown";

  switch (eventType) {
    case "ContactCreate":
      return `New contact: ${contactName}${p.source ? ` (${p.source})` : ""}`;

    case "OpportunityCreate":
      return `New opportunity: ${p.name || "Unknown"} (${contactName})`;

    case "OpportunityStageUpdate": {
      const stage = p.stage?.name || p.pipelineStageName || "unknown stage";
      return `Stage change: ${contactName} moved to "${stage}"`;
    }

    case "OpportunityStatusUpdate":
      return `Opportunity status: ${contactName} -> ${p.status || "unknown"}`;

    case "InboundMessage": {
      const body = (p.body || "").substring(0, 120);
      const msgType = p.messageType || p.type || "message";
      return `Inbound ${msgType} from ${contactName}: ${body}`;
    }

    case "AppointmentCreate": {
      const title = p.title || "Appointment";
      const start = p.startTime
        ? new Date(p.startTime).toLocaleString("en-US", {
            timeZone: "America/Phoenix",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })
        : "TBD";
      return `New appointment: ${title} at ${start}`;
    }

    default:
      return `GHL event: ${eventType}`;
  }
}
