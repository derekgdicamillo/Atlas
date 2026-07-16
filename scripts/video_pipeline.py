#!/usr/bin/env python3
"""
Overnight, self-contained, resumable pipeline to transcribe the Spring 2026
mentorship videos and draft NEW knowledge-base additions from them.

Phase 1 (mechanical, always runs): for each video — hydrate from OneDrive,
extract 16k mono audio (ffmpeg), transcribe (faster-whisper small.en), write a
timestamped transcript. Resumable: skips videos whose transcript already exists.

Phase 2 (best-effort): for each transcript, run headless `claude -p` restricted
to Read/Write/Glob/Grep to draft a "NEW from video" markdown (things not already
in the KB), written to a DRAFT file. It does NOT edit existing KB files and does
NOT ingest — that stays gated for Derek's review.

Keeps the machine awake while running (SetThreadExecutionState). Logs progress.
Safe to re-run: it resumes where it left off.
"""
import os, sys, json, time, shutil, subprocess, ctypes, tempfile, glob

PROJECT = r"C:\Users\Derek DiCamillo\Projects\atlas"
KB = os.path.join(PROJECT, "docs", "knowledge", "functional-medicine")
OUT = os.path.join(KB, "_video-transcripts")
SCRATCH = r"C:\Users\Derek DiCamillo\AppData\Local\Temp\claude\C--Users-Derek-DiCamillo-atlas\19710f38-d2dc-443c-bb57-ae664079d9af\scratchpad\videos"
VIDEO_ROOT = r"C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\Spring2026-Mentorship"

os.makedirs(OUT, exist_ok=True)
os.makedirs(SCRATCH, exist_ok=True)

# Map a substring of the parent folder name -> (topic slug, transcript stem)
FOLDER_MAP = [
    ("Week 1 Video Recording", "01-lab-optimization", "01-lab-optimization"),
    ("Iron & ferritin", "02-iron-ferritin", "02-iron-ferritin"),
    ("Inflammation-Immune", "03-inflammation-hashimotos", "03-inflammation-hashimotos"),
    ("MTHFR and hypothyroidism", "04-functional-hypothyroid-mthfr", "04-hypothyroid-mthfr"),
    ("Gut Health", "05-gut-health-healing", "05-gut-health"),
    ("Homework Email", "06-metabolic-syndrome", "06-metabolic-syndrome"),
    ("Chronic Kidney Disease", "07-ckd-nafld-sleep", "07-ckd-nafld-sleep"),
    ("Methylene Blue", "08-methylene-blue-ivm-ldn", "08-mb-ivm-ldn"),
    ("Bone Health", "09-bone-health", "09-bone-health"),
    ("FullScript", "10-supplements-nutrition", "10-supplements-nutrition"),
]

