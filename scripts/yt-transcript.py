#!/usr/bin/env python3
"""
YouTube Transcript Extractor for Atlas

Downloads auto-captions via yt-dlp, cleans them into plain text,
and outputs metadata + transcript. No audio download needed.

Usage:
    python scripts/yt-transcript.py <youtube_url> [--output <path>]

Output: JSON with keys: title, channel, duration, upload_date, views, url, video_id, transcript
"""

import sys
import os
import re
import json
import subprocess
import tempfile
import argparse
from pathlib import Path


def extract_video_id(url: str) -> str:
    """Extract video ID from various YouTube URL formats."""
    patterns = [
        r'(?:youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/watch\?v=)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/embed/)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/v/)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/shorts/)([a-zA-Z0-9_-]{11})',
    ]
    for pat in patterns:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


def get_metadata(url: str) -> dict:
    """Get video metadata via yt-dlp --print."""
    fields = "%(title)s|||%(channel)s|||%(duration)s|||%(upload_date)s|||%(view_count)s"
    result = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--print", fields, "--no-warnings", url],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp metadata failed: {result.stderr}")

    parts = result.stdout.strip().split("|||")
    if len(parts) < 5:
        raise RuntimeError(f"Unexpected metadata format: {result.stdout}")

    duration_secs = int(parts[2]) if parts[2].isdigit() else 0
    hours = duration_secs // 3600
    mins = (duration_secs % 3600) // 60
    secs = duration_secs % 60
    if hours > 0:
        duration_str = f"{hours}h {mins}m"
    else:
        duration_str = f"{mins}m {secs}s"

    upload_raw = parts[3]
    if len(upload_raw) == 8:
        upload_str = f"{upload_raw[:4]}-{upload_raw[4:6]}-{upload_raw[6:]}"
    else:
        upload_str = upload_raw

    return {
        "title": parts[0],
        "channel": parts[1],
        "duration_secs": duration_secs,
        "duration": duration_str,
        "upload_date": upload_str,
        "views": int(parts[4]) if parts[4].isdigit() else 0,
    }


def download_captions(url: str, tmpdir: str, video_id: str) -> str:
    """Download auto-captions as SRT. Returns path to SRT file."""
    prefix = os.path.join(tmpdir, f"yt_{video_id}")
    result = subprocess.run(
        [
            sys.executable, "-m", "yt_dlp",
            "--write-auto-sub",
            "--sub-lang", "en-orig,en",
            "--sub-format", "srt",
            "--skip-download",
            "--no-warnings",
            "-o", prefix,
            url,
        ],
        capture_output=True, text=True, timeout=120
    )

    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp caption download failed: {result.stderr}")

    # Look for the SRT file (could be .en-orig.srt or .en.srt)
    for suffix in [".en-orig.srt", ".en.srt"]:
        srt_path = prefix + suffix
        if os.path.exists(srt_path):
            return srt_path

    # Fallback: look for any .srt file in tmpdir
    for f in os.listdir(tmpdir):
        if f.endswith(".srt") and video_id in f:
            return os.path.join(tmpdir, f)

    raise RuntimeError(
        f"No SRT file found after download. yt-dlp output:\n{result.stdout}\n{result.stderr}"
    )


def parse_srt(srt_path: str) -> str:
    """Parse SRT into clean transcript text, deduplicating overlapping segments."""
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.split("\n")
    text_lines = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Skip sequence numbers
        if re.match(r"^\d+$", line):
            continue
        # Skip timestamps
        if re.match(r"^\d{2}:\d{2}:\d{2}", line):
            continue
        text_lines.append(line)

    # Deduplicate overlapping subtitle segments
    seen = set()
    unique = []
    for line in text_lines:
        if line not in seen:
            seen.add(line)
            unique.append(line)

    return " ".join(unique)


def main():
    parser = argparse.ArgumentParser(description="YouTube Transcript Extractor")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--output", "-o", help="Output file path (JSON)", default=None)
    args = parser.parse_args()

    url = args.url.strip()
    video_id = extract_video_id(url)
    if not video_id:
        print(json.dumps({"error": f"Could not extract video ID from: {url}"}))
        sys.exit(1)

    try:
        # Get metadata
        meta = get_metadata(url)

        # Download and parse captions
        with tempfile.TemporaryDirectory() as tmpdir:
            srt_path = download_captions(url, tmpdir, video_id)
            transcript = parse_srt(srt_path)

        result = {
            "title": meta["title"],
            "channel": meta["channel"],
            "duration_secs": meta["duration_secs"],
            "duration": meta["duration"],
            "upload_date": meta["upload_date"],
            "views": meta["views"],
            "url": url,
            "video_id": video_id,
            "transcript_words": len(transcript.split()),
            "transcript": transcript,
        }

        if args.output:
            out_path = Path(args.output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            print(f"Saved to {out_path}")
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
