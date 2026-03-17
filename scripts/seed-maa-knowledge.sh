#!/bin/bash
# Seed maa_knowledge table from a JSON file
# Usage: ./scripts/seed-maa-knowledge.sh <input.json>
#
# Each JSON object needs: state_code, topic, title, content, source_url, source_name
# This script:
#   1. Gets embedding for each entry via the embed Edge Function
#   2. Upserts the row (with embedding) into maa_knowledge via REST API
#   3. Generates chunk_hash from content SHA-256

set -euo pipefail

INPUT_FILE="${1:?Usage: seed-maa-knowledge.sh <input.json>}"

# Load env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ATLAS_DIR="$(dirname "$SCRIPT_DIR")"

# Extract specific vars safely (avoid sourcing .env which has bash-unfriendly lines)
SUPABASE_URL=$(grep '^SUPABASE_URL=' "$ATLAS_DIR/.env" | cut -d= -f2-)
SUPABASE_ANON_KEY=$(grep '^SUPABASE_ANON_KEY=' "$ATLAS_DIR/.env" | cut -d= -f2-)

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env"
  exit 1
fi

# Count entries
TOTAL=$(python3 -c "import json,sys; print(len(json.load(open('$INPUT_FILE'))))")
echo "Seeding $TOTAL entries from $INPUT_FILE..."

SUCCESS=0
FAILED=0

# Process each entry
python3 -c "
import json, sys, subprocess, hashlib, time

with open('$INPUT_FILE') as f:
    entries = json.load(f)

supabase_url = '$SUPABASE_URL'
anon_key = '$SUPABASE_ANON_KEY'

success = 0
failed = 0

for i, entry in enumerate(entries):
    state = entry.get('state_code', 'null')
    topic = entry['topic']
    title = entry['title']
    label = f'{state}/{topic}' if state else topic
    print(f'[{i+1}/{len(entries)}] {label}...', end=' ', flush=True)

    # Step 1: Get embedding
    import urllib.request
    embed_req = urllib.request.Request(
        f'{supabase_url}/functions/v1/embed',
        data=json.dumps({'text': entry['content'][:2000]}).encode(),
        headers={
            'Authorization': f'Bearer {anon_key}',
            'Content-Type': 'application/json',
        }
    )
    try:
        with urllib.request.urlopen(embed_req) as resp:
            embed_data = json.loads(resp.read())
        embedding = embed_data['embedding']
    except Exception as e:
        print(f'EMBED FAILED: {e}')
        failed += 1
        continue

    # Step 2: Build row
    chunk_hash = hashlib.sha256(entry['content'].encode()).hexdigest()
    row = {
        'state_code': entry.get('state_code'),
        'topic': entry['topic'],
        'title': entry['title'],
        'content': entry['content'],
        'source_url': entry.get('source_url', ''),
        'source_name': entry.get('source_name', ''),
        'embedding': embedding,
        'chunk_hash': chunk_hash,
        'last_verified_at': '2026-03-15T00:00:00Z',
    }

    # Step 3: Upsert (use on_conflict for state_code+topic)
    # Try insert first, if conflict then update
    insert_req = urllib.request.Request(
        f'{supabase_url}/rest/v1/maa_knowledge',
        data=json.dumps(row).encode(),
        headers={
            'apikey': anon_key,
            'Authorization': f'Bearer {anon_key}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
        }
    )
    try:
        with urllib.request.urlopen(insert_req) as resp:
            status = resp.status
        print(f'OK ({status})')
        success += 1
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f'INSERT FAILED ({e.code}): {body[:200]}')
        failed += 1

    # Small delay to avoid rate limiting
    if (i + 1) % 5 == 0:
        time.sleep(1)

print(f'\nDone: {success} success, {failed} failed out of {len(entries)} total')
"
