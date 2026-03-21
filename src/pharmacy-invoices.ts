/**
 * Pharmacy & Lab Invoice Processor
 *
 * Pulls invoices from theoffice@pvmedispa.com, parses PDFs,
 * classifies line items by department, detects price changes
 * and duplicate charges, saves to OneDrive, and sends a Telegram summary.
 *
 * Sources:
 *   - Partell/NHRx (Notifications@RxLocal.com) — daily cumulative Sales Detail Reports
 *   - Hallandale (billing@hallandalerx.com) — individual invoice PDFs
 *
 * NEVER sends email from theoffice@pvmedispa.com. Read-only access.
 */

import { listMessages, listAttachments, getAttachment, type M365Message, type M365Attachment } from "./m365.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";

// pdf-parse v2 API
const { PDFParse } = require("pdf-parse");

// ============================================================
// TYPES
// ============================================================

export interface InvoiceLineItem {
  date: string;            // YYYY-MM-DD
  receiptId: string;       // receipt/order number
  rxNumber?: string;       // Rx number if patient-specific
  patientName?: string;    // patient name if present
  medication: string;      // medication/item name
  quantity: number;
  unitPrice: number;       // per-unit price
  amount: number;          // line total
  category: "weight-loss" | "mens-health" | "womens-health" | "aesthetics" | "vitality-unchained" | "supplies" | "shipping" | "payment" | "other";
  source: "partell" | "hallandale" | "lab";
  invoiceNumber?: string;
}

export interface Invoice {
  id: string;              // email message ID (for dedup)
  source: "partell" | "hallandale" | "lab";
  invoiceNumber?: string;
  date: string;            // email received date
  subject: string;
  total: number;
  lineItems: InvoiceLineItem[];
  pdfFileName: string;
  savedPath?: string;      // OneDrive path after save
}

export interface PriceAlert {
  medication: string;
  oldPrice: number;
  newPrice: number;
  changePercent: number;
  source: string;
  date: string;
}

export interface DuplicateAlert {
  patientName: string;
  medication: string;
  date: string;
  amount: number;
  occurrences: number;
  invoiceIds: string[];
}

export interface ProcessorResult {
  invoicesProcessed: number;
  lineItemsTotal: number;
  totalAmount: number;
  paymentsApplied: number;
  byCategory: Record<string, { count: number; amount: number }>;
  priceAlerts: PriceAlert[];
  duplicateAlerts: DuplicateAlert[];
  errors: string[];
}

// ============================================================
// CONSTANTS
// ============================================================

const MAILBOX = "theoffice@pvmedispa.com";
const ONEDRIVE_BASE = "C:\\Users\\Derek DiCamillo\\OneDrive - PV MEDISPA LLC\\04_Finance\\Pharmacy Invoices";
const DATA_DIR = join(process.cwd(), "data");
const BASELINE_FILE = join(DATA_DIR, "pharmacy-baseline.json");
const STATE_FILE = join(DATA_DIR, "pharmacy-invoice-state.json");

// Medication -> department classification rules
const WEIGHT_LOSS_MEDS = [
  "tirzepatide", "semaglutide", "liraglutide", "glp-1", "glp1",
  "b12", "methylcobalamin", "mic", "lipo", "bioboost",
  "tirz", "sema",  // Partell abbreviated forms in bulk orders
];

const MENS_HEALTH_MEDS = [
  "testosterone", "cypionate", "enanthate", "clomiphene", "clomid",
  "anastrozole", "arimidex", "hcg", "pregnyl", "gonadorelin",
  "tadalafil", "sildenafil", "pt-141",
];

const WOMENS_HEALTH_MEDS = [
  "estradiol", "progesterone", "estriol", "dhea", "oxytocin",
  "biest", "triest",
];

const AESTHETICS_MEDS = [
  "botox", "dysport", "filler", "hyaluronidase", "sculptra",
  "biostimulator", "prp",
];

const VITALITY_UNCHAINED_MEDS = [
  "nad", "nicotinamide", "methylene blue", "naltrexone",
];

// Known female-gendered first names for gender inference when not otherwise clear
const FEMALE_NAMES = new Set([
  "esther", "victoria", "ann", "lisa", "sheila", "danette", "danna",
  "nancy", "onalee", "maria", "sarah", "darlene", "sha", "amanda",
  "heidi", "missy", "sue", "aimee", "deavin", "judith", "lynette",
  "amber", "audra", "jessica", "jennifer", "michelle", "nicole",
  "patricia", "mary", "linda", "barbara", "elizabeth", "susan",
  "margaret", "dorothy", "karen", "betty", "ruth", "helen", "sandra",
  "donna", "carol", "diane", "janet", "catherine", "deborah",
]);

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface ProcessorState {
  processedEmailIds: string[];
  lastRunDate: string;
}

function loadState(): ProcessorState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return { processedEmailIds: [], lastRunDate: "" };
}

