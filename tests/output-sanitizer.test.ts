import { describe, test, expect, beforeEach } from "bun:test";
import {
  sanitizeOutbound,
  isRepeatErrorForChat,
  resetErrorSuppression,
} from "../src/output-sanitizer.ts";

describe("output-sanitizer", () => {
  beforeEach(() => resetErrorSuppression());

  describe("deliberation leaks", () => {
    test("strips leading scratchpad paragraph (2026-06-29 'Thanks' leak)", () => {
      const input =
        "The user just said Thanks — that's it. No new task, no question. Per the behavioral rules drilled in repeatedly: deliver and stop.\n\nYou got it.";
      expect(sanitizeOutbound(input).text).toBe("You got it.");
    });

    test("strips multiple leading deliberation paragraphs", () => {
      const input =
        "The user wants to brainstorm. This is conversational.\n\nI should respond as Atlas with my genuine thoughts.\n\nYeah, let's do it. Here's where I'd start.";
      expect(sanitizeOutbound(input).text).toBe(
        "Yeah, let's do it. Here's where I'd start."
      );
    });

    test("strips identity-confusion narration (2026-06-26 Kimberly Sedbrook leak)", () => {
      const input =
        "I'm Ishtar, not Atlas, and that working memory is bleeding the wrong name into my outputs.\n\nKimberly Sedbrook, next in the queue. RN, 12-year account, name-matched email.";
      expect(sanitizeOutbound(input).text).toContain("Kimberly Sedbrook");
      expect(sanitizeOutbound(input).text).not.toContain("Ishtar, not Atlas");
    });

    test("strips rule citations (Per the IMAGE OBSERVATION RULE)", () => {
      const input =
        "Per the IMAGE OBSERVATION RULE, I just describe what I see.\n\nJessica Tilton, approve. LPN, clean email.";
      expect(sanitizeOutbound(input).text).toBe(
        "Jessica Tilton, approve. LPN, clean email."
      );
    });

    test("strips inline workflow-flag commentary", () => {
      const input =
        "Here's the link analysis. (Quick note: the workflow keyword flag is a false positive — your message doesn't ask for one, so I'm just checking the link.) The page loads fine.";
      const out = sanitizeOutbound(input).text;
      expect(out).not.toContain("workflow keyword flag");
      expect(out).toContain("The page loads fine.");
    });

    test("never strips the entire response", () => {
      const input = "The user just said Thanks.";
      expect(sanitizeOutbound(input).text).toBe("The user just said Thanks.");
    });

    test("leaves normal prose untouched", () => {
      const input =
        "Batch so far: 12 captured, 1 declined.\n\nRosamaria Mercado, approve. PACU + ER RN, 16-year account, exact name match.";
      expect(sanitizeOutbound(input).text).toBe(input);
    });
  });

  describe("error humanization", () => {
    test("replaces spend-limit string (2026-06-15 5x repeat)", () => {
      const input =
        "You've hit your monthly spend limit · resets 9pm (America/Los_Angeles) · raise it at claude.ai/settings/usage";
      const out = sanitizeOutbound(input);
      expect(out.text).toContain("monthly usage limit");
      expect(out.text).not.toContain("America/Los_Angeles");
      expect(out.errorKey).toBe("spend-limit");
    });

    test("replaces raw API error string (2026-05-31 leak)", () => {
      const input =
        "API Error: 400 messages.1.content.8: thinking or redacted_thinking blocks cannot be modified";
      const out = sanitizeOutbound(input);
      expect(out.text).toBe(
        "I hit a temporary system error. Give me a moment and try again."
      );
      expect(out.errorKey).toBe("api-error");
    });

    test("normal text has null errorKey", () => {
      expect(sanitizeOutbound("All done, committed.").errorKey).toBeNull();
    });
  });

  describe("repeat suppression", () => {
    test("same error class within window is flagged as repeat", () => {
      const t0 = 1_000_000;
      expect(isRepeatErrorForChat("chat1", "spend-limit", t0)).toBe(false);
      expect(isRepeatErrorForChat("chat1", "spend-limit", t0 + 60_000)).toBe(true);
    });

    test("different chat or different class is not a repeat", () => {
      const t0 = 1_000_000;
      expect(isRepeatErrorForChat("chat1", "spend-limit", t0)).toBe(false);
      expect(isRepeatErrorForChat("chat2", "spend-limit", t0 + 1000)).toBe(false);
      expect(isRepeatErrorForChat("chat1", "api-error", t0 + 2000)).toBe(false);
    });

    test("repeat outside 10-minute window is allowed", () => {
      const t0 = 1_000_000;
      expect(isRepeatErrorForChat("chat1", "spend-limit", t0)).toBe(false);
      expect(isRepeatErrorForChat("chat1", "spend-limit", t0 + 11 * 60_000)).toBe(false);
    });
  });

  describe("em dashes", () => {
    test("spaced em dash becomes comma", () => {
      expect(sanitizeOutbound("Thursday was the LAST day of school — time flies.").text).toBe(
        "Thursday was the LAST day of school, time flies."
      );
    });

    test("unspaced em dash becomes hyphen", () => {
      expect(sanitizeOutbound("Take 3—5 units.").text).toBe("Take 3-5 units.");
    });

    test("prose double-hyphen becomes comma", () => {
      expect(sanitizeOutbound("We came in tired -- we left thrilled.").text).toBe(
        "We came in tired, we left thrilled."
      );
    });

    test("code blocks and inline code are preserved", () => {
      const input =
        "Run this:\n```bash\npm2 restart atlas --update-env\n```\nAnd `claude --model opus` works — promise.";
      const out = sanitizeOutbound(input).text;
      expect(out).toContain("pm2 restart atlas --update-env");
      expect(out).toContain("`claude --model opus`");
      expect(out).toContain("works, promise.");
    });
  });
});
