/**
 * GHL Webhook Receiver Edge Function
 *
 * Receives POST from GoHighLevel workflow outbound webhooks.
 * Workflow webhooks send flat contact data + a workflow.name field.
 * We infer the event type from workflow.name (e.g. "Atlas - Appointment Booked").
 *
 * Also handles API-style webhooks that include a `type` field directly.
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

// Map workflow names to event types
const WORKFLOW_EVENT_MAP: Record<string, string> = {
  "Atlas - New Contact":            "ContactCreate",
  "Atlas - Appointment Booked":     "AppointmentCreate",
  "Atlas - Appointment Status":     "AppointmentUpdate",
  "Atlas - Pipeline Stage Change":  "OpportunityStageUpdate",
  "Atlas - Customer Reply":         "InboundMessage",
  "Atlas - Contact DND":            "ContactDndUpdate",
};

// Instant alert: sends Telegram message to PV GHL Alerts group immediately
const INSTANT_ALERT_EVENTS = new Set([
  "ContactCreate",        // New lead - act fast
  "ContactDndUpdate",     // Opted out - compliance critical
]);

// Silent store: saved to DB but no Telegram alert (check dashboard)
const SILENT_STORE_EVENTS = new Set([
  "AppointmentCreate",       // Bookings are good news, no urgency
  "InboundMessage",          // Replies handled in GHL conversations
  "OpportunityStageUpdate",  // Pipeline moves are routine
]);

// AppointmentUpdate gets special handling: cancel/no-show = instant, confirmed = silent

Deno.serve(async (req) => {
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

    // 3. Determine event type:
    //    - API webhooks: payload.type is set (e.g. "ContactCreate")
    //    - Workflow webhooks: payload.workflow.name maps to event type
    let eventType = payload.type || payload.event || null;
    if (!eventType && payload.workflow?.name) {
      eventType = WORKFLOW_EVENT_MAP[payload.workflow.name] || null;
    }
    if (!eventType) {
      eventType = "Unknown";
    }

    // 4. Extract IDs. Workflow webhooks use flat fields (contact_id, first_name).
    //    API webhooks may nest under contact/opportunity objects.
    //    Note: payload.id is intentionally excluded - it often contains workflow execution IDs,
    //    not contact IDs, which breaks deduplication.
    const contactId =
      payload.contact_id || payload.contactId || payload.contact?.id || null;
    const opportunityId =
      payload.opportunity_id || payload.opportunityId || payload.opportunity?.id || null;

    // 5. Store in Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Determine if this event should trigger an instant Telegram alert
    let shouldAlert = INSTANT_ALERT_EVENTS.has(eventType);

    // AppointmentUpdate: only alert on cancel/no-show, not confirmations
    if (eventType === "AppointmentUpdate") {
      const appt = payload.appointment || payload.triggerData || {};
      const status = (appt.appointmentStatus || appt.status || payload.appointment_status || "").toLowerCase();
      shouldAlert = ["cancelled", "canceled", "no_show", "no-show", "noshow"].includes(status);
    }

    // Dedup: skip alert if same contact+event already alerted in the last 30 min.
    // GHL workflows and form resubmits can fire multiple events for the same person.
    // Two-layer dedup: try contact_id first, then fall back to name matching in payload JSONB.
    if (shouldAlert) {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      let isDup = false;

      // Layer 1: contact_id match
      if (contactId) {
        const { data: recent } = await supabase
          .from("ghl_events")
          .select("id")
          .eq("contact_id", contactId)
          .eq("event_type", eventType)
          .eq("alerted", true)
          .gte("created_at", cutoff)
          .limit(1);
        if (recent?.length) isDup = true;
      }

      // Layer 2: name match from payload JSONB (handles null/different contact_id)
      if (!isDup) {
        const contactName =
          payload.full_name ||
          [payload.first_name, payload.last_name].filter(Boolean).join(" ") ||
          null;
        if (contactName) {
          // Try full_name match first
          const { data: r1 } = await supabase
            .from("ghl_events")
            .select("id")
            .eq("event_type", eventType)
            .eq("alerted", true)
            .gte("created_at", cutoff)
            .filter("payload->>full_name", "eq", contactName)
            .limit(1);
          if (r1?.length) {
            isDup = true;
          } else if (payload.first_name) {
            // Fall back to first_name + last_name match
            const { data: r2 } = await supabase
              .from("ghl_events")
              .select("id")
              .eq("event_type", eventType)
              .eq("alerted", true)
              .gte("created_at", cutoff)
              .filter("payload->>first_name", "eq", payload.first_name)
              .filter("payload->>last_name", "eq", payload.last_name || "")
              .limit(1);
            if (r2?.length) isDup = true;
          }
        }
      }

      if (isDup) shouldAlert = false;
    }

    const { error } = await supabase.from("ghl_events").insert({
      event_type: eventType,
      contact_id: contactId,
      opportunity_id: opportunityId,
      payload,
      processed: false,
      alerted: shouldAlert,
    });

    if (error) {
      console.error("Insert error:", error.message);
      return new Response(`DB error: ${error.message}`, { status: 500 });
    }

    // 6. Send Telegram alert to PV GHL Alerts group for instant-tier events
    if (shouldAlert) {
      const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
      const chatId = Deno.env.get("TELEGRAM_GHL_ALERT_CHAT_ID");

      if (botToken && chatId) {
        const alertText = formatAlert(eventType, payload, contactId);
        fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: alertText }),
          }
        ).catch((err) => console.error("Telegram alert failed:", err));
      }
    }

    // Log for observability
    supabase.from("logs").insert({
      level: "info",
      event: "ghl_webhook",
      message: `${eventType}${contactId ? ` contact=${contactId}` : ""}`,
      metadata: { event_type: eventType, contact_id: contactId, high_priority: shouldAlert },
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

  // Workflow webhooks: contact data is flat (first_name, last_name, full_name)
  // API webhooks: may be nested under contact object
  const contactName =
    p.full_name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    p.contact?.name ||
    p.contact?.firstName ||
    p.name ||
    contactId ||
    "Unknown";

  const source = p.contact_source || p.source || "";

  switch (eventType) {
    case "ContactCreate":
      return `New lead: ${contactName}${source ? ` (${source})` : ""}`;

    case "AppointmentCreate": {
      // Workflow: appointment data in triggerData or flat fields
      const appt = p.appointment || p.triggerData || {};
      const title = appt.title || p.title || "Appointment";
      const startRaw = appt.startTime || p.startTime;
      const start = startRaw
        ? new Date(startRaw).toLocaleString("en-US", {
            timeZone: "America/Phoenix",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })
        : "";
      return `Appointment booked: ${contactName}${start ? ` at ${start}` : ""}${title !== "Appointment" ? ` (${title})` : ""}`;
    }

    case "AppointmentUpdate": {
      const appt = p.appointment || p.triggerData || {};
      const status = appt.appointmentStatus || appt.status || p.appointment_status || "updated";
      const startRaw = appt.startTime || p.startTime;
      const start = startRaw
        ? new Date(startRaw).toLocaleString("en-US", {
            timeZone: "America/Phoenix",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })
        : "";
      return `Appointment ${status}: ${contactName}${start ? ` (${start})` : ""}`;
    }

    case "OpportunityStageUpdate": {
      const stage =
        p.stage?.name || p.pipelineStageName || p.triggerData?.pipelineStageName || "unknown stage";
      return `Pipeline move: ${contactName} -> "${stage}"`;
    }

    case "InboundMessage": {
      const body = (p.body || p.message || "").substring(0, 120);
      const msgType = p.messageType || "message";
      return `Reply from ${contactName} (${msgType}): ${body}`;
    }

    case "ContactDndUpdate": {
      const dnd = p.dnd ?? p.dndSettings;
      const status = dnd === true || dnd?.SMS?.status === "active" ? "opted OUT" : "opted back IN";
      return `DND: ${contactName} ${status}`;
    }

    default:
      return `GHL event: ${eventType} (${contactName})`;
  }
}
