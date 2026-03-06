/**
 * Hevy Webhook Receiver Edge Function
 *
 * Receives POST from Hevy when Derek saves a workout.
 * Payload: { "workoutId": "uuid" }
 *
 * Flow:
 * 1. Validate auth header
 * 2. Fetch full workout from Hevy API
 * 3. Match exercises to programmed routine
 * 4. Run progressive overload analysis
 * 5. Update Hevy routine with new target weights (if earned)
 * 6. Send Telegram summary to Derek
 *
 * URL: https://<project-ref>.supabase.co/functions/v1/hevy-webhook
 *
 * Secrets required:
 *   HEVY_WEBHOOK_SECRET    -- auth token for Hevy webhook validation
 *   HEVY_API_KEY           -- Hevy API key for fetching workout data
 *   TELEGRAM_BOT_TOKEN     -- for sending workout summaries
 *   TELEGRAM_COACH_CHAT_ID -- Derek's coach chat ID (or main chat)
 */

const HEVY_API = "https://api.hevyapp.com/v1";

// Routine IDs mapped to day names for matching
const ROUTINE_MAP: Record<string, { id: string; day: string; focus: string; repRange: string }> = {
  "Mon - Upper Power":      { id: "d3ae6ef6-1bc9-4f99-be7b-da85ca35b210", day: "Monday",    focus: "Upper Power",       repRange: "4-6" },
  "Tue - Lower Power":      { id: "691bdb26-42cf-44f9-a909-cba912760768", day: "Tuesday",   focus: "Lower Power",       repRange: "4-6" },
  "Thu - Upper Hypertrophy": { id: "0d6e8a00-fba2-4c1f-a1bd-b120faf45e2a", day: "Thursday",  focus: "Upper Hypertrophy", repRange: "8-12" },
  "Fri - Lower Hypertrophy": { id: "86f7af01-e350-4a90-9198-bd61dacfdba1", day: "Friday",    focus: "Lower Hypertrophy", repRange: "8-12" },
};

// Upper body exercise template IDs (for +5 lb progression)
const UPPER_EXERCISES = new Set([
  "79D0BB3A", // Bench Press (Barbell)
  "018ADC12", // Pendlay Row
  "7B8D84E8", // OHP (Barbell)
  "6A6C31A5", // Lat Pulldown
  "07B38369", // Incline DB Press
  "A5AC6449", // Barbell Curl
  "50DFDFAB", // Incline Bench (Barbell)
  "F1D60854", // Seated Cable Row
  "91AF29E0", // Seated OHP
  "422B08F1", // Lateral Raise (DB)
  "37FCC2BB", // DB Curl
  "B5EFBF9C", // OH Tricep Extension
  "BE640BA0", // Face Pull
]);

// Lower body exercises (for +10 lb progression)
const LOWER_EXERCISES = new Set([
  "B923B230", // Trap Bar DL
  "5046D0A9", // Front Squat
  "D57C2EC7", // Hip Thrust (Barbell)
  "A733CC5B", // Walking Lunge (DB)
  "B8127AD1", // Lying Leg Curl
  "E05C2C38", // Standing Calf Raise (Machine)
  "F8356514", // Hanging Leg Raise
  "2B4B7310", // Romanian DL (Barbell)
  "C7973E0E", // Leg Press
  "B5D3A742", // Bulgarian Split Squat
  "75A4F6C4", // Leg Extension
  "062AB91A", // Seated Calf Raise
  "A2D838BD", // Cable Twist (woodchop)
]);

const KG_PER_LB = 0.453592;
const LB_PER_KG = 2.20462;

interface HevySet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  custom_metric: number | null;
}

interface HevyExercise {
  index: number;
  title: string;
  exercise_template_id: string;
  notes: string | null;
  superset_id: number | null;
  sets: HevySet[];
  rest_seconds: number;
}

interface HevyWorkout {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  exercises: HevyExercise[];
}

interface RoutineExercise {
  index: number;
  title: string;
  exercise_template_id: string;
  notes: string | null;
  superset_id: number | null;
  sets: HevySet[];
  rest_seconds: number;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // 1. Validate auth header
    const authHeader = req.headers.get("authorization") || "";
    const expectedToken = Deno.env.get("HEVY_WEBHOOK_SECRET");

