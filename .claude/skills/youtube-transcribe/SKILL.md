---
name: youtube-transcribe
description: >-
  Transcribe YouTube videos and generate summaries with key points and action items.
  Use when Derek shares a YouTube link, says "transcribe this video", "summarize this
  YouTube", or any request involving a YouTube URL. Also triggered by /youtube-transcribe.
allowed-tools:
  - Bash
  - Read
  - Write
context: fork
user-invocable: true
argument-hint: "[youtube-url]"
metadata:
  author: Atlas
  version: 2.0.0
---

# YouTube Transcribe

Download YouTube auto-captions via yt-dlp, then summarize the content.

## Instructions

### Step 1: Extract the URL

Parse `$ARGUMENTS` for a YouTube URL. Accept any format:
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtube.com/shorts/VIDEO_ID`

If no URL found in arguments, respond: "Need a YouTube URL to transcribe."

### Step 2: Download transcript

Run the helper script. This uses yt-dlp to grab YouTube auto-captions (no audio download needed, fast):

```bash
python C:/Users/Derek DiCamillo/Projects/atlas/scripts/yt-transcript.py "THE_URL" --output C:/Users/Derek DiCamillo/Projects/atlas/tmp/yt-VIDEOID.json
```

If this fails:
- "No supported JavaScript runtime" warning is harmless, ignore it
- If captions not available, say so. Not all videos have auto-captions.
- If yt-dlp itself fails, try updating: `python -m pip install -U yt-dlp`

### Step 3: Read and summarize

Read the JSON output file. It contains: title, channel, duration, upload_date, views, video_id, transcript.

Generate a summary markdown file at `data/task-output/youtube-VIDEOID.md` with this structure:

```markdown
# YouTube Summary: VIDEO TITLE

**Channel:** Channel Name
**Video:** URL
**Length:** Duration
**Published:** Date
**Views:** Count
**Date Summarized:** Today's date

---

## Key Points
- Bold key concept, then explanation (5-10 bullet points)

---

## Actionable Takeaways
1. Numbered, specific actions Derek could apply to PV MediSpa or his workflow

---

## Frameworks & Strategies Discussed
| Framework | What It Is |
|-----------|-----------|
| Name | One-line description |

---

## Bottom Line
2-3 sentence summary of the video's core value proposition and how it relates to Derek's work.
```

### Step 4: Respond

Give Derek a concise Telegram-friendly summary (not the full file). Include:
- Video title and channel
- 3-5 key takeaways (the most interesting/useful ones)
- Note that full summary is saved to `data/task-output/youtube-VIDEOID.md`

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| yt-dlp not found | Not in PATH | Use `python -m yt_dlp` (the script does this) |
| No captions available | Video has no auto-captions | Tell user, no workaround |
| Timeout | Video metadata slow | Retry once, yt-dlp has 60s timeout built in |
| JS runtime warning | yt-dlp wants deno/node | Harmless warning, ignore |
