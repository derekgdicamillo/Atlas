---
name: landing-pages
description: >-
  Edit and manage PV MediSpa landing pages on WordPress. Two pages: local
  (weightloss, Page ID 5943) and telehealth (weightloss-telehealth, Page ID
  5910). Use when Derek says "update the landing page", "change the local page",
  "edit the telehealth page", "landing page text", "LP pricing", "LP form", or
  any modification to the weight loss landing pages.
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
argument-hint: "<page name and change description>"
---
# Landing Page Manager

Manage the two PV MediSpa weight loss landing pages on WordPress.

## Pages

| Page | Slug | Page ID | URL | Form ID |
|------|------|---------|-----|---------|
| Local (in-person) | weightloss | 5943 | https://pvmedispa.com/weightloss/ | UMiQta4olMWZgb1Addjw |
| Telehealth | weightloss-telehealth | 5910 | https://pvmedispa.com/weightloss-telehealth/ | ONGm8zmyejkDEturLHO8 |

## File Locations

- **Local page HTML:** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\pages\weightloss-local.html`
- **Telehealth page HTML:** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\pages\weightloss-telehealth.html`
- **Image URL map:** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\image-url-map.json`
- **Upload script (telehealth):** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\upload-page.py`
- **Upload script (local):** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\upload-local-page.py`

## How to Make Changes

### Workflow

1. Read the HTML file for the target page
2. Make edits to the local HTML file using Edit tool
3. Upload to WordPress using the Python upload script

### Upload to WordPress

For the **telehealth** page (ID 5910):
```bash
cd "C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss" && python upload-page.py
```

For the **local** page (ID 5943):
```bash
cd "C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss" && python upload-local-page.py
```

Both scripts read the HTML file, JSON-encode it, and PUT/POST to the WP REST API with Basic Auth.

### Direct REST API Update (alternative)

If the upload script doesn't exist or you need a one-off update:
```python
import json, urllib.request, base64

with open(r"PATH_TO_HTML", "r", encoding="utf-8") as f:
    content = f.read()

cred = base64.b64encode(b"derekgdicamillo:lZaI Czuz 0YzK gg3q vM6z aNnZ").decode()
data = json.dumps({"content": content}).encode("utf-8")
req = urllib.request.Request(
    "https://pvmedispa.com/wp-json/wp/v2/pages/PAGE_ID",
    data=data, method="POST"
)
req.add_header("Authorization", f"Basic {cred}")
req.add_header("Content-Type", "application/json; charset=utf-8")
response = urllib.request.urlopen(req)
result = json.loads(response.read().decode())
print(f"Updated: {result['link']}")
```

## Key Differences Between Pages

The two pages share 95% of content. Only these sections differ:

### Hero Section
| Element | Local | Telehealth |
|---------|-------|------------|
| Subtitle | Attention Prescott Valley & Quad City | Attention Arizona Telehealth! |
| Headline | Lose 20+ lbs Safely With Medical Oversight | Lose 20+ lbs Safely With Medical Oversight From A / Licensed Arizona Medical Provider |
| Subheadline | Join hundreds of men and women in Prescott Valley who reclaimed their confidence, their clothes, and their health. | Medically supervised weight loss from home. No office visit needed. Labs at your local lab, meds shipped to your door. |

### 3-Step Process
| Step | Local | Telehealth |
|------|-------|------------|
| Step 1 | FREE Consultation | FREE Virtual Consultation |
| Step 2 | Complete Labs | Complete Labs at Your Local Lab Center |
| Step 2 desc | (no Sonora Quest mention) | Visit your nearest Sonora Quest Lab. |
| Step 3 | Begin Treatment + Custom Plan | Medications Shipped to Your Door + Custom Plan |

### GHL Form Embed
| Element | Local | Telehealth |
|---------|-------|------------|
| Form ID | UMiQta4olMWZgb1Addjw | ONGm8zmyejkDEturLHO8 |
| Form Name | Weight Loss Free Consult Form - Local | Weight Loss Free Consult Form - Telehealth |

### Everything Else is Identical
Same video, images, testimonials, before/after photos, team section, Derek's story, credentials, social proof, pricing ($465/mo + $199 one-time), FAQ, footer.

## Page Structure (section order)

1. Hero (dark bg, logo, phones, headline)
2. Video + 3 Testimonial Cards
3. CTA Button
4. 3-Step Process
5. Before/After Grid + Timeline
6. Why It Works
7. Pain Points (3 cards)
8. Tried Every Diet + Social Proof Screenshot
9. Team Section (Derek, Esther, Billie)
10. Derek's Story (2-column with photos)
11. Credentials (OMA + NASM badges)
12. Social Proof Screenshots (2x2 grid)
13. What's Included (3-column)
14. You Also Get (checklist)
15. More Social Proof (4+3 grid)
16. Testimonials (3 review cards)
17. Pricing Box ($465/mo)
18. FAQ Accordion (4 questions)
19. Final CTA
20. Footer
21. GHL Form Embed (popup iframe)

## Brand & Style

- **Colors:** #101218 (dark charcoal), #6CC3E0 (teal accent), #F3F6F6 (light gray)
- **Fonts:** Playfair Display (headings), Raleway (body)
- **CSS class prefix:** `.lp-` (all landing page styles use this prefix)
- **Nav hidden:** CSS `.site-header,.site-footer,.wp-site-blocks > header,.entry-header{display:none!important}`
- **Phone numbers:** Text: (928) 642-9067 (sms link), Call: (928) 910-8818 (tel link)

## Images

All 29 images hosted on WordPress Media Library at `https://pvmedispa.com/wp-content/uploads/2026/03/`. Full mapping in `image-url-map.json`. Key images:
- `pv-logo.svg` - header logo
- `testimonial-tiffany-60lbs.webp`, `testimonial-cheryl-swimsuit.webp`, `testimonial-angelina-james-100lbs.webp`
- `before-after-transform-1.png` through `before-after-transform-6.webp`
- `team-derek-dicamillo.webp`, `team-esther-dicamillo.webp`, `team-billie-cote.webp`
- `derek-transformation-family.jpeg`, `derek-before-after.jpeg`
- `badge-obesity-medicine-assoc.png`, `badge-nasm-certified.png`
- `social-proof-screenshot-1.png` through `social-proof-screenshot-5.png`
- `testimonial-proof-1.webp` through `testimonial-proof-7.png`

## Safety Rules

- ALWAYS edit the local HTML file first, then upload. Never edit via REST API directly.
- Back up the current HTML before making changes (the local files serve as the backup).
- If changing pricing, confirm with Derek first.
- If changing form IDs, confirm with Derek first (leads go to different GHL pipelines).
- Clinic uses body comp SCALE. Never mention InBody or DEXA.