function saveState(state: ProcessorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// PRICE BASELINE
// ============================================================

interface PriceBaseline {
  [medication: string]: {
    price: number;
    lastSeen: string;
    source: string;
  };
}

function loadBaseline(): PriceBaseline {
  if (existsSync(BASELINE_FILE)) {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  }
  return {};
}

function saveBaseline(baseline: PriceBaseline): void {
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

// ============================================================
// MEDICATION CLASSIFICATION
// ============================================================

function classifyMedication(
  medName: string,
  patientName?: string
): InvoiceLineItem["category"] {
  const lower = medName.toLowerCase();

  if (lower.includes("ship") || lower === "shipping" || lower.includes("fedex") || lower.includes("overnight")) {
    return "shipping";
  }
  if (lower.includes("supplies") || lower.includes("supply")) {
    return "supplies";
  }
  if (lower.includes("a/r payment") || lower.includes("payment")) {
    return "payment";
  }

  // Check medication category
  if (WEIGHT_LOSS_MEDS.some(m => lower.includes(m))) return "weight-loss";
  if (AESTHETICS_MEDS.some(m => lower.includes(m))) return "aesthetics";

  // For testosterone-related, check patient gender
  if (MENS_HEALTH_MEDS.some(m => lower.includes(m))) {
    // If we have a patient name and it's a known female name, classify as womens-health
    if (patientName) {
      const firstName = patientName.split(/[,\s]+/).filter(Boolean).pop()?.toLowerCase() || "";
      if (FEMALE_NAMES.has(firstName)) return "womens-health";
    }
    return "mens-health";
  }

  if (WOMENS_HEALTH_MEDS.some(m => lower.includes(m))) return "womens-health";

  // Vitality Unchained: NAD+, methylene blue, naltrexone (low-dose)
  if (VITALITY_UNCHAINED_MEDS.some(m => lower.includes(m))) return "vitality-unchained";

  // Lab services
  if (lower.includes("lab service") || lower.includes("lab fee")) return "other"; // classified but recognized

  // Bare concentration patterns from Partell PDFs where drug name was truncated.
  // Map known concentration/vial patterns to their drug category:
  //   Tirzepatide: 60mg/4ml, 30mg/3ml, 68mg, 40mg
  //   Semaglutide: 10mg/4ml, 5mg/2ml, 2.5mg, 10mg
  //   B12/MIC: /b6, b6 (trailing from "B12/B6")
  const concLower = lower.replace(/\s+/g, "");
  if (/(?:60mg|30mg\/3ml|68mg|40mg\/|60mg\/4ml)/.test(concLower)) return "weight-loss"; // tirzepatide
  if (/(?:10mg\/4ml|5mg\/2ml|2\.5mg)/.test(concLower)) return "weight-loss"; // semaglutide
  if (/\/b6|b12\/b6/.test(concLower)) return "weight-loss"; // B12/B6 injection

  // Testosterone bare concentrations (100mg/ml, 200mg/ml)
  if (/(?:100mg\/ml|200mg\/ml)\s*(?:10ml|5ml)?/.test(concLower)) return "mens-health";

  return "other";
}

// ============================================================
// PDF PARSING — PARTELL
// ============================================================

function parsePartellPDF(text: string, emailDate: string, emailId: string): InvoiceLineItem[] {
  const items: InvoiceLineItem[] = [];

  // Split into lines and process
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Partell format: lines contain date, receipt, amount, tracking, medication info
  // Pattern: MM/DD/YYYY NNNNNN $amount [tracking] medication/patient info
  // Some lines are continuations (wrapped medication names, patient names)

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip page headers/footers
    if (line.startsWith("Tracking Number") || line.startsWith("National Health") ||
        line.startsWith("Sales Detail") || line.startsWith("Account:") ||
        line.startsWith("Printed On:") || line.match(/^-- \d+ of \d+ --$/)) {
      i++;
      continue;
    }

    // Match main data line: date receipt $amount [tracking] item
    const mainMatch = line.match(
      /^(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+\$([0-9,.]+)\s*([A-Z0-9]+)?\s*(.*)/
    );

    if (mainMatch) {
      const [, dateStr, receiptId, amountStr, tracking, rest] = mainMatch;
      const amount = parseFloat(amountStr.replace(",", ""));
      const dateParts = dateStr.split("/");
      const isoDate = `${dateParts[2]}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;

      // Collect continuation lines
      let fullText = rest || "";
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        // Stop if it's a new data line or header
        if (nextLine.match(/^\d{2}\/\d{2}\/\d{4}\s+\d+/) ||
            nextLine.startsWith("Tracking Number") ||
            nextLine.startsWith("National Health") ||
            nextLine.match(/^-- \d+ of \d+ --$/)) {
          break;
        }
        fullText += " " + nextLine;
        j++;
      }

      fullText = fullText.trim();

      // Parse patient and medication from the full text
      // Patient pattern: NNNNNNNNN-NN - FIRSTNAME LASTNAME
      const patientMatch = fullText.match(/(\d{8,}-\d{2})\s*-\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
      let patientName = patientMatch ? patientMatch[2] : undefined;
      let rxNumber = patientMatch ? patientMatch[1] : undefined;

      // Extract medication name
      let medication = fullText;
      if (patientMatch) {
        // Medication is typically after the patient name
        const afterPatient = fullText.substring(fullText.indexOf(patientMatch[0]) + patientMatch[0].length).trim();
        medication = afterPatient || fullText.replace(patientMatch[0], "").trim();
      }

      // Clean up medication name - remove quantity info like "(QTY 5)", "X 3", "x 10 x $290"
      let quantity = 1;
      const qtyMatch = medication.match(/\(QTY\s*(\d+)\)/i) || fullText.match(/\(QTY\s*(\d+)\)/i);
      if (qtyMatch) {
        quantity = parseInt(qtyMatch[1]);
      } else {
        // Bulk order: "VIAL X 3", "x 10 x $290", "x 15 x $$290"
        const bulkMatch = fullText.match(/\bx\s*(\d+)\s*(?:x\s*\$?\$?\d|$)/i);
        if (bulkMatch) quantity = parseInt(bulkMatch[1]);
      }
      medication = medication
        .replace(/\(QTY\s*\d+\)/gi, "")
        .replace(/\s*x\s*\d+\s*(?:x\s*\$?\$?[\d,.]+(?:\s*=\s*\$?[\d,.]+)?)?$/i, "")
        .replace(/:\s*\$[\d,.]+(?:\s*=\s*\$?[\d,.]+)?$/i, "")  // strip ": $290 = $4350"
        .replace(/\s*x\s*\$?\$?[\d,.]+(?:\s*=\s*\$?[\d,.]+)?$/i, "")  // strip "x $$290 = $2900"
        .trim();

      // If medication is empty, try to extract from fullText
      if (!medication || medication.length < 3) {
        medication = fullText
          .replace(/\d{8,}-\d{2}\s*-\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*/g, "")
          .replace(/\(QTY\s*\d+\)/gi, "")
          .trim();
      }

      // For bulk orders (no patient), medication is the whole text
      if (!patientName && fullText.includes("SHIP")) {
        medication = "SHIPPING";
      } else if (!patientName && fullText.includes("SUPPLIES")) {
        medication = "SUPPLIES";
      } else if (!patientName && fullText.includes("A/R Payment")) {
        medication = "A/R Payment";
      }

      const unitPrice = quantity > 1 ? amount / quantity : amount;

      items.push({
        date: isoDate,
        receiptId,
        rxNumber,
        patientName,
        medication: medication || "UNKNOWN",
        quantity,
        unitPrice,
        amount,
        category: classifyMedication(medication || fullText, patientName),
        source: "partell",
      });

      i = j;
    } else {
      i++;
    }
  }

  return items;
}

// ============================================================
// PDF PARSING — HALLANDALE
// ============================================================

function parseHallandalePDF(text: string, emailDate: string, emailId: string): { lineItems: InvoiceLineItem[]; invoiceNumber: string } {
  const items: InvoiceLineItem[] = [];
  let invoiceNumber = "";

  // Extract invoice number
  const invMatch = text.match(/#(\d+)/);
  if (invMatch) invoiceNumber = invMatch[1];

  // Extract total
  // const totalMatch = text.match(/TOTAL\s*\$\s*([0-9,.]+)/);

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Find the line items section (starts after the column header line)
  let inItems = false;
  let currentItem: Partial<InvoiceLineItem> = {};
  let accumulatingDescription = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Header line detection
    if (line.startsWith("Date") && line.includes("Order") && line.includes("Patient")) {
      inItems = true;
      continue;
    }

    if (!inItems) continue;

    // Stop at TOTAL line
    if (line.startsWith("TOTAL") || line.startsWith("Please Note:") || line.match(/^-- \d+ of \d+ --$/)) {
      if (currentItem.medication) {
        items.push(currentItem as InvoiceLineItem);
        currentItem = {};
      }
      if (line.startsWith("TOTAL")) break;
      continue;
    }

    // Subtotal line
    if (line.startsWith("Subtotal")) {
      if (currentItem.medication) {
        items.push(currentItem as InvoiceLineItem);
        currentItem = {};
      }
      accumulatingDescription = false;
      continue;
    }

    // New line item starts with a date
    const dateLineMatch = line.match(/^(\d{2}\/\d{2}\/\d{2,4})\s+(\d+)\s+(\d+)/);
    if (dateLineMatch) {
      // Save previous item
      if (currentItem.medication) {
        items.push(currentItem as InvoiceLineItem);
      }

      const [, dateStr, orderId, rxNum] = dateLineMatch;
      const dateParts = dateStr.split("/");
      let year = dateParts[2];
      if (year.length === 2) year = "20" + year;
      const isoDate = `${year}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;

      currentItem = {
        date: isoDate,
        receiptId: orderId,
        rxNumber: rxNum,
        medication: "",
        quantity: 1,
        unitPrice: 0,
        amount: 0,
        category: "other",
        source: "hallandale",
        invoiceNumber,
      };
      accumulatingDescription = true;
      continue;
    }

    // Order shipping line (no Rx number)
    const orderShipMatch = line.match(/^(\d+)\s*$/);
    if (orderShipMatch && accumulatingDescription) {
      // This might be an order number for a shipping line
      continue;
    }

    // Shipping line
    if (line.includes("FEDEX") || line.includes("OVERNIGHT") || line.includes("SHIPPING") || line.includes("Order #")) {
      if (currentItem.medication) {
        items.push(currentItem as InvoiceLineItem);
      }
      // Look for price on this or next line
      const priceMatch = line.match(/\$\s*([0-9,.]+)/);
      let shippingAmount = 0;
      if (priceMatch) {
        shippingAmount = parseFloat(priceMatch[1].replace(",", ""));
      } else {
        // Check next line for price
        const nextLine = lines[i + 1] || "";
        const nextPrice = nextLine.match(/\$\s*([0-9,.]+)/);
        if (nextPrice) shippingAmount = parseFloat(nextPrice[1].replace(",", ""));
      }

      currentItem = {
        date: currentItem.date || emailDate,
        receiptId: currentItem.receiptId || "",
        medication: "SHIPPING",
        quantity: 1,
        unitPrice: shippingAmount,
        amount: shippingAmount,
        category: "shipping",
        source: "hallandale",
        invoiceNumber,
      };
      items.push(currentItem as InvoiceLineItem);
      currentItem = {};
      accumulatingDescription = false;
      continue;
    }

    // Patient name line (e.g., "DiCamillo," or "Pettinger,")
    if (accumulatingDescription && line.match(/^[A-Z][a-z]+,$/)) {
      // Next line has rest of name
      const nextLine = lines[i + 1] || "";
      currentItem.patientName = `${nextLine.trim()} ${line.replace(",", "")}`.trim();
      i++;
      continue;
    }

    // Description continuation - medication/Rx details
    if (accumulatingDescription && currentItem.receiptId) {
      // Check if line has price at the end: qty $ price $ total
      const priceMatch = line.match(/(\d+)\s+\$\s*([0-9,.]+)\s+\$\s*([0-9,.]+)$/);
      if (priceMatch) {
        currentItem.quantity = parseInt(priceMatch[1]);
        currentItem.unitPrice = parseFloat(priceMatch[2].replace(",", ""));
        currentItem.amount = parseFloat(priceMatch[3].replace(",", ""));
        currentItem.medication = (currentItem.medication || "").trim();
        currentItem.category = classifyMedication(currentItem.medication || "", currentItem.patientName);
        continue;
      }

      // Single price match (e.g., "1 $ 120.00 	$ 120.00")
      // This catches "DiCamillo,\nDerek 1 $ 120.00 	$ 120.00" patterns
      const singlePriceMatch = line.match(/(\w+)\s+(\d+)\s+\$\s*([0-9,.]+)\s+\$\s*([0-9,.]+)$/);
      if (singlePriceMatch) {
        if (!currentItem.patientName) {
          currentItem.patientName = singlePriceMatch[1];
        }
        currentItem.quantity = parseInt(singlePriceMatch[2]);
        currentItem.unitPrice = parseFloat(singlePriceMatch[3].replace(",", ""));
        currentItem.amount = parseFloat(singlePriceMatch[4].replace(",", ""));
        currentItem.medication = (currentItem.medication || "").trim();
        currentItem.category = classifyMedication(currentItem.medication || "", currentItem.patientName);
        continue;
      }

      // Pure description line
      if (line.startsWith("RX") || line.includes("MG") || line.includes("ML") || line.includes("Qty")) {
        // Extract medication details
        const rxMatch = line.match(/RX\s+\d+\s+\(Order\s+#\d+\)\s+(.*)/);
        if (rxMatch) {
          currentItem.medication = rxMatch[1];
        } else {
          currentItem.medication = ((currentItem.medication || "") + " " + line).trim();
        }
      } else if (!line.match(/^\d/) && line.length > 2) {
        // Continuation of description
        currentItem.medication = ((currentItem.medication || "") + " " + line).trim();
      }
    }
  }

  // Push last item
  if (currentItem.medication && currentItem.amount) {
    items.push(currentItem as InvoiceLineItem);
  }

  // Clean up medication names
  for (const item of items) {
    if (item.medication) {
      item.medication = item.medication
        .replace(/\(Order\s+#\d+\)/g, "")
        .replace(/\(Fill ID:\s*\d+\)/g, "")
        .replace(/\(Formula ID:\s*\d+\)/g, "")
        .replace(/RX\s+\d+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  // Filter out incomplete items (no amount or medication is just a patient name)
  const validItems = items.filter(item => item.amount > 0 && item.medication.length > 2);

  return { lineItems: validItems, invoiceNumber };
}

// ============================================================
// HTML BODY PARSING — HALLANDALE (fallback when no PDF)
// ============================================================

function parseHallandaleHTML(htmlBody: string, emailDate: string): { lineItems: InvoiceLineItem[]; invoiceNumber: string } {
  const items: InvoiceLineItem[] = [];
  let invoiceNumber = "";

  // Strip HTML tags, decode entities
  const text = htmlBody
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract invoice number
  const invMatch = text.match(/Invoice\s*#:\s*(\d+)/i);
  if (invMatch) invoiceNumber = invMatch[1];

  // Extract total
  const totalMatch = text.match(/Amount Due\s*:\s*\$\s*([0-9,.]+)/i);

  // Parse line items from the body text
  // Pattern: OrderID RX RXNUM MEDICATION (Qty: N) (Patient: LAST, FIRST) $ AMOUNT
  const rxPattern = /(\d{9,})\s+RX\s+(\d+)\s+(.*?)\(Qty:\s*(\d+)\)\s*\(Patient:\s*([^)]+)\)\s*\$\s*([0-9,.]+)/g;
  let match;

  while ((match = rxPattern.exec(text)) !== null) {
    const [, orderId, rxNum, medDescription, qty, patientInitials, amount] = match;

    const medication = medDescription
      .replace(/\(Formula ID:\s*\d+\)/g, "")
      .replace(/\(Fill ID:\s*\d+\)/g, "")
      .replace(/\(Order\s*#\d+\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const parsedAmount = parseFloat(amount.replace(",", ""));
    const parsedQty = parseInt(qty);

    items.push({
      date: emailDate,
      receiptId: orderId,
      rxNumber: rxNum,
      patientName: patientInitials.trim(),
      medication,
      quantity: parsedQty,
      unitPrice: parsedQty > 0 ? parsedAmount / parsedQty : parsedAmount,
      amount: parsedAmount,
      category: classifyMedication(medication, patientInitials),
      source: "hallandale",
      invoiceNumber,
    });
  }

  // Also catch shipping lines: "OrderID Shipping $ AMOUNT"
  const shipPattern = /(\d{9,})\s+Shipping\s+\$\s*([0-9,.]+)/g;
  while ((match = shipPattern.exec(text)) !== null) {
    const [, orderId, amount] = match;
    const parsedAmount = parseFloat(amount.replace(",", ""));
    items.push({
      date: emailDate,
      receiptId: orderId,
      medication: "SHIPPING",
      quantity: 1,
      unitPrice: parsedAmount,
      amount: parsedAmount,
      category: "shipping",
      source: "hallandale",
      invoiceNumber,
    });
  }

  return { lineItems: items, invoiceNumber };
}

// ============================================================
// EMAIL FETCHING & ATTACHMENT DOWNLOAD
// ============================================================

async function fetchInvoiceEmails(lookbackDays: number): Promise<M365Message[]> {
  const allMessages: M365Message[] = [];
  const seen = new Set<string>();

  // Search patterns for pharmacy and lab invoices
  const searchQueries = [
    "from:Notifications@RxLocal.com",           // Partell/NHRx
    "from:billing@hallandalerx.com",             // Hallandale
    "from:hallandalepharmacy.com",               // Hallandale alt
    "from:authorize.net Access Medical Labs",    // Lab invoices via Authorize.net
  ];

  // Also dedup by subject+date to avoid duplicate folder copies
  const seenSubjectDate = new Set<string>();

  for (const query of searchQueries) {
    try {
      // Graph API $search returns max 250 results, paginate if needed
      const messages = await listMessages(MAILBOX, {
        search: query,
        top: 250,
        select: "id,subject,bodyPreview,from,receivedDateTime,isRead,importance,hasAttachments",
      });

      for (const msg of messages) {
        // Dedup by message ID (same email appears in multiple folders)
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);

        // Dedup by subject+date (same email in different folders has different IDs)
        const subjectDateKey = `${msg.subject}|${msg.receivedDateTime.split("T")[0]}`;
        if (seenSubjectDate.has(subjectDateKey)) continue;
        seenSubjectDate.add(subjectDateKey);

        // Filter by date
        const received = new Date(msg.receivedDateTime);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - lookbackDays);

        if (received >= cutoff) {
          allMessages.push(msg);
        }
      }
    } catch (err) {
      console.error(`[pharmacy] Error searching "${query}": ${err}`);
    }
  }

  return allMessages.sort(
    (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime()
  );
}

async function downloadPDFAttachment(
  messageId: string
): Promise<{ name: string; data: Buffer } | null> {
  try {
    const attachments = await listAttachments(MAILBOX, messageId);
    const pdf = attachments.find(
      a => a.name?.toLowerCase().endsWith(".pdf") && !a.isInline
    );

    if (!pdf) return null;

    // If contentBytes already present
    if (pdf.contentBytes) {
      return { name: pdf.name, data: Buffer.from(pdf.contentBytes, "base64") };
    }

    // Fetch full attachment with content
    const full = await getAttachment(MAILBOX, messageId, pdf.id);
    if (full.contentBytes) {
      return { name: full.name, data: Buffer.from(full.contentBytes, "base64") };
    }

    return null;
  } catch (err) {
    console.error(`[pharmacy] Error downloading attachment for ${messageId}: ${err}`);
    return null;
  }
}

// ============================================================
// INVOICE PROCESSING
// ============================================================

async function processEmail(msg: M365Message): Promise<Invoice | null> {
  const from = msg.from?.emailAddress?.address?.toLowerCase() || "";
  const receivedDate = msg.receivedDateTime.split("T")[0];

  // Handle Authorize.net lab receipts (no PDF, amount in subject)
  if (from.includes("authorize.net") && msg.subject.includes("Access Medical Labs")) {
    return processLabReceipt(msg, receivedDate);
  }

  // Download PDF attachment
  const pdf = await downloadPDFAttachment(msg.id);

  let lineItems: InvoiceLineItem[] = [];
  let invoiceNumber: string | undefined;
  let pdfFileName = "none";

  if (pdf) {
    pdfFileName = pdf.name;

    // Parse PDF text
    let pdfText: string;
    try {
      const parser = new PDFParse({ data: new Uint8Array(pdf.data), verbosity: 0 });
      const result = await parser.getText();
      pdfText = result.text;
    } catch (err) {
      console.error(`[pharmacy] PDF parse failed for ${pdf.name}: ${err}`);
      pdfText = "";
    }

    if (pdfText) {
      if (from.includes("rxlocal") || from.includes("partell") || from.includes("nhrx")) {
        lineItems = parsePartellPDF(pdfText, receivedDate, msg.id);
      } else if (from.includes("hallandale")) {
        const result = parseHallandalePDF(pdfText, receivedDate, msg.id);
        lineItems = result.lineItems;
        invoiceNumber = result.invoiceNumber;
      } else {
        const hallResult = parseHallandalePDF(pdfText, receivedDate, msg.id);
        if (hallResult.lineItems.length > 0) {
          lineItems = hallResult.lineItems;
          invoiceNumber = hallResult.invoiceNumber;
        } else {
          lineItems = parsePartellPDF(pdfText, receivedDate, msg.id);
        }
      }
    }
  }

  // Fallback: parse HTML body for Hallandale invoices without PDF
  if (lineItems.length === 0 && from.includes("hallandale")) {
    try {
      const { getMessage } = require("./m365.ts");
      const full = await getMessage(MAILBOX, msg.id);
      if (full.body?.content) {
        const result = parseHallandaleHTML(full.body.content, receivedDate);
        lineItems = result.lineItems;
        invoiceNumber = result.invoiceNumber;
        pdfFileName = "html-body";
      }
    } catch (err) {
      console.error(`[pharmacy] HTML body parse failed for ${msg.subject}: ${err}`);
    }
  }

  if (lineItems.length === 0) {
    console.log(`[pharmacy] No parseable content in: ${msg.subject}`);
    return null;
  }

  const source = from.includes("rxlocal") || from.includes("partell") || from.includes("nhrx")
    ? "partell" as const
    : from.includes("hallandale")
      ? "hallandale" as const
      : "lab" as const;

  const total = lineItems.reduce((sum, item) => sum + item.amount, 0);

  return {
    id: msg.id,
    source,
    invoiceNumber,
    date: receivedDate,
    subject: msg.subject,
    total,
    lineItems,
    pdfFileName,
  };
}

/** Process Access Medical Labs transaction receipts from Authorize.net */
async function processLabReceipt(msg: M365Message, receivedDate: string): Promise<Invoice | null> {
  // Extract amount from subject: "Transaction Receipt from Access Medical Labs, Inc for $753.81 (USD)"
  const amountMatch = msg.subject.match(/\$([0-9,.]+)/);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(",", ""));

  // Try to get invoice number from email body
  let invoiceNumber: string | undefined;
  try {
    const { getMessage } = require("./m365.ts");
    const full = await getMessage(MAILBOX, msg.id);
    const body = full.body?.content || "";
    const invMatch = body.match(/Invoice Number[^<]*?(\d+_\d+)/i) || body.match(/Invoice.*?(\d{5,})/i);
    if (invMatch) invoiceNumber = invMatch[1];
  } catch {
    // Non-fatal, just won't have invoice number
  }

  return {
    id: msg.id,
    source: "lab",
    invoiceNumber,
    date: receivedDate,
    subject: msg.subject,
    total: amount,
    lineItems: [{
      date: receivedDate,
      receiptId: invoiceNumber || msg.id.substring(0, 12),
      medication: "Lab Services (Access Medical Labs)",
      quantity: 1,
      unitPrice: amount,
      amount,
      category: "other",
      source: "lab",
      invoiceNumber,
    }],
    pdfFileName: "none (email receipt)",
  };
}

// ============================================================
// PRICE CHANGE DETECTION
// ============================================================

// All known drug keywords across all categories (for baseline key anchoring)
const ALL_DRUG_KEYWORDS = [
  ...WEIGHT_LOSS_MEDS, ...MENS_HEALTH_MEDS, ...WOMENS_HEALTH_MEDS,
  ...AESTHETICS_MEDS, ...VITALITY_UNCHAINED_MEDS,
].sort((a, b) => b.length - a.length); // longest first for greedy matching

/**
 * Normalize a medication name into a stable baseline key.
 * Anchors on a known drug keyword, then appends concentration info.
 * Returns null if no identifiable drug found (skip price tracking).
 *
 * Examples:
 *   "TIRZEPATIDE 60MG/4ML VIAL (QTY 5)" -> "TIRZEPATIDE 60MG/4ML"
 *   "SEMAGLUTIDE 10MG/4ML VIAL" -> "SEMAGLUTIDE 10MG/4ML"
 *   "TIRZEPATIDE /METHYLCOBALAMIN 34MG/2ML" -> "TIRZEPATIDE/METHYLCOBALAMIN 34MG/2ML"
 *   "BIOBOOST (FORMULA #3) 10ML VIAL" -> "BIOBOOST"
 */
function normalizeBaselineKey(medName: string): string | null {
  // Strip leading punctuation/slashes (Hallandale compound drugs sometimes start with "/")
  // Strip embedded pricing text ($290, = $4350, x $$290 = $2900)
  const upper = medName.toUpperCase()
    .replace(/^[/\s]+/, "")
    .replace(/\$\$?\s*[\d,.]+/g, "")       // strip $290, $$290
    .replace(/=\s*[\d,.]+/g, "")           // strip = 4350
    .replace(/:\s*$/g, "")                 // trailing colons
    .replace(/\s+/g, " ")
    .trim();

  // Find the first known drug keyword. Short keywords (<5 chars) require word boundaries
  // to avoid matching patient names or text fragments.
  let drugIdx = -1;
  let drugMatch = "";
  for (const drug of ALL_DRUG_KEYWORDS) {
    const drugUpper = drug.toUpperCase();
    let idx: number;
    if (drug.length < 5) {
      // Word boundary match for short keywords (b12, mic, nad, prp, tirz, sema, etc.)
      const re = new RegExp(`\\b${drugUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const m = re.exec(upper);
      idx = m ? m.index : -1;
    } else {
      idx = upper.indexOf(drugUpper);
    }
    if (idx >= 0 && (drugIdx < 0 || idx < drugIdx)) {
      drugIdx = idx;
      drugMatch = drugUpper;
    }
  }

  if (drugIdx < 0) return null;

  // Start from the drug keyword
  const rest = upper.substring(drugIdx);

  // Step 1: Expand abbreviations to canonical names
  const ABBREV_MAP: Record<string, string> = {
    TIRZ: "TIRZEPATIDE",
    SEMA: "SEMAGLUTIDE",
    MIC: "MIC",
    LIPO: "LIPO",
  };
  let drugName = ABBREV_MAP[drugMatch] || drugMatch;
  const afterKeyword = rest.substring(drugMatch.length);

  // Check for compound drug: " /METHYLCOBALAMIN" or "/METHYLCOBALAMIN"
  const compoundMatch = afterKeyword.match(/^\s*\/\s*([A-Z]{4,})/);
  if (compoundMatch) {
    // Expand partial compound names to known full names
    let compound = compoundMatch[1];
    for (const drug of ALL_DRUG_KEYWORDS) {
      if (drug.length >= 5 && drug.toUpperCase().startsWith(compound) && compound.length < drug.length) {
        compound = drug.toUpperCase();
        break;
      }
    }
    drugName = drugName + "/" + compound;
  }

  // Step 2: Check for formula number (e.g., "(FORMULA #2)", "(FORMULA #3)")
  const formulaMatch = upper.match(/FORMULA\s*#?\s*(\d+)/i);
  const formulaSuffix = formulaMatch ? " F" + formulaMatch[1] : "";

  // Step 3: Find concentration pattern anywhere in the text after the drug name start
  // e.g., "60MG/4ML", "10MG/4ML", "34MG/2MG/2ML", "100MG/ML"
  const concMatch = rest.match(/(\d[\d.]*\s*(?:MG|ML|MCG|IU|UNIT)(?:\s*\/\s*\d[\d.]*\s*(?:MG|ML|MCG|IU|UNIT))*)/i);
  const conc = concMatch
    ? " " + concMatch[1].replace(/\s+/g, "").toUpperCase()
    : "";

  const key = drugName + formulaSuffix + conc;
  return key.length >= 3 ? key : null;
}

function checkPriceChanges(
  items: InvoiceLineItem[],
  baseline: PriceBaseline
): PriceAlert[] {
  const alerts: PriceAlert[] = [];

  for (const item of items) {
    // Skip non-medication items and lab items (lab amounts vary by tests ordered)
    if (["shipping", "supplies", "payment"].includes(item.category)) continue;
    if (item.source === "lab") continue;
    // Only use Hallandale items for price baselines. Partell's cumulative Sales Detail
    // Reports mix individual and bulk order lines with unreliable quantity detection,
    // causing false price oscillation alerts. Hallandale invoices have clean per-unit pricing.
    if (item.source !== "hallandale") continue;

    // Normalize baseline key: anchor on known drug name + concentration.
    // Partell items often have "LASTNAME DRUGNAME DOSE" or bare "DOSE/VOLUME".
    const key = normalizeBaselineKey(item.medication);
    if (!key) continue;

    const existing = baseline[key];

    if (existing) {
      // Compare unit price (allow 1% tolerance for rounding)
      const pctChange = ((item.unitPrice - existing.price) / existing.price) * 100;
      if (Math.abs(pctChange) > 1) {
        alerts.push({
          medication: item.medication,
          oldPrice: existing.price,
          newPrice: item.unitPrice,
          changePercent: Math.round(pctChange * 10) / 10,
          source: item.source,
          date: item.date,
        });
      }
    }

    // Update baseline with latest price
    baseline[key] = {
      price: item.unitPrice,
      lastSeen: item.date,
      source: item.source,
    };
  }

  return alerts;
}

// ============================================================
// DUPLICATE DETECTION
// ============================================================

function detectDuplicates(invoices: Invoice[]): DuplicateAlert[] {
  const alerts: DuplicateAlert[] = [];

  // Group UNIQUE line items by patient + medication + date
  // Only flag as duplicate if the same patient received the same medication
  // on the same day but with DIFFERENT receipt IDs (different orders)
  const byPatientMedDate = new Map<string, { receiptId: string; amount: number; invoiceId: string }[]>();

  for (const inv of invoices) {
    for (const item of inv.lineItems) {
      if (!item.patientName || ["shipping", "supplies", "payment"].includes(item.category)) continue;

      const groupKey = `${item.patientName.toLowerCase()}|${item.medication.toLowerCase()}|${item.date}`;
      const entries = byPatientMedDate.get(groupKey) || [];

      // Only add if this receipt ID is new for this group
      if (!entries.some(e => e.receiptId === item.receiptId)) {
        entries.push({ receiptId: item.receiptId, amount: item.amount, invoiceId: inv.id });
        byPatientMedDate.set(groupKey, entries);
      }
    }
  }

  for (const [key, entries] of byPatientMedDate) {
    if (entries.length > 1) {
      const [patient, med, date] = key.split("|");
      alerts.push({
        patientName: patient,
        medication: med,
        date,
        amount: entries[0].amount,
        occurrences: entries.length,
        invoiceIds: entries.map(e => e.invoiceId),
      });
    }
  }

  return alerts;
}

// ============================================================
// ONEDRIVE SAVE
// ============================================================

function saveToOneDrive(invoices: Invoice[], pdfBuffers: Map<string, Buffer>): void {
  // Ensure base directory exists (path has spaces, but mkdirSync handles it fine)
  if (!existsSync(ONEDRIVE_BASE)) {
    mkdirSync(ONEDRIVE_BASE, { recursive: true });
  }

  // Create folder structure: ONEDRIVE_BASE/YYYY-MM/source/
  for (const inv of invoices) {
    const yearMonth = inv.date.substring(0, 7); // YYYY-MM
    // Use path.join (handles Windows backslashes and spaces correctly)
    const sourceDir = join(ONEDRIVE_BASE, yearMonth, inv.source);

    if (!existsSync(sourceDir)) {
      mkdirSync(sourceDir, { recursive: true });
    }

    const pdfBuf = pdfBuffers.get(inv.id);
    if (pdfBuf) {
      // Sanitize filename: remove characters invalid on Windows
      const safePdfName = inv.pdfFileName.replace(/[<>:"|?*]/g, "_");
      const fileName = inv.invoiceNumber
        ? `${inv.date}_INV-${inv.invoiceNumber}_${safePdfName}`
        : `${inv.date}_${safePdfName}`;

      const savePath = join(sourceDir, fileName);
      writeFileSync(savePath, pdfBuf);
      inv.savedPath = savePath;
    }
  }
}

// ============================================================
// BOOKKEEPING BREAKDOWN
// ============================================================

function generateBookkeepingBreakdown(items: InvoiceLineItem[]): string {
  const breakdown: Record<string, Record<string, number>> = {};

  for (const item of items) {
    const month = item.date.substring(0, 7);
    if (!breakdown[month]) breakdown[month] = {};

    const cat = item.category;
    breakdown[month][cat] = (breakdown[month][cat] || 0) + item.amount;
  }

  let report = "# Pharmacy Invoice Breakdown by QB Class\n\n";

  for (const month of Object.keys(breakdown).sort()) {
    report += `## ${month}\n`;
    const cats = breakdown[month];
    let costTotal = 0;
    let paymentTotal = 0;

    for (const [cat, amount] of Object.entries(cats).sort()) {
      report += `- **${cat}**: $${amount.toFixed(2)}\n`;
      if (cat === "payment") {
        paymentTotal += amount;
      } else {
        costTotal += amount;
      }
    }
    report += `- **COST TOTAL**: $${costTotal.toFixed(2)}\n`;
    if (paymentTotal > 0) {
      report += `- **PAYMENTS APPLIED**: $${paymentTotal.toFixed(2)}\n`;
    }
    report += "\n";
  }

  return report;
}

// ============================================================
// MAIN PROCESSOR
// ============================================================

export async function runPharmacyInvoiceProcessor(opts: {
  lookbackDays?: number;
  skipDedup?: boolean;
  dryRun?: boolean;
}): Promise<ProcessorResult> {
  const lookbackDays = opts.lookbackDays || 1;
  const state = loadState();
  const baseline = loadBaseline();
  const result: ProcessorResult = {
    invoicesProcessed: 0,
    lineItemsTotal: 0,
    totalAmount: 0,
    paymentsApplied: 0,
    byCategory: {},
    priceAlerts: [],
    duplicateAlerts: [],
    errors: [],
  };

  console.log(`[pharmacy] Starting invoice processor. Lookback: ${lookbackDays} days`);

  // Fetch emails
  let emails: M365Message[];
  try {
    emails = await fetchInvoiceEmails(lookbackDays);
    console.log(`[pharmacy] Found ${emails.length} invoice emails`);
  } catch (err) {
    result.errors.push(`Email fetch failed: ${err}`);
    return result;
  }

  // Filter already processed (unless skipping dedup for lookback)
  if (!opts.skipDedup) {
    emails = emails.filter(e => !state.processedEmailIds.includes(e.id));
    console.log(`[pharmacy] ${emails.length} new (unprocessed) emails`);
  }

  if (emails.length === 0) {
    console.log("[pharmacy] No new invoices to process");
    return result;
  }

  // Partell sends cumulative daily reports (each contains ALL history).
  // Only process the most recent Partell email. Others are redundant.
  const partellEmails = emails.filter(e =>
    (e.from?.emailAddress?.address?.toLowerCase() || "").includes("rxlocal")
  );
  const nonPartellEmails = emails.filter(e =>
    !(e.from?.emailAddress?.address?.toLowerCase() || "").includes("rxlocal")
  );

  // Keep only the latest Partell email (sorted by date desc)
  const latestPartell = partellEmails.length > 0
    ? [partellEmails.sort((a, b) =>
        new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
      )[0]]
    : [];

  const emailsToProcess = [...latestPartell, ...nonPartellEmails];
  console.log(`[pharmacy] Processing ${emailsToProcess.length} emails (${latestPartell.length} Partell, ${nonPartellEmails.length} other)`);

  // Process each email
  const invoices: Invoice[] = [];
  const pdfBuffers = new Map<string, Buffer>();

  for (const email of emailsToProcess) {
    try {
      // Download PDF first to save buffer
      const from = email.from?.emailAddress?.address?.toLowerCase() || "";
      const isLabReceipt = from.includes("authorize.net");

      if (!isLabReceipt) {
        const pdfData = await downloadPDFAttachment(email.id);
        if (pdfData) {
          pdfBuffers.set(email.id, pdfData.data);
        }
      }

      const invoice = await processEmail(email);
      if (invoice) {
        invoices.push(invoice);
        result.invoicesProcessed++;

        // Mark as processed
        state.processedEmailIds.push(email.id);
      }
    } catch (err) {
      result.errors.push(`Error processing ${email.subject}: ${err}`);
    }
  }

  // Partell PDFs are cumulative (contain ALL historical transactions).
  // Use lastRunDate as cutoff so daily cron only picks up NEW transactions.
  // Falls back to lookbackDays for first run or historical analysis.
  const cutoffDate = state.lastRunDate && !opts.skipDedup
    ? new Date(state.lastRunDate)
    : new Date(Date.now() - lookbackDays * 86400000);
  const cutoffISO = cutoffDate.toISOString().split("T")[0]; // YYYY-MM-DD

  for (const inv of invoices) {
    if (inv.source === "partell") {
      const before = inv.lineItems.length;
      inv.lineItems = inv.lineItems.filter(item => item.date >= cutoffISO);
      const after = inv.lineItems.length;
      if (before !== after) {
        console.log(`[pharmacy] Partell: filtered ${before} -> ${after} items (cutoff ${cutoffISO})`);
      }
      inv.total = inv.lineItems.reduce((sum, item) => sum + item.amount, 0);
    }
  }

  // Deduplicate line items across all invoices using receipt+rx+med+amount key
  // This handles cases where the same line appears in overlapping Hallandale invoices
  const seenLineItems = new Set<string>();
  const uniqueItems: InvoiceLineItem[] = [];

  for (const inv of invoices) {
    for (const item of inv.lineItems) {
      const dedupKey = `${item.receiptId}|${item.rxNumber || ""}|${item.medication}|${item.amount}|${item.date}`;
      if (!seenLineItems.has(dedupKey)) {
        seenLineItems.add(dedupKey);
        uniqueItems.push(item);
      }
    }
  }

  console.log(`[pharmacy] ${uniqueItems.length} unique line items (from ${invoices.flatMap(i => i.lineItems).length} raw)`);

  // Compute totals from deduplicated items, separating payments from costs
  const costItems = uniqueItems.filter(i => i.category !== "payment");
  const paymentItems = uniqueItems.filter(i => i.category === "payment");

  result.lineItemsTotal = costItems.length;
  result.totalAmount = costItems.reduce((sum, item) => sum + item.amount, 0);
  result.paymentsApplied = paymentItems.reduce((sum, item) => sum + item.amount, 0);

  for (const item of uniqueItems) {
    if (!result.byCategory[item.category]) {
      result.byCategory[item.category] = { count: 0, amount: 0 };
    }
    result.byCategory[item.category].count++;
    result.byCategory[item.category].amount += item.amount;
  }

  // Price change detection (on chronologically sorted unique items)
  const sortedItems = [...uniqueItems].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  result.priceAlerts = checkPriceChanges(sortedItems, baseline);

  // Duplicate detection: flag same patient+med+date with DIFFERENT receipt IDs
  // (same receipt in cumulative reports is NOT a duplicate, but same patient billed
  // on the same day via different orders IS suspicious)
  result.duplicateAlerts = detectDuplicates(invoices);

  // Save to OneDrive (unless dry run)
  if (!opts.dryRun) {
    try {
      saveToOneDrive(invoices, pdfBuffers);
    } catch (err) {
      result.errors.push(`OneDrive save failed: ${err}`);
    }
  }

  // Generate bookkeeping breakdown from deduplicated items
  const breakdownReport = generateBookkeepingBreakdown(uniqueItems);
  const reportPath = join(ONEDRIVE_BASE, `breakdown-${new Date().toISOString().split("T")[0]}.md`);

  if (!opts.dryRun) {
    try {
      if (!existsSync(ONEDRIVE_BASE)) {
        mkdirSync(ONEDRIVE_BASE, { recursive: true });
      }
      writeFileSync(reportPath, breakdownReport);
    } catch (err) {
      result.errors.push(`Report save failed: ${err}`);
    }
  }

  // Save state and baseline
  state.lastRunDate = new Date().toISOString();
  // Keep only last 1000 processed IDs to prevent file bloat
  if (state.processedEmailIds.length > 1000) {
    state.processedEmailIds = state.processedEmailIds.slice(-1000);
  }
  saveState(state);
  saveBaseline(baseline);

  console.log(`[pharmacy] Done. ${result.invoicesProcessed} invoices, ${result.lineItemsTotal} line items, $${result.totalAmount.toFixed(2)} total`);
  if (result.priceAlerts.length > 0) {
    console.log(`[pharmacy] ${result.priceAlerts.length} price change alert(s)`);
  }
  if (result.duplicateAlerts.length > 0) {
    console.log(`[pharmacy] ${result.duplicateAlerts.length} duplicate charge alert(s)`);
  }

  return result;
}

// ============================================================
// TELEGRAM SUMMARY FORMATTER
// ============================================================

export function formatPharmacySummary(result: ProcessorResult): string {
  if (result.invoicesProcessed === 0 && result.errors.length === 0) {
    return "No new pharmacy invoices to process.";
  }

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let msg = `Pharmacy Invoice Report\n`;
  msg += `Processed: ${result.invoicesProcessed} invoices, ${result.lineItemsTotal} line items\n`;
  msg += `Costs: $${fmt(result.totalAmount)}`;
  if (result.paymentsApplied > 0) {
    msg += ` | Payments applied: $${fmt(result.paymentsApplied)}`;
  }
  msg += "\n\n";

  // Category breakdown (exclude payment, it's shown in header)
  const categories = Object.entries(result.byCategory)
    .filter(([cat]) => cat !== "payment")
    .sort((a, b) => b[1].amount - a[1].amount);

  if (categories.length > 0) {
    msg += `By Department:\n`;
    for (const [cat, data] of categories) {
      msg += `  ${cat}: $${fmt(data.amount)} (${data.count})\n`;
    }
    msg += "\n";
  }

  // Duplicate alerts FIRST (actionable)
  if (result.duplicateAlerts.length > 0) {
    msg += `Duplicate Charges (ACTION NEEDED):\n`;
    for (const alert of result.duplicateAlerts) {
      msg += `  ${alert.patientName} - ${alert.medication} on ${alert.date}: $${fmt(alert.amount)} x${alert.occurrences}\n`;
    }
    msg += "\n";
  }

  // Price alerts: top 5 by absolute dollar change
  if (result.priceAlerts.length > 0) {
    const topAlerts = [...result.priceAlerts]
      .sort((a, b) => Math.abs(b.newPrice - b.oldPrice) - Math.abs(a.newPrice - a.oldPrice))
      .slice(0, 5);

    msg += `Price Changes (${topAlerts.length} of ${result.priceAlerts.length}):\n`;
    for (const alert of topAlerts) {
      const dir = alert.changePercent > 0 ? "UP" : "DOWN";
      msg += `  ${alert.medication}: $${fmt(alert.oldPrice)} -> $${fmt(alert.newPrice)} (${dir} ${Math.abs(alert.changePercent)}%)\n`;
    }
    msg += "\n";
  }

  // Errors (max 3)
  if (result.errors.length > 0) {
    msg += `Errors (${result.errors.length}):\n`;
    for (const err of result.errors.slice(0, 3)) {
      msg += `  ${err.substring(0, 100)}\n`;
    }
  }

  // Telegram has a 4096 char limit
  if (msg.length > 4096) {
    msg = msg.substring(0, 4090) + "\n...";
  }

  return msg;
}
