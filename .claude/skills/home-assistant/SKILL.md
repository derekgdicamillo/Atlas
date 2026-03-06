---
name: home-assistant
description: >-
  Control Home Assistant smart home devices. Use when Derek says anything about
  lights, thermostat, temperature, locks, doors, garage, sensors, scenes,
  automations, or smart home control. Also triggered by /ha or /home.
allowed-tools:
  - Bash
  - Read
context: fork
user-invocable: true
argument-hint: "[command or device name]"
---
# Home Assistant Control

Interact with Derek's Home Assistant via REST API. For connection details and auth token, see `references/api-reference.md`. For confirmed entity IDs, see `references/entities.md`.

## Handling $ARGUMENTS

If user passes a command (e.g., `/ha turn off living room light`):
- Parse the intent (device + action) and execute directly
- Use confirmed entities from `references/entities.md` first, then fuzzy-match if needed

If user passes "status" or no arguments:
- Run dashboard summary (fetch all states, summarize by domain)

## Natural Language Mapping

| Derek says | Action |
|---|---|
| "turn off the lights" | Turn off all light.* and switch.* light entities |
| "turn off the living room light" | `switch/turn_off` on `switch.living_room_light` |
| "set the thermostat to 72" | `climate/set_temperature` on `climate.main_floor` |
| "make it cooler" | Reduce current target by 2 degrees |
| "lock the front door" | Confirm first, then `lock/lock` on `lock.front_door_lock` |
| "is the front door open?" | Check `binary_sensor.front_door` |
| "turn on the fan" | `fan/turn_on` on `fan.master_bedroom_fan` |
| "set fan to low/medium/high" | `fan/set_percentage` with 33/66/100 |
| "who's home?" | Check person.* entities |
| "goodnight" | Look for bedtime scene/automation |
| "what's the temperature?" | Check `climate.main_floor` current_temperature |
| "home status" | Run full dashboard summary |

## Entity Name Matching
1. Check confirmed entities in `references/entities.md` first
2. If no match, fetch all states and fuzzy-match `attributes.friendly_name`
3. If multiple matches, ask Derek to clarify

## Dashboard Summary Format
```
Home Dashboard
--------------
Lights: X on, Y off [list any ON]
Climate: [current] / set to [target] / [mode]
Doors: [open count] [list any OPEN]
Locks: [locked/unlocked] [list any UNLOCKED]
People Home: [list]
```
Only include sections with entities.

## Troubleshooting

### Error: TLS exit code 35 (curl)
Windows schannel TLS negotiation failure with Nabu Casa remote URL. Retry once. If persistent, fall back to local HA URL (check `references/api-reference.md` for local IP).

### Error: 401 Unauthorized
Long-lived access token expired or revoked. Derek needs to regenerate in HA > Profile > Long-Lived Access Tokens. Update the token in .env.

### Error: 404 entity not found
Entity ID changed (common after HA updates or device re-pairing). Steps:
1. Fetch all states: GET /api/states
2. Search for the device by friendly_name
3. Update `references/entities.md` with the new entity ID

### Entity shows "unavailable"
Device is offline, unplugged, out of Zigbee/Z-Wave range, or battery dead. Not a software issue. Tell Derek which device is unavailable.

### Error: 400 Bad Request on service call
Wrong service for the domain. Common mistakes:
- Using `light/turn_on` on a `switch` entity (use `switch/turn_on`)
- Using `climate/set_temperature` without `temperature` parameter
- Calling `lock/lock` on an already-locked device (harmless but returns 400)

### Thermostat won't change temperature
Check current HVAC mode. If mode is "off", set mode to "heat" or "cool" first, then set temperature. Some thermostats reject temperature changes while off.

### Multiple matches for a device name
If fuzzy matching returns 2+ entities, list them all with entity IDs and friendly names, then ask Derek to clarify. Don't guess.