    if (!expectedToken || authHeader !== expectedToken) {
      console.error("Auth failed. Got:", authHeader.substring(0, 20) + "...");
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Parse payload
    const payload = await req.json();
    const workoutId = payload.workoutId;

    if (!workoutId) {
      return new Response("Missing workoutId", { status: 400 });
    }

    console.log(`Hevy webhook received: workoutId=${workoutId}`);

    // 3. Fetch full workout from Hevy API
    const apiKey = Deno.env.get("HEVY_API_KEY");
    if (!apiKey) {
      console.error("HEVY_API_KEY not set");
      return new Response("Server config error", { status: 500 });
    }

    const workoutResp = await fetch(`${HEVY_API}/workouts/${workoutId}`, {
      headers: { "api-key": apiKey, "Accept": "application/json" },
    });

    if (!workoutResp.ok) {
      console.error(`Hevy API error: ${workoutResp.status}`);
      return new Response("Failed to fetch workout", { status: 502 });
    }

    const workoutData = await workoutResp.json();
    const workout: HevyWorkout = workoutData.workout || workoutData;

    // 4. Match to programmed routine by title or day
    const matchedRoutine = findMatchingRoutine(workout.title);

    // 5. Analyze workout vs program
    const analysis = analyzeWorkout(workout, matchedRoutine);

    // 6. If progression earned, update routine in Hevy
    if (matchedRoutine && analysis.updates.length > 0) {
      await updateRoutineWeights(apiKey, matchedRoutine.id, analysis.updates);
    }

    // 7. Send Telegram summary
    await sendTelegramSummary(workout, analysis);

    // Respond 200 within 5 seconds (Hevy requirement)
    return new Response("ok");
  } catch (error) {
    console.error("Hevy webhook error:", error);
    return new Response(String(error), { status: 500 });
  }
});

function findMatchingRoutine(workoutTitle: string): { id: string; day: string; focus: string; repRange: string } | null {
  // Direct title match
  for (const [name, info] of Object.entries(ROUTINE_MAP)) {
    if (workoutTitle.toLowerCase().includes(name.toLowerCase()) ||
        workoutTitle.toLowerCase().includes(info.focus.toLowerCase())) {
      return info;
    }
  }

  // Day-of-week match
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Phoenix", weekday: "long" });
  for (const [_, info] of Object.entries(ROUTINE_MAP)) {
    if (info.day === today) return info;
  }

  return null;
}

interface ExerciseAnalysis {
  title: string;
  templateId: string;
  programmedReps: number;
  actualSets: { weight_lbs: number; reps: number }[];
  hitAllReps: boolean;
  missedReps: boolean; // dropped 2+ below target
  verdict: "progress" | "hold" | "drop";
  nextWeight_lbs: number | null;
}

interface WorkoutAnalysis {
  duration_min: number;
  totalVolume_lbs: number;
  exercises: ExerciseAnalysis[];
  updates: { exerciseIndex: number; newWeight_kg: number }[];
  overallVerdict: string;
}

function analyzeWorkout(workout: HevyWorkout, routine: { repRange: string } | null): WorkoutAnalysis {
  const start = new Date(workout.start_time);
  const end = new Date(workout.end_time);
  const duration_min = Math.round((end.getTime() - start.getTime()) / 60000);

  let totalVolume_lbs = 0;
  const exercises: ExerciseAnalysis[] = [];
  const updates: { exerciseIndex: number; newWeight_kg: number }[] = [];

  const targetReps = routine ? parseInt(routine.repRange.split("-")[0]) : 0;

  for (const ex of workout.exercises) {
    const actualSets = ex.sets
      .filter(s => s.type === "normal" && s.reps !== null)
      .map(s => ({
        weight_lbs: s.weight_kg ? Math.round(s.weight_kg * LB_PER_KG) : 0,
        reps: s.reps || 0,
      }));

    // Volume calculation
    for (const s of actualSets) {
      totalVolume_lbs += s.weight_lbs * s.reps;
    }

    // Progressive overload check (only for working sets with weight)
    const workingSets = actualSets.filter(s => s.weight_lbs > 0);
    const programReps = targetReps || (workingSets.length > 0 ? workingSets[0].reps : 0);

    let hitAllReps = true;
    let missedReps = false;

    for (const s of workingSets) {
      if (s.reps < programReps) hitAllReps = false;
      if (s.reps < programReps - 1) missedReps = true; // dropped 2+ below
    }

    let verdict: "progress" | "hold" | "drop" = "hold";
    let nextWeight_lbs: number | null = null;

    if (workingSets.length > 0) {
      const maxWeight = Math.max(...workingSets.map(s => s.weight_lbs));
      const isUpper = UPPER_EXERCISES.has(ex.exercise_template_id);
      const isLower = LOWER_EXERCISES.has(ex.exercise_template_id);
      const increment = isUpper ? 5 : isLower ? 10 : 5;

      if (hitAllReps) {
        verdict = "progress";
        nextWeight_lbs = maxWeight + increment;
        // Queue update
        updates.push({
          exerciseIndex: ex.index,
          newWeight_kg: nextWeight_lbs * KG_PER_LB,
        });
      } else if (missedReps) {
        verdict = "drop";
        nextWeight_lbs = Math.round(maxWeight * 0.9);
      } else {
        verdict = "hold";
        nextWeight_lbs = maxWeight;
      }
    }

    exercises.push({
      title: ex.title,
      templateId: ex.exercise_template_id,
      programmedReps: programReps,
      actualSets,
      hitAllReps,
      missedReps,
      verdict,
      nextWeight_lbs,
    });
  }

  const progressCount = exercises.filter(e => e.verdict === "progress").length;
  const holdCount = exercises.filter(e => e.verdict === "hold").length;
  const dropCount = exercises.filter(e => e.verdict === "drop").length;

  let overallVerdict = "";
  if (progressCount > holdCount + dropCount) {
    overallVerdict = "Strong session. Multiple lifts moving up next time.";
  } else if (dropCount > 0) {
    overallVerdict = "Some lifts need a reset. Fatigue might be accumulating. Watch it.";
  } else {
    overallVerdict = "Solid session. Holding weight, focus on cleaning up reps.";
  }

  return { duration_min, totalVolume_lbs, exercises, updates, overallVerdict };
}

