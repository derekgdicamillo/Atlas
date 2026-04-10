/**
 * Manual newsletter draft trigger with mock data
 * Bypasses SiteGround WAF-blocked API calls to test education-first format
 */

const mockPosts = [
  {
    id: 136,
    title: { rendered: "How to Choose the Right Medical Director for Your Practice" },
    excerpt: { rendered: "Finding a medical director is not just about credentials - it is about finding someone who aligns with your vision and compliance needs." },
    link: "https://medicalaestheticsassociation.com/how-to-choose-the-right-medical-director/",
  },
  {
    id: 135,
    title: { rendered: "5 Marketing Mistakes Aesthetic Practices Make on Social Media" },
    excerpt: { rendered: "Your social media presence can make or break patient acquisition. Here are the top mistakes we see practices making." },
    link: "https://medicalaestheticsassociation.com/5-marketing-mistakes-aesthetic-practices/",
  },
  {
    id: 134,
    title: { rendered: "Understanding Aesthetic Practice Insurance: What You Actually Need" },
    excerpt: { rendered: "Malpractice, general liability, product liability - which policies are essential and which are optional?" },
    link: "https://medicalaestheticsassociation.com/aesthetic-practice-insurance-guide/",
  },
];

const peerQs = [
  "What is the average per-unit Botox price in competitive metro markets and how do I price mine?",
  "How do I handle no-shows without alienating patients who might rebook?",
  "What is the best way to structure a patient referral program that actually generates referrals?",
];

const postList = mockPosts
  .map((p) => `- "${p.title.rendered}" - ${p.excerpt.rendered} (${p.link})`)
  .join("\n");

const prompt = `You are writing the weekly free newsletter for The Medical Aesthetics Association (TMAA).
Newsletter name: "This Week at TMAA"
Audience: Aesthetic practitioners (NPs, RNs, PAs, estheticians) who are NOT yet TMAA members.
Tone: Warm, knowledgeable, genuinely helpful. Like a trusted colleague sharing what they have learned. No hype, no hard sell.

THIS IS AN EDUCATION-FIRST NEWSLETTER. The primary value is teaching, not linking. Blog posts support the education - they are not the centerpiece.

STRUCTURE (follow this exactly):

1. **Opening Hook** (2-3 sentences): Lead with a specific, surprising insight or counterintuitive truth related to this weeks main topic. Make readers think "wait, really?" Avoid generic greetings.

2. **The Practitioners Edge** (THIS IS THE CENTERPIECE - 250-300 words): A standalone educational mini-article that teaches something practitioners can use immediately. Structure:
   - **Bold claim or question as headline** (pull from the peer questions below if available)
   - **The problem/misconception** (2-3 sentences): What most practitioners get wrong and why it costs them
   - **The insight** (3-4 sentences): What the data/experience actually shows. Include a specific number, benchmark, or case example. Reference one of the blog posts below if it supports the point (with link).
   - **The takeaway** (2-3 sentences): What to do differently starting this week - specific enough to act on
TOPIC: "Botox pricing strategy" (47 community conversations this month)
Real questions practitioners are asking about this:
- "${peerQs[0]}"
- "${peerQs[1]}"
- "${peerQs[2]}"
Address the core concern behind these questions.
Write as a standalone mini-article: problem -> insight -> takeaway. Use a real-world example or benchmark number. 250-300 words.
Do NOT mention SAGE, AI, dashboards, or data sources. Frame insights as community wisdom, peer patterns, or your own expertise.

3. **What Your Peers Are Asking** (2-3 real questions): Present these as a callout/highlight box. Each question gets a 1-2 sentence answer that is genuinely useful (not a teaser).
- "${peerQs[0]}"
- "${peerQs[1]}"
- "${peerQs[2]}"

4. **Further Reading** (3 posts, compact): Each post gets ONE sentence that names the specific problem it solves + "Read more" link.
${postList}

5. **Quick Win of the Week** (4-5 sentences): One concrete action step with enough detail to execute in under 15 minutes. Include the EXACT steps.
Topic: "Patient retention programs" - give one specific, implementable 15-minute action step with exact steps.

6. **CTA**: One warm sentence inviting them to "Join TMAA" - link: https://medicalaestheticsassociation.com/join. Frame it as what they will GET, not what they should DO.

QUALITY RULES:
- Every section must teach or inform. Zero filler.
- Use "you" language, not "practitioners should."
- Include at least 3 specific numbers, percentages, or benchmarks.
- The Practitioners Edge section is 40% of the newsletter value - invest the most effort here.
- No sign-off signature block (the Brevo template handles that).
- Do NOT end with "Live Life Unchained" or any sign-off - the template adds that.

OUTPUT: Return ONLY the HTML email body content (no <html>, <head>, or <body> tags - just the inner content that goes inside the Brevo template). Use inline styles. Keep total length under 1000 words.`;

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("ANTHROPIC_API_KEY not set. Printing prompt instead.\n");
  console.log("=== PROMPT ===\n");
  console.log(prompt);
  console.log("\n=== END ===");
  process.exit(0);
}

console.log("Calling Claude Sonnet to generate newsletter...\n");
const resp = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  }),
});

if (!resp.ok) {
  console.log("Claude API error:", resp.status, await resp.text());
  process.exit(1);
}

const data = await resp.json() as { content: Array<{ text: string }> };
const html = data.content[0].text;
console.log("=== GENERATED NEWSLETTER HTML ===\n");
console.log(html);
console.log("\n=== END ===");

const { writeFileSync } = await import("fs");
writeFileSync("data/task-output/newsletter-test-output.html", html);
console.log("\nSaved to data/task-output/newsletter-test-output.html");
