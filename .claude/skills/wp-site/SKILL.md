---
name: wp-site
description: >-
  Manage pvmedispa.com WordPress website. Update pages, create blog posts,
  edit theme CSS, push changes to WP Engine. Use when Derek says "update the
  website", "change the homepage", "new blog post", "edit the weight loss page",
  "push to WP Engine", "website CSS", or any pvmedispa.com modification.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebFetch
context: fork
user-invocable: true
argument-hint: "<page slug, blog topic, or change description>"
---
# WordPress Site Manager (pvmedispa.com)

Manage the PV MediSpa website via WP REST API (content) and local file editing (theme/code).

## Site Architecture

- **Live site:** https://pvmedispa.com (WP Engine)
- **Local dev:** C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\app\public\
- **Theme:** Kadence (direct customizations, no child theme)
- **Custom CSS:** wp-content/themes/kadence/custom-pvmedispa.css
- **WP-CLI:** C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\wp.sh
- **Page backups:** C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\pages\

## Credentials

WP REST API credentials are in the Atlas .env file:
- `WP_SITE_URL`: https://pvmedispa.com
- `WP_USER`: WordPress admin username
- `WP_APP_PASSWORD`: Application Password for REST API auth

Load them:
```bash
source <(grep -E '^WP_' "C:/Users/Derek DiCamillo/Projects/atlas/.env" | sed 's/\r//')
```

## Two Workflows

### 1. Content Changes (WP REST API) - preferred for most changes

Use `curl` with Basic Auth for instant content updates. No deploy needed.

**List pages:**
```bash
curl -s -u "$WP_USER:$WP_APP_PASSWORD" "$WP_SITE_URL/wp-json/wp/v2/pages?per_page=100&_fields=id,slug,title,status" | python -m json.tool
```

**Get page content by slug:**
```bash
curl -s -u "$WP_USER:$WP_APP_PASSWORD" "$WP_SITE_URL/wp-json/wp/v2/pages?slug=weight-loss" | python -m json.tool
```

**Update page content:**
```bash
curl -s -X PUT -u "$WP_USER:$WP_APP_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"content":"<new HTML content>"}' \
  "$WP_SITE_URL/wp-json/wp/v2/pages/<PAGE_ID>"
```

**Create draft blog post:**
```bash
curl -s -X POST -u "$WP_USER:$WP_APP_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"title":"Post Title","content":"<HTML>","status":"draft"}' \
  "$WP_SITE_URL/wp-json/wp/v2/posts"
```

**List categories:**
```bash
curl -s -u "$WP_USER:$WP_APP_PASSWORD" "$WP_SITE_URL/wp-json/wp/v2/categories?_fields=id,name,slug"
```

**List recent posts:**
```bash
curl -s -u "$WP_USER:$WP_APP_PASSWORD" "$WP_SITE_URL/wp-json/wp/v2/posts?per_page=10&_fields=id,slug,title,status,date"
```

### 2. Theme/Code Changes (Local Files + Git Push)

For CSS, PHP templates, or custom code. Edit locally, then push to WP Engine.

**Key paths in local dev:**
- Theme root: `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\app\public\wp-content\themes\kadence\`
- Custom CSS: `custom-pvmedispa.css` (brand colors, fonts, component styles)
- Functions: `functions.php`
- Assets: `assets/` (fonts, images)

**Brand CSS variables (from custom-pvmedispa.css):**
```css
--pv-teal: #6CC3E0;
--pv-teal-hover: #08ACF2;
--pv-heading: #101218;
--pv-body: #4C5253;
--pv-muted: #7A7A7A;
--pv-border: #e8e7e6;
--pv-light-bg: #F3F6F6;
```

**WP Engine Git Push deployment:**
```bash
cd "C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\app\public"
git add -A
git commit -m "description of change"
git push production master
```

## Input Handling

**If $ARGUMENTS contains a page slug** (e.g., "weight-loss", "homepage", "about"):
1. Fetch current page content via REST API
2. Show the user what exists
3. Make the requested changes
4. Confirm before updating

**If $ARGUMENTS describes a blog post** (e.g., "blog about GLP-1 benefits"):
1. Draft the post content
2. Apply /humanizer for patient-facing copy
3. Create as draft via REST API
4. Return the WP admin link to review

**If $ARGUMENTS mentions CSS/theme** (e.g., "change button color", "add animation"):
1. Read the current custom-pvmedispa.css
2. Make changes to local file
3. Show diff to Derek
4. Push to WP Engine on approval

**If $ARGUMENTS is empty:**
1. List all pages and recent posts
2. Ask what Derek wants to change

## Safety Rules

- NEVER publish directly. All posts created as draft. Page updates require explicit confirmation.
- ALWAYS back up current page content before updating (save to pages/ directory).
- For blog posts, apply /humanizer before creating the draft.
- Use PV brand voice (see memory/voice-guide.md).
- Clinic uses body comp SCALE. Never mention InBody or DEXA.
- Follow the 5 Pillars framework for health content.

## Content Guidelines

- **Patient-facing copy:** Warm, authoritative, no medical jargon. Results-focused.
- **Blog SEO:** Include target keyword in title, H2s, first paragraph. 1200-2000 words.
- **CTAs:** Benefit-driven button copy ("Start Your Journey" not "Submit").
- **Frameworks to reference:** SLOW & SHIELD, Fuel Code, Vitality Tracker, Cooling Protocol.

## Troubleshooting

### Error: 401 Unauthorized on REST API
Application Password invalid or revoked. Derek needs to regenerate in WP Admin > Users > Application Passwords. Update `WP_APP_PASSWORD` in .env.

### Error: 403 Forbidden on page update
The WP user may not have Editor/Admin role, or a security plugin is blocking REST API writes. Check user role and any WAF/firewall rules on WP Engine.

### Error: Page content looks wrong after update
WP REST API expects raw HTML in the `content` field. If Kadence blocks or Gutenberg blocks are used, updating via REST may strip block markup. For Kadence-heavy pages, prefer editing in WP Admin directly and use REST only for simple HTML content sections.

### Git push to WP Engine fails
- Verify the `production` remote exists: `git remote -v` in the local site directory
- Check SSH key is configured for WP Engine
- WP Engine rejects pushes if the repo history diverged. Never force push. If stuck, re-clone from WP Engine and reapply changes.

### Local site won't start
Local by Flywheel issue. Try: right-click the site in Local > Restart. If persistent, check that the site's PHP/MySQL versions are compatible. The site path is `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\`.

### Blog post created but not visible
Posts default to `draft` status (intentionally). To publish: either change status in WP Admin, or explicitly set `"status":"publish"` in the REST API call (only after Derek confirms).

### Custom CSS not applying after push
Browser cache or WP Engine edge cache. Clear WP Engine cache from the WP Admin toolbar, or append a version query string to the CSS file reference.
