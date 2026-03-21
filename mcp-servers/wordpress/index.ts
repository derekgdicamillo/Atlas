/**
 * Atlas MCP Server -- WordPress (pvmedispa.com)
 *
 * Exposes WP REST API for pages, posts, categories, and media via MCP.
 * Auth: Application Password (Basic Auth over HTTPS).
 *
 * Start: bun run mcp-servers/wordpress/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-wordpress": {
 *       "command": "C:\\Users\\Derek DiCamillo\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\Derek DiCamillo\\Projects\\atlas\\mcp-servers\\wordpress\\index.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { log, warn, error as logError } from "../shared/logger.js";
import { TTLCache, withCache } from "../shared/cache.js";
import { CircuitBreaker, withBreaker } from "../shared/circuit-breaker.js";
import { formatMcpError } from "../shared/errors.js";

const SERVER = "wordpress";

// ============================================================
// CIRCUIT BREAKER
// ============================================================

const wpBreaker = new CircuitBreaker({
  name: "WordPress",
  server: SERVER,
  failureThreshold: 3,
  resetTimeoutMs: 45_000,
});

// ============================================================
// CACHE (30s TTL for list ops)
// ============================================================

const listCache = new TTLCache<unknown>(30_000);

// ============================================================
// LAZY MODULE IMPORT
// ============================================================

let _wp: typeof import("../../src/website.ts") | null = null;

async function wp() {
  if (!_wp) {
    _wp = await import("../../src/website.ts");
    if (!_wp.isWebsiteReady()) {
      logError(SERVER, "WordPress not ready. Check WP_SITE_URL, WP_USER, WP_APP_PASSWORD.");
    } else {
      log(SERVER, "WordPress module initialized");
    }
  }
  return _wp;
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas WordPress",
  version: "1.0.0",
});

// ============================================================
// TOOLS (READ)
// ============================================================

// 1. listPages
server.tool(
  "listPages",
  "List all published pages on pvmedispa.com. Returns slug, title, status, link, and last modified date.",
  {},
  async () => {
    try {
      const w = await wp();
      const pages = await withBreaker(wpBreaker, () =>
        withCache(listCache, "pages", () => w.listPages())
      );
      const formatted = w.formatPageList(pages);
      return { content: [{ type: "text" as const, text: formatted }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getPage
server.tool(
  "getPage",
  "Get a page by slug. Returns full HTML content, title, status, link, and metadata.",
  {
    slug: z.string().describe("Page slug (e.g. 'weight-loss', 'about')"),
  },
  async ({ slug }) => {
    try {
      const w = await wp();
      const page = await withBreaker(wpBreaker, () => w.getPageBySlug(slug));
      if (!page) {
        return { content: [{ type: "text" as const, text: `Page not found: "${slug}"` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. listPosts
server.tool(
  "listPosts",
  "List blog posts on pvmedispa.com. Returns title, slug, excerpt, date, status, categories, and link.",
  {
    limit: z.number().optional().describe("Max posts to return (default 10)"),
    status: z.string().optional().describe("Filter by status: publish, draft, pending (default: all)"),
  },
  async ({ limit }) => {
    try {
      const w = await wp();
      const posts = await withBreaker(wpBreaker, () =>
        withCache(listCache, `posts:${limit || 10}`, () => w.listPosts(limit || 10))
      );
      const formatted = w.formatPostList(posts);
      return { content: [{ type: "text" as const, text: formatted }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 4. getPost
server.tool(
  "getPost",
  "Get a blog post by slug. Returns full HTML content, title, excerpt, categories, and metadata.",
  {
    slug: z.string().describe("Post slug"),
  },
  async ({ slug }) => {
    try {
      const w = await wp();
      const post = await withBreaker(wpBreaker, () => w.getPostBySlug(slug));
      if (!post) {
        return { content: [{ type: "text" as const, text: `Post not found: "${slug}"` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(post, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 5. listCategories
server.tool(
  "listCategories",
  "List all blog categories. Returns category ID, name, slug, and post count.",
  {},
  async () => {
    try {
      const w = await wp();
      const categories = await withBreaker(wpBreaker, () =>
        withCache(listCache, "categories", () => w.listCategories())
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(categories, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 6. listMedia
server.tool(
  "listMedia",
  "List media library items. Returns ID, source URL, title, and mime type.",
  {
    limit: z.number().optional().describe("Max items to return (default 20)"),
  },
  async ({ limit }) => {
    try {
      const w = await wp();
      const media = await withBreaker(wpBreaker, () =>
        withCache(listCache, `media:${limit || 20}`, () => w.listMedia(limit || 20))
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(media, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// TOOLS (WRITE)
// ============================================================

// 7. updatePage
server.tool(
  "updatePage",
  "Update a page's HTML content by slug. Optionally update the title. Returns the updated page.",
  {
    slug: z.string().describe("Page slug (e.g. 'weight-loss', 'about')"),
    content: z.string().describe("New HTML content for the page body"),
    title: z.string().optional().describe("New page title (optional)"),
  },
  async ({ slug, content, title }) => {
    try {
      const w = await wp();
      const updated = await withBreaker(wpBreaker, () =>
        w.updatePageContent(slug, content, title ? { title } : undefined)
      );
      listCache.delete("pages");
      return { content: [{ type: "text" as const, text: `Page "${slug}" updated (id=${updated.id}).\n${updated.link}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 8. createPost
server.tool(
  "createPost",
  "Create a new blog post. Defaults to draft status. Returns the created post with URL.",
  {
    title: z.string().describe("Post title"),
    content: z.string().describe("Post HTML content"),
    status: z.enum(["draft", "publish", "pending"]).optional().describe("Post status (default: draft)"),
    categories: z.array(z.number()).optional().describe("Category IDs to assign"),
    excerpt: z.string().optional().describe("Post excerpt"),
  },
  async ({ title, content, status, categories, excerpt }) => {
    try {
      const w = await wp();
      const post = await withBreaker(wpBreaker, () =>
        w.createPost({
          title,
          content,
          status: status as "draft" | "publish" | "pending" | undefined,
          categories,
          excerpt,
        })
      );
      listCache.delete(`posts:10`);
      return { content: [{ type: "text" as const, text: `Post created: "${post.title.rendered}" (id=${post.id}, status=${post.status})\n${post.link}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 9. updatePost
server.tool(
  "updatePost",
  "Update an existing blog post by ID. Can update title, content, status, and excerpt.",
  {
    id: z.number().describe("Post ID"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New HTML content"),
    status: z.string().optional().describe("New status (draft, publish, pending)"),
    excerpt: z.string().optional().describe("New excerpt"),
  },
  async ({ id, title, content, status, excerpt }) => {
    try {
      const w = await wp();
      const updated = await withBreaker(wpBreaker, () =>
        w.updatePost(id, { title, content, status, excerpt })
      );
      listCache.clear(); // post list + individual post cache
      return { content: [{ type: "text" as const, text: `Post updated: "${updated.title.rendered}" (id=${updated.id})\n${updated.link}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// wp://pages/all - all page slugs + titles
server.resource(
  "pages-all",
  "wp://pages/all",
  async (uri: URL) => {
    try {
      const w = await wp();
      const pages = await withBreaker(wpBreaker, () => w.listPages());
      const summary = pages.map((p) => ({
        slug: p.slug,
        title: p.title.rendered.replace(/<[^>]*>/g, ""),
        link: p.link,
      }));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(summary, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// ============================================================
// START
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(SERVER, "Server started on stdio");
}

main().catch((err) => {
  logError(SERVER, `Fatal: ${err}`);
  process.exit(1);
});
