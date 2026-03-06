Deno.serve(() => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - The Tox Tray</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 1.8em; }
    h2 { font-size: 1.3em; margin-top: 2em; }
    p { margin: 0.8em 0; }
    .updated { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>The Tox Tray</strong></p>
  <p class="updated">Last updated: February 26, 2026</p>

  <h2>Introduction</h2>
  <p>The Tox Tray ("we", "us", "our") operates an online retail business selling 3D-printed medical trays through Etsy and social media platforms. This privacy policy explains how we collect, use, and protect your information.</p>

  <h2>Information We Collect</h2>
  <p>We may collect the following information when you interact with our social media pages, Etsy shop, or website:</p>
  <p>- Name and contact information (when you make a purchase or inquiry)<br>
  - Shipping address (for order fulfillment)<br>
  - Email address (for order communications)<br>
  - Social media interactions (likes, comments, follows on our public pages)</p>

  <h2>How We Use Your Information</h2>
  <p>We use collected information to:</p>
  <p>- Fulfill and ship orders<br>
  - Respond to customer inquiries<br>
  - Improve our products and services<br>
  - Post content on social media platforms (Pinterest, Instagram, Facebook, TikTok)<br>
  - Analyze engagement to improve our marketing</p>

  <h2>Third-Party Services</h2>
  <p>We use the following third-party platforms:</p>
  <p>- <strong>Etsy</strong> for sales and order processing<br>
  - <strong>Pinterest, Instagram, Facebook, TikTok</strong> for social media marketing<br>
  - <strong>Canva</strong> for design creation</p>
  <p>Each platform has its own privacy policy governing your data on their service.</p>

  <h2>Data Sharing</h2>
  <p>We do not sell or rent your personal information. We only share data as necessary with shipping carriers to fulfill orders and with the platforms listed above.</p>

  <h2>Data Retention</h2>
  <p>We retain order information as required for business and tax purposes. Social media analytics data is retained in aggregate form.</p>

  <h2>Your Rights</h2>
  <p>You may request access to, correction of, or deletion of your personal information by contacting us.</p>

  <h2>Contact</h2>
  <p>For privacy-related questions, contact us through our Etsy shop: The Tox Tray.</p>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
