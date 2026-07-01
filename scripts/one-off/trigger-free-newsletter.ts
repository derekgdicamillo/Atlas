import { draftFreeNewsletter } from "./src/maa-newsletter.ts";
import { runPrompt } from "./src/prompt-runner.ts";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const result = await draftFreeNewsletter(
  (prompt) => runPrompt(prompt, "claude-sonnet-4-6"),
  supabase
);
console.log(JSON.stringify(result, null, 2));
