# FB Intake Implementation Guide

This document describes how the skill orchestrates the bulk ingest workflow.

## Flow

1. **Collect Images**
   - If $ARGUMENTS is a folder path: glob for *.{jpg,jpeg,png,webp}
   - If direct paths: use them
   - If no images: fail with usage message

2. **Prep & Chunk**
   - Create tmp/fb-intake directory, clean old chunks
   - Split images into chunks of 8
   - Calculate total chunks

3. **Spawn Subagents** (Parallel)
   - For each chunk: spawn an Agent with specific image paths
   - Each agent extracts to tmp/fb-intake/chunk-NN.json
   - Each agent returns only the count, not the data

4. **Monitor & Merge**
   - Wait for all subagents to complete
   - Check that all chunk files exist
   - If any missing: re-spawn that chunk
   - Run merge command to combine all chunks into merged.json

5. **Upload**
   - Call `bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json`
   - Parse JSON output (summary stats)

6. **Report**
   - Display summary: Added X | Updated Y | Already Z | No email N | Errors E
   - Show FB Group Leads total
   - Show audit file path
   - If errors or no-email: list those names

## Key Constraints

- **Fork context**: Cannot modify main window memory or call main session tools
- **Skill tools**: Only Read, Glob, Grep, Bash, Agent allowed
- **No screenshots in main context**: Subagents handle image reading
- **Disk-only data**: Contact JSON never returned in subagent replies
- **No screening**: All valid emails go to Brevo

