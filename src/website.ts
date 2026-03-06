/**
 * Atlas — WordPress Website Integration (pvmedispa.com)
 *
 * WP REST API wrapper for reading and updating site content.
 * Used by both Atlas tag processing (relay.ts) and Claude Code skill.
 *
 * Auth: Application Password (Basic Auth over HTTPS).
 * Hosting: WP Engine with Git Push deployment.
 * Local dev: Local by Flywheel at C:\Users\derek\Local Sites\pv-medispa-weight-loss\
 */

import { info, warn, error as logError } from "./logger.ts";

// ============================================================
// CONFIG
// ============================================================

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_USER = process.env.WP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";

const API_BASE = `${WP_SITE_URL}/wp-json/wp/v2`;
const API_TIMEOUT = 20_000;

// ============================================================
// TYPES
// ============================================================

export interface WPPage {
  id: number;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  status: string;
  link: string;
  modified: string;
}

export interface WPPost {
  id: number;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  status: string;
  link: string;
  date: string;
  categories: number[];
}

export interface WPCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export interface WPMedia {
  id: number;
  source_url: string;
  title: { rendered: string };
  mime_type: string;
}

// ============================================================
// AUTH & HELPERS
// ============================================================

function authHeader(): string {
  const encoded = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${encoded}`;
}

export function isWebsiteReady(): boolean {
  return !!(WP_SITE_URL && WP_USER && WP_APP_PASSWORD);
}

async function wpFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WP API ${res.status}: ${body.substring(0, 300)}`);
  }

  return res.json() as Promise<T>;
}

// ============================================================
// PAGES
// ============================================================

