/**
 * Creates SharePoint pages for all ad concepts in the creative library,
 * then updates corresponding Planner tasks with links to those pages.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import {
  listSites,
  createSharePointPage,
  listTeams,
  listPlansForGroup,
  listPlannerTasks,
  getTaskDetails,
  getAccessToken,
} from "../src/m365.ts";

const SITE_NAME = "TheOffice";
const PLAN_NAME = "Ad Creative Pipeline";

interface AdConcept {
  id: string; // e.g. "LOCAL-01"
  title: string; // e.g. "Social Proof / Transformation Story"
  fullTitle: string; // e.g. "LOCAL-01: Social Proof / Transformation Story"
  content: string; // raw markdown content
}

function parseAdLibrary(filePath: string): AdConcept[] {
  const text = readFileSync(filePath, "utf-8");
  const concepts: AdConcept[] = [];
  // Match ### LOCAL-01: Title or ### TELE-01: Title
  const regex = /^### ((?:LOCAL|TELE)-\d{2}):\s*(.+)$/gm;
  let match;
  const positions: { id: string; title: string; start: number }[] = [];

  while ((match = regex.exec(text)) !== null) {
    positions.push({ id: match[1], title: match[2].trim(), start: match.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i < positions.length - 1 ? positions[i + 1].start : text.length;
    const content = text.substring(positions[i].start, end).trim();
    concepts.push({
      id: positions[i].id,
      title: positions[i].title,
      fullTitle: `${positions[i].id}: ${positions[i].title}`,
      content,
    });
  }

  return concepts;
}

function markdownToHtml(concept: AdConcept): string {
  // Extract key sections from the markdown
  const lines = concept.content.split("\n");
  let hook = "";
  let shortCopy = "";
  let mediumCopy = "";
  let longCopy = "";
  let cta = "";
  let visualDir = "";
  let angle = "";

  let currentSection = "";
  for (const line of lines) {
    if (line.startsWith("**Angle:**")) {
      angle = line.replace("**Angle:**", "").trim();
      continue;
    }
    if (line.startsWith("**Hook:**")) {
      currentSection = "hook";
      continue;
    }
    if (line.startsWith("**Short")) {
      currentSection = "short";
      continue;
    }
    if (line.startsWith("**Medium")) {
      currentSection = "medium";
      continue;
    }
    if (line.startsWith("**Long")) {
      currentSection = "long";
      continue;
    }
    if (line.startsWith("**CTA:**")) {
      cta = line.replace("**CTA:**", "").trim();
      currentSection = "";
      continue;
    }
    if (line.startsWith("**Visual Direction:**")) {
      visualDir = line.replace("**Visual Direction:**", "").trim();
      currentSection = "";
      continue;
    }
    if (line === "---" || line.startsWith("### ") || line.startsWith("**Entity ID Note:**")) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    switch (currentSection) {
      case "hook":
        hook += trimmed + " ";
        break;
      case "short":
        shortCopy += `<p>${trimmed}</p>`;
        break;
      case "medium":
        mediumCopy += `<p>${trimmed}</p>`;
        break;
      case "long":
        longCopy += `<p>${trimmed}</p>`;
        break;
    }
  }

  return `
<h2>${concept.fullTitle}</h2>
${angle ? `<p><strong>Angle:</strong> ${angle}</p>` : ""}

<h3>Hook</h3>
<p><em>${hook.trim()}</em></p>

<h3>Ad Copy - Short</h3>
${shortCopy || "<p>(See medium/long below)</p>"}

<h3>Ad Copy - Medium</h3>
${mediumCopy || "<p>(No medium copy for this concept)</p>"}

<h3>Ad Copy - Long</h3>
${longCopy || "<p>(No long copy for this concept)</p>"}

${cta ? `<h3>CTA</h3><p>${cta}</p>` : ""}

<h3>Visual Direction</h3>
<p>${visualDir || "See ad creative library for details."}</p>

<h3>Creative Pipeline Checklist</h3>
<ul>
  <li>Copy finalized</li>
  <li>Image/creative designed in Canva</li>
  <li>Compliance review (LegitScript + Meta policy)</li>
  <li>Derek review and approval</li>
  <li>Uploaded to Meta Ads Manager</li>
  <li>Campaign live</li>
</ul>

<h3>Notes</h3>
<p>(Add notes about this creative here)</p>
`.trim();
}

/** Direct Graph API call bypassing circuit breaker (for standalone scripts) */
async function graphDirect<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph ${path} returned ${res.status}: ${body.substring(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}

async function main() {
  const SITE_ID = "pvmedispa.sharepoint.com,c3497b86-eede-4485-b817-d71a921a2536,356e2b6c-a376-4430-b129-bbc6807b22c3";

  // 1. Parse ad library
  const concepts = parseAdLibrary("C:\\Users\\Derek DiCamillo\\Projects\\atlas\\ad-creative-library.md");
  console.log(`Parsed ${concepts.length} ad concepts`);

  // 2. Create pages (skip if already exist)
  const pageMap: Record<string, { url: string; id: string }> = {};
  for (const concept of concepts) {
    const slug = `ad-${concept.id.toLowerCase()}`;
    const html = markdownToHtml(concept);
    try {
      const page = await createSharePointPage(SITE_ID, concept.fullTitle, html, {
        name: slug,
        publish: true,
      });
      pageMap[concept.id] = { url: page.webUrl, id: page.id };
      console.log(`  Created: ${concept.id} -> ${page.webUrl}`);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err: any) {
      if (err.message?.includes("already exists") || err.message?.includes("nameAlreadyExists")) {
        console.log(`  Exists: ${concept.id}`);
      } else {
        console.error(`  FAILED: ${concept.id}: ${err.message?.substring(0, 100)}`);
      }
    }
  }

  // 3. Fetch existing pages to build pageMap for any we didn't just create
  if (Object.keys(pageMap).length < concepts.length) {
    console.log(`\nFetching existing SharePoint pages...`);
    try {
      const pagesResp = await graphDirect<{ value: any[] }>(`/sites/${SITE_ID}/pages?$top=50&$select=id,name,title,webUrl`);
      for (const p of pagesResp.value || []) {
        const name = (p.name || "").replace(".aspx", "");
        // Match "ad-local-01" or "ad-tele-05" pattern
        const m = name.match(/^ad-((?:local|tele)-\d{2})$/i);
        if (m) {
          const conceptId = m[1].toUpperCase();
          if (!pageMap[conceptId]) {
            pageMap[conceptId] = { url: p.webUrl || `https://pvmedispa.sharepoint.com/sites/VitalityUnchained/SitePages/${p.name}`, id: p.id };
            console.log(`  Found: ${conceptId} -> ${pageMap[conceptId].url}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`  Failed to list pages: ${err.message?.substring(0, 100)}`);
    }
  }

  console.log(`\nPageMap has ${Object.keys(pageMap).length} entries`);

  // 4. Find Planner board (direct API, bypass circuit breaker)
  console.log(`\nUpdating Planner tasks with page links...`);
  const teamsResp = await graphDirect<{ value: any[] }>("/me/joinedTeams");
  let planId = "";
  for (const team of teamsResp.value || []) {
    try {
      const plansResp = await graphDirect<{ value: any[] }>(`/groups/${team.id}/planner/plans`);
      const match = (plansResp.value || []).find((p: any) => p.title?.toLowerCase().includes("ad creative pipeline"));
      if (match) {
        planId = match.id;
        console.log(`  Found plan: ${match.title} (${match.id})`);
        break;
      }
    } catch { /* skip */ }
  }

  if (!planId) {
    console.log("Plan not found, skipping task updates");
    return;
  }

  // 5. Update Planner task descriptions with page links
  const tasksResp = await graphDirect<{ value: any[] }>(`/planner/plans/${planId}/tasks`);
  let updated = 0;
  for (const task of tasksResp.value || []) {
    const idMatch = task.title?.match(/(LOCAL|TELE)-\d{2}/i);
    if (!idMatch) continue;
    const conceptId = idMatch[0].toUpperCase();
    const pageInfo = pageMap[conceptId];
    if (!pageInfo) {
      console.log(`  No page for ${conceptId}`);
      continue;
    }

    try {
      const details = await graphDirect<any>(`/planner/tasks/${task.id}/details`);
      const existingDesc = details.description || "";
      if (existingDesc.includes("sharepoint.com")) {
        console.log(`  Skipped ${conceptId}: already has SharePoint link`);
        continue;
      }
      const newDesc = `${existingDesc}\n\nSharePoint Page: ${pageInfo.url}`.trim();
      const detailEtag = details["@odata.etag"] || "";

      const token = await getAccessToken();
      const res = await fetch(`https://graph.microsoft.com/v1.0/planner/tasks/${task.id}/details`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "If-Match": detailEtag,
        },
        body: JSON.stringify({ description: newDesc }),
      });

      if (res.ok) {
        updated++;
        console.log(`  Updated: ${conceptId} task with page link`);
      } else {
        const errText = await res.text().catch(() => "");
        console.log(`  Failed to update ${conceptId}: ${res.status} ${errText.substring(0, 100)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`  Error updating ${conceptId}: ${err.message?.substring(0, 80)}`);
    }
  }

  console.log(`\nDone! Updated ${updated} Planner tasks with SharePoint page links.`);
}

main().catch(console.error);