async function updateRoutineWeights(
  apiKey: string,
  routineId: string,
  updates: { exerciseIndex: number; newWeight_kg: number }[]
) {
  try {
    // Fetch current routine
    const resp = await fetch(`${HEVY_API}/routines/${routineId}`, {
      headers: { "api-key": apiKey, "Accept": "application/json" },
    });

    if (!resp.ok) {
      console.error(`Failed to fetch routine ${routineId}: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const routine = data.routine?.[0] || data.routine || data;

    if (!routine.exercises) {
      console.error("No exercises in routine response");
      return;
    }

    // Apply weight updates
    for (const update of updates) {
      const ex = routine.exercises[update.exerciseIndex];
      if (ex) {
        for (const set of ex.sets) {
          set.weight_kg = update.newWeight_kg;
        }
      }
    }

    // PUT updated routine back
    const updateResp = await fetch(`${HEVY_API}/routines/${routineId}`, {
      method: "PUT",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        routine: {
          title: routine.title,
          folder_id: routine.folder_id,
          exercises: routine.exercises.map((ex: RoutineExercise) => ({
            exercise_template_id: ex.exercise_template_id,
            superset_id: ex.superset_id,
            rest_seconds: ex.rest_seconds,
            notes: ex.notes,
            sets: ex.sets.map((s: HevySet) => ({
              type: s.type,
              weight_kg: s.weight_kg,
              reps: s.reps,
              distance_meters: s.distance_meters,
              duration_seconds: s.duration_seconds,
              custom_metric: s.custom_metric,
            })),
          })),
        },
      }),
    });

    if (updateResp.ok) {
      console.log(`Routine ${routineId} updated with new weights`);
    } else {
      console.error(`Failed to update routine: ${updateResp.status} ${await updateResp.text()}`);
    }
  } catch (err) {
    console.error("updateRoutineWeights error:", err);
  }
}

async function sendTelegramSummary(workout: HevyWorkout, analysis: WorkoutAnalysis) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_COACH_CHAT_ID") || Deno.env.get("TELEGRAM_ALERT_CHAT_ID");

  if (!botToken || !chatId) {
    console.error("Telegram credentials not configured for coach notifications");
    return;
  }

  const lines: string[] = [];
  lines.push(`**Workout Complete: ${workout.title}**`);
  lines.push(`Duration: ${analysis.duration_min} min | Volume: ${analysis.totalVolume_lbs.toLocaleString()} lbs`);
  lines.push("");

  for (const ex of analysis.exercises) {
    const setsStr = ex.actualSets
      .map(s => `${s.reps}@${s.weight_lbs}`)
      .join(", ");

    const icon = ex.verdict === "progress" ? "+" : ex.verdict === "drop" ? "!" : "=";
    const action = ex.verdict === "progress"
      ? `-> ${ex.nextWeight_lbs} lbs next`
      : ex.verdict === "drop"
      ? `-> drop to ${ex.nextWeight_lbs} lbs`
      : "-> hold weight";

    lines.push(`${icon} ${ex.title}: ${setsStr} ${action}`);
  }

  lines.push("");
  lines.push(analysis.overallVerdict);

  const text = lines.join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err);
  }
}