/** List all published pages (slug, title, id) */
export async function listPages(): Promise<WPPage[]> {
  const pages: WPPage[] = [];
  let page = 1;
  while (true) {
    const batch = await wpFetch<WPPage[]>(
      `/pages?per_page=100&page=${page}&status=publish&_fields=id,slug,title,status,link,modified`
    );
    pages.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return pages;
}

/** Get a single page by slug */
export async function getPageBySlug(slug: string): Promise<WPPage | null> {
  const results = await wpFetch<WPPage[]>(
    `/pages?slug=${encodeURIComponent(slug)}&_fields=id,slug,title,content,status,link,modified`
  );
  return results[0] || null;
}

/** Get a single page by ID */
export async function getPageById(id: number): Promise<WPPage> {
  return wpFetch<WPPage>(`/pages/${id}`);
}

/** Update page content by slug. Returns the updated page. */
export async function updatePageContent(
  slug: string,
  content: string,
  options?: { title?: string }
): Promise<WPPage> {
  const page = await getPageBySlug(slug);
  if (!page) throw new Error(`Page not found: "${slug}"`);

  const body: Record<string, string> = { content };
  if (options?.title) body.title = options.title;

  info("website", `Updating page "${slug}" (id=${page.id})`);
  return wpFetch<WPPage>(`/pages/${page.id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Update page by ID */
export async function updatePageById(
  id: number,
  data: { content?: string; title?: string; status?: string }
): Promise<WPPage> {
  info("website", `Updating page id=${id}`);
  return wpFetch<WPPage>(`/pages/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ============================================================
// POSTS
// ============================================================

/** List recent posts */
export async function listPosts(count = 10): Promise<WPPost[]> {
  return wpFetch<WPPost[]>(
    `/posts?per_page=${count}&orderby=date&order=desc&_fields=id,slug,title,excerpt,status,link,date,categories`
  );
}

/** Get a single post by slug */
export async function getPostBySlug(slug: string): Promise<WPPost | null> {
  const results = await wpFetch<WPPost[]>(
    `/posts?slug=${encodeURIComponent(slug)}`
  );
  return results[0] || null;
}

/** Create a new post */
export async function createPost(data: {
  title: string;
  content: string;
  status?: "draft" | "publish" | "pending";
  categories?: number[];
  excerpt?: string;
}): Promise<WPPost> {
  info("website", `Creating post: "${data.title}" (status=${data.status || "draft"})`);
  return wpFetch<WPPost>("/posts", {
    method: "POST",
    body: JSON.stringify({
      title: data.title,
      content: data.content,
      status: data.status || "draft",
      categories: data.categories,
      excerpt: data.excerpt,
    }),
  });
}

/** Update an existing post by ID */
export async function updatePost(
  id: number,
  data: { title?: string; content?: string; status?: string; excerpt?: string }
): Promise<WPPost> {
  info("website", `Updating post id=${id}`);
  return wpFetch<WPPost>(`/posts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ============================================================
// CATEGORIES
// ============================================================

/** List all categories */
export async function listCategories(): Promise<WPCategory[]> {
  return wpFetch<WPCategory[]>("/categories?per_page=100&_fields=id,name,slug,count");
}

/** Find category ID by name (case-insensitive) */
export async function findCategoryByName(name: string): Promise<WPCategory | null> {
  const categories = await listCategories();
  const lower = name.toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === lower || c.slug === lower) || null;
}

// ============================================================
// MEDIA (read-only for now)
// ============================================================

/** List recent media */
export async function listMedia(count = 20): Promise<WPMedia[]> {
  return wpFetch<WPMedia[]>(
    `/media?per_page=${count}&orderby=date&order=desc&_fields=id,source_url,title,mime_type`
  );
}

// ============================================================
// CUSTOM CSS (via WP Customizer REST endpoint)
// ============================================================

/** Get current custom CSS */
export async function getCustomCSS(): Promise<string> {
  try {
    // WP stores custom CSS as a custom post type
    const results = await wpFetch<Array<{ id: number; content: { raw?: string } }>>(
      `${WP_SITE_URL}/wp-json/wp/v2/custom_css?_fields=id,content`
    );
    return results[0]?.content?.raw || "";
  } catch {
    return "";
  }
}

// ============================================================
// TAG PROCESSING (for Atlas relay.ts)
// ============================================================

/**
 * Process website intent tags from Claude's response.
 * Pattern follows GHL/Google tag processing in relay.ts.
 *
 * Tags:
 *   [WP_UPDATE: page-slug | HTML content]
 *   [WP_POST: title | content | status=draft|publish | categories=cat1,cat2]
 */
export async function processWebsiteIntents(response: string): Promise<string> {
  if (!isWebsiteReady()) return response;
  let clean = response;

  // [WP_UPDATE: slug | content HTML]
  for (const match of response.matchAll(
    /\[WP_UPDATE:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx === -1) {
      warn("website", `WP_UPDATE missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const slug = inner.slice(0, pipeIdx).trim();
    const content = inner.slice(pipeIdx + 1).trim();

    if (!slug || !content) {
      warn("website", `WP_UPDATE missing slug or content`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const updated = await updatePageContent(slug, content);
      info("website", `Updated page "${slug}" (id=${updated.id})`);
    } catch (err) {
      logError("website", `WP_UPDATE failed for "${slug}": ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [WP_POST: title | content | status=draft|publish | categories=cat1,cat2]
  for (const match of response.matchAll(
    /\[WP_POST:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    // Split: first pipe = title|content, then named params
    const parts = inner.split(/\s*\|\s*/);
    if (parts.length < 2) {
      warn("website", `WP_POST needs at least title and content: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const title = parts[0].trim();
    const content = parts[1].trim();
    let status: "draft" | "publish" = "draft";
    let categoryNames: string[] = [];

    // Parse optional named params
    for (let i = 2; i < parts.length; i++) {
      const statusMatch = parts[i].match(/^status\s*=\s*(draft|publish)/i);
      if (statusMatch) status = statusMatch[1].toLowerCase() as "draft" | "publish";

      const catMatch = parts[i].match(/^categories\s*=\s*(.*)/i);
      if (catMatch) categoryNames = catMatch[1].split(",").map((c) => c.trim());
    }

    if (!title || !content) {
      warn("website", `WP_POST missing title or content`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      // Resolve category names to IDs
      let categoryIds: number[] | undefined;
      if (categoryNames.length > 0) {
        const allCats = await listCategories();
        categoryIds = categoryNames
          .map((name) => {
            const lower = name.toLowerCase();
            return allCats.find((c) => c.name.toLowerCase() === lower || c.slug === lower);
          })
          .filter((c): c is WPCategory => !!c)
          .map((c) => c.id);
      }

      const post = await createPost({ title, content, status, categories: categoryIds });
      info("website", `Created post "${title}" (id=${post.id}, status=${status})`);
    } catch (err) {
      logError("website", `WP_POST failed for "${title}": ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean;
}

// ============================================================
// FORMATTERS
// ============================================================

export function formatPageList(pages: WPPage[]): string {
  if (pages.length === 0) return "No pages found.";

  const lines: string[] = [`WEBSITE PAGES (${pages.length} total)`];
  for (const p of pages) {
    const title = p.title.rendered.replace(/<[^>]*>/g, "");
    lines.push(`  /${p.slug} — ${title}`);
  }
  return lines.join("\n");
}

export function formatPostList(posts: WPPost[]): string {
  if (posts.length === 0) return "No posts found.";

  const lines: string[] = ["RECENT BLOG POSTS"];
  for (const p of posts) {
    const title = p.title.rendered.replace(/<[^>]*>/g, "");
    const date = new Date(p.date).toLocaleDateString();
    lines.push(`  [${date}] ${title} (${p.status}) — ${p.link}`);
  }
  return lines.join("\n");
}

// ============================================================
// CONTEXT FOR CLAUDE PROMPT
// ============================================================

/** Lightweight context for buildPrompt: page list + recent posts */
export async function getWebsiteContext(): Promise<string> {
  if (!isWebsiteReady()) return "";

  try {
    const [pages, posts] = await Promise.all([
      listPages().catch(() => []),
      listPosts(5).catch(() => []),
    ]);

    const parts: string[] = [];

    if (pages.length > 0) {
      const pageList = pages
        .map((p) => `/${p.slug}`)
        .join(", ");
      parts.push(`Site pages: ${pageList}`);
    }

    if (posts.length > 0) {
      const postList = posts
        .slice(0, 3)
        .map((p) => p.title.rendered.replace(/<[^>]*>/g, ""))
        .join(", ");
      parts.push(`Recent posts: ${postList}`);
    }

    return parts.join("\n");
  } catch (err) {
    warn("website", `Context fetch failed: ${err}`);
    return "";
  }
}