LOG = os.path.join(OUT, "_STATUS.log")
PROGRESS = os.path.join(OUT, "_PROGRESS.json")

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def load_progress():
    if os.path.exists(PROGRESS):
        try:
            return json.load(open(PROGRESS, encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_progress(p):
    json.dump(p, open(PROGRESS, "w", encoding="utf-8"), indent=2)

def keep_awake(on=True):
    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    try:
        if on:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        else:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    except Exception as e:
        log(f"keep_awake({on}) failed (non-fatal): {e}")

def build_manifest():
    items = []
    for path in sorted(glob.glob(os.path.join(VIDEO_ROOT, "**", "*.mp4"), recursive=True)):
        parent = os.path.basename(os.path.dirname(path))
        slug = stem = None
        for key, s, st in FOLDER_MAP:
            if key.lower() in parent.lower():
                slug, stem = s, st
                break
        if slug is None:
            log(f"WARN: no topic mapping for {parent} — skipping {os.path.basename(path)}")
            continue
        fname = os.path.basename(path)
        # two MTHFR parts -> distinct stems
        if "recording_1" in fname:
            stem = stem + "a"
        elif "recording_2" in fname:
            stem = stem + "b"
        items.append({"mp4": path, "slug": slug, "stem": stem, "topic_dir": os.path.join(KB, slug)})
    return items

def transcribe_one(item, model):
    stem = item["stem"]
    transcript_path = os.path.join(OUT, f"{stem}.transcript.txt")
    if os.path.exists(transcript_path) and os.path.getsize(transcript_path) > 200:
        log(f"SKIP transcript exists: {stem}")
        return transcript_path
    tmp_mp4 = os.path.join(SCRATCH, f"{stem}.mp4")
    tmp_wav = os.path.join(SCRATCH, f"{stem}.wav")
    try:
        log(f"HYDRATE {stem}  <- {item['mp4']}")
        shutil.copy2(item["mp4"], tmp_mp4)
        log(f"AUDIO   {stem}  (ffmpeg extract)")
        subprocess.run(["ffmpeg", "-y", "-i", tmp_mp4, "-vn", "-ac", "1", "-ar", "16000", tmp_wav],
                       check=True, capture_output=True)
        try:
            os.remove(tmp_mp4)
        except OSError:
            pass
        log(f"WHISPER {stem}  (transcribing)")
        t0 = time.time()
        segments, info = model.transcribe(tmp_wav, beam_size=5, language="en")
        with open(transcript_path, "w", encoding="utf-8") as f:
            f.write(f"# Transcript: {stem}\n# Source: {item['mp4']}\n# Duration: {info.duration/60:.1f} min\n")
            f.write(f"# Auto-generated (faster-whisper small.en). Numbers/drug names may be imperfect.\n\n")
            for s in segments:
                mm, ss = divmod(int(s.start), 60)
                f.write(f"[{mm:02d}:{ss:02d}] {s.text.strip()}\n")
        dt = time.time() - t0
        log(f"DONE    {stem}  ({info.duration/60:.1f} min audio in {dt/60:.1f} min)")
        return transcript_path
    except Exception as e:
        log(f"ERROR transcribing {stem}: {e}")
        return None
    finally:
        for p in (tmp_mp4, tmp_wav):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

def extract_one(item, transcript_path, claude_exe):
    stem = item["stem"]
    draft = os.path.join(OUT, f"{stem}.NEW-from-video.DRAFT.md")
    if os.path.exists(draft) and os.path.getsize(draft) > 100:
        log(f"SKIP draft exists: {stem}")
        return
    prompt = (
        "You are mining a lecture transcript for NEW clinical facts to add to a "
        "functional-medicine knowledge base. Derek is an FNP.\n"
        f"1. Read the transcript file: {transcript_path}\n"
        f"2. Read the existing KB files in this folder (use Glob then Read): {item['topic_dir']}\n"
        "3. Identify clinical info in the transcript that is NOT already captured in those KB files "
        "-- new doses, protocols, thresholds, product names, clinical pearls, caveats, patient cases, or nuances.\n"
        f"4. Write a concise markdown file to EXACTLY this path: {draft}\n"
        f"   Title it '# {item['slug']} -- NEW from video (DRAFT, unverified)'. For each item give the fact, an "
        "approximate [mm:ss] timestamp, and flag any number/drug-name that looks like it may be a transcription error. "
        "Do NOT restate things already in the KB. If little/nothing is new, say so briefly.\n"
        "5. Do NOT edit any existing file. Do NOT run ingest, git, or any shell command. Only read files and write the one draft.\n"
        "The transcript is auto-generated by a small speech model, so treat exact numbers and drug names as approximate."
    )
    try:
        log(f"EXTRACT {stem}  (headless claude)")
        subprocess.run(
            [claude_exe, "-p", prompt, "--allowedTools", "Read,Write,Glob,Grep"],
            cwd=PROJECT, timeout=900, capture_output=True, text=True
        )
        if os.path.exists(draft):
            log(f"DRAFT   {stem}  written")
        else:
            log(f"WARN    {stem}: claude produced no draft file")
    except subprocess.TimeoutExpired:
        log(f"TIMEOUT extract {stem} (kept transcript, skipping draft)")
    except Exception as e:
        log(f"ERROR extract {stem}: {e}")

def main():
    keep_awake(True)
    log("=== VIDEO PIPELINE START ===")
    progress = load_progress()
    manifest = build_manifest()
    log(f"{len(manifest)} videos in manifest")

    log("Loading whisper model (small.en, int8)...")
    from faster_whisper import WhisperModel
    model = WhisperModel("small.en", device="cpu", compute_type="int8")

    # Phase 1: transcription (the guaranteed-valuable output)
    transcripts = {}
    for item in manifest:
        tp = transcribe_one(item, model)
        transcripts[item["stem"]] = tp
        progress[item["stem"]] = {"transcript": bool(tp)}
        save_progress(progress)
    log("=== PHASE 1 (transcription) COMPLETE ===")

    # Phase 2: best-effort extraction drafts (no ingest, no edits to existing files)
    claude_exe = shutil.which("claude")
    if not claude_exe:
        log("claude CLI not found on PATH -- skipping extraction drafts (transcripts are done).")
    else:
        log(f"claude at {claude_exe} -- drafting NEW-from-video notes")
        for item in manifest:
            tp = transcripts.get(item["stem"])
            if tp:
                extract_one(item, tp, claude_exe)
                progress[item["stem"]]["draft"] = os.path.exists(
                    os.path.join(OUT, f"{item['stem']}.NEW-from-video.DRAFT.md"))
                save_progress(progress)
    log("=== PIPELINE COMPLETE ===  (ingest to Supabase is intentionally NOT done -- awaiting Derek's review)")
    keep_awake(False)

if __name__ == "__main__":
    main()
