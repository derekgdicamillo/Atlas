/**
 * GHL Products API Test Script
 * Run with: bun run .claude/skills/ghl-products/test-api.mjs
 * Or: node .claude/skills/ghl-products/test-api.mjs
 *
 * Tests the API connection by listing products. Does NOT create or modify anything.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Read .env file from project root
const envPath = resolve(import.meta.dirname, "../../../.env");
const envContent = readFileSync(envPath, "utf-8");

function getEnvVar(name) {
  const match = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

const API_TOKEN = getEnvVar("GHL_API_TOKEN");
const LOCATION_ID = getEnvVar("GHL_LOCATION_ID");
const BASE_URL = "https://services.leadconnectorhq.com";

if (!API_TOKEN) {
  console.error("ERROR: GHL_API_TOKEN not found in .env file");
  process.exit(1);
}

if (!LOCATION_ID) {
  console.error("ERROR: GHL_LOCATION_ID not found in .env file");
  process.exit(1);
}

console.log("GHL Products API Test");
console.log("---------------------");
console.log("Location ID:", LOCATION_ID);
console.log("Token:", API_TOKEN.slice(0, 10) + "..." + API_TOKEN.slice(-4));
console.log("");

async function testListProducts() {
  const url = `${BASE_URL}/products/?locationId=${LOCATION_ID}&limit=10&offset=0`;

  console.log("Testing: GET /products/");
  console.log("URL:", url);
  console.log("");

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    });

    console.log("Status:", response.status, response.statusText);
    console.log("");

    const body = await response.text();

    if (response.status === 200) {
      const data = JSON.parse(body);
      const products = data.products || [];
      console.log("SUCCESS: API connection works!");
      console.log(`Found ${products.length} product(s) (total: ${data.total || products.length})`);
      console.log("");

      if (products.length > 0) {
        console.log("Products:");
        for (const p of products) {
          console.log(`  - ${p.name} (${p.productType || "unknown type"}) [ID: ${p._id}]`);
          if (p.prices && p.prices.length > 0) {
            for (const pr of p.prices) {
              const amount = (pr.amount / 100).toFixed(2);
              const label = pr.type === "recurring"
                ? `$${amount}/${pr.recurring?.interval || "period"}`
                : `$${amount} one-time`;
              console.log(`    Price: ${pr.name || "Unnamed"} - ${label}`);
            }
          }
        }
      } else {
        console.log("No products exist yet. The API is working, just empty catalog.");
      }
    } else if (response.status === 401) {
      console.log("AUTH FAILED (401): Token rejected.");
      console.log("The PIT token may not have Products scope enabled.");
      console.log("Fix: GHL > Settings > Integrations > Private Integrations > enable Products scope.");
      console.log("");
      console.log("Response:", body);
    } else if (response.status === 403) {
      console.log("FORBIDDEN (403): Token lacks required permissions.");
      console.log("The PIT token needs Products and Products/Prices scopes.");
      console.log("");
      console.log("Response:", body);
    } else if (response.status === 422) {
      console.log("VALIDATION ERROR (422):", body);
    } else {
      console.log("UNEXPECTED STATUS:", response.status);
      console.log("Response:", body);
    }
  } catch (err) {
    console.error("CONNECTION ERROR:", err.message);
    console.error("");
    console.error("Could not reach the GHL API. Check network connectivity.");
  }
}

await testListProducts();
