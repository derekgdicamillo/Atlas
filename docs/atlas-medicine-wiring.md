# Atlas Medicine -- Relay Wiring Guide

## Overview
This documents the exact changes needed in `src/relay.ts` to add the Atlas Medicine bot.

## Environment Variable
Add to `.env`:
```
MEDICINE_BOT_TOKEN=<token from @BotFather>
```

## relay.ts Changes

### 1. Bot token initialization (top of file, near other token declarations)

**Current:**
```typescript
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ISHTAR_BOT_TOKEN = process.env.ISHTAR_BOT_TOKEN || "";
const COACH_BOT_TOKEN = process.env.COACH_BOT_TOKEN || "";
```

**Add:**
```typescript
const MEDICINE_BOT_TOKEN = process.env.MEDICINE_BOT_TOKEN || "";
```

### 2. Bot instantiation (near other `new Bot()` calls)

**Current:**
```typescript
const bot = new Bot(BOT_TOKEN);
const ishtarBot = ISHTAR_BOT_TOKEN ? new Bot(ISHTAR_BOT_TOKEN) : null;
const coachBot = COACH_BOT_TOKEN ? new Bot(COACH_BOT_TOKEN) : null;
```

**Add:**
```typescript
const medicineBot = MEDICINE_BOT_TOKEN ? new Bot(MEDICINE_BOT_TOKEN) : null;
```

### 3. allBots array

**Current:**
```typescript
const allBots: Bot[] = [bot, ...(ishtarBot ? [ishtarBot] : []), ...(coachBot ? [coachBot] : [])];
```

**Change to:**
```typescript
const allBots: Bot[] = [bot, ...(ishtarBot ? [ishtarBot] : []), ...(coachBot ? [coachBot] : []), ...(medicineBot ? [medicineBot] : [])];
```

### 4. botIdFromCtx function

**Current:**
```typescript
function botIdFromCtx(ctx: Context): string {
  const token = (ctx as any).api?.token;
  if (token === COACH_BOT_TOKEN) return "coach";
  if (token === ISHTAR_BOT_TOKEN) return "ishtar";
  return "atlas";
}
```

**Change to:**
```typescript
function botIdFromCtx(ctx: Context): string {
  const token = (ctx as any).api?.token;
  if (token === MEDICINE_BOT_TOKEN) return "medicine";
  if (token === COACH_BOT_TOKEN) return "coach";
  if (token === ISHTAR_BOT_TOKEN) return "ishtar";
  return "atlas";
}
```

### 5. Startup/polling section
Find where `coachBot` starts polling and add the same pattern for `medicineBot`:

```typescript
if (medicineBot) {
  medicineBot.start({ onStart: () => log.info("Medicine bot polling") });
}
```

### 6. Graceful shutdown
Add `medicineBot` to the shutdown handler alongside other bots.

## agents.json
The agent config entry with `"id": "medicine"` is already added to `config/agents.json`. The relay uses `botIdFromCtx()` to resolve the agent ID, which maps to the agent config via the `id` field.

## Knowledge Base
Clinical knowledge files live in `docs/knowledge/`. The system prompt references these domains, and the agent can read them via tool access at runtime.
