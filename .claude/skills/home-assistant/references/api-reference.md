# Home Assistant API Reference

## Connection Details
- **Primary URL (Nabu Casa)**: `https://gyvpqd2lbetf4alq976scwymn7b95u64.ui.nabu.casa/api`
- **Fallback URL (local)**: `http://192.168.50.68:8123/api`
- **Auth Token**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkNDk5ODAyZDMxNDQ0N2M5ODRmZjNkMTViOTAwNWE3YSIsImlhdCI6MTc3MTY1NjcyMiwiZXhwIjoyMDg3MDE2NzIyfQ.pYyZjF1RiPjFqwXxCYoTrlUmyvc9x_HgdyzSzzWiKVA`
- **Headers**: `Authorization: Bearer <token>` and `Content-Type: application/json`

**Token rule:** Always read from this file. Never truncate or hardcode partial values.

## URL Strategy
1. Try Nabu Casa remote URL first
2. If TLS error (exit code 35), retry primary once (known Windows schannel issue)
3. If still failing, try local fallback
4. If both fail, report to Derek

## API Patterns

### GET states
```bash
curl -s --connect-timeout 5 -H "Authorization: Bearer <TOKEN>" "<BASE_URL>/states"
```

### GET single entity
```bash
curl -s --connect-timeout 5 -H "Authorization: Bearer <TOKEN>" "<BASE_URL>/states/<entity_id>"
```

### POST service call
```bash
curl -s --connect-timeout 5 -X POST "<BASE_URL>/services/<domain>/<service>" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d "{\"entity_id\": \"<entity_id>\"}"
```

## Service Mapping
| Domain | Services |
|--------|----------|
| `light` | `turn_on`, `turn_off`, `toggle` |
| `switch` | `turn_on`, `turn_off`, `toggle` |
| `fan` | `turn_on`, `turn_off`, `set_percentage` |
| `climate` | `set_temperature`, `set_hvac_mode`, `set_fan_mode` |
| `lock` | `lock`, `unlock` |
| `cover` | `open_cover`, `close_cover`, `stop_cover` |
| `scene` | `turn_on` |
| `automation` | `trigger`, `turn_on`, `turn_off` |

## Common Domains for Entity Filtering
light, switch, sensor, binary_sensor, climate, lock, cover, fan, media_player, camera, automation, scene, input_boolean, person

## Climate (Thermostat)
Entity: `climate.main_floor`. HVAC modes: heat, cool, heat_cool (auto), off, fan_only.
Temperature is Fahrenheit (Arizona, USA).

## History API
```bash
curl -s --connect-timeout 5 -H "Authorization: Bearer <TOKEN>" "<BASE_URL>/history/period/<ISO_TIMESTAMP>?filter_entity_id=<entity_id>&minimal_response&no_attributes"
```
Generate timestamp: `powershell -Command "[System.DateTime]::UtcNow.AddHours(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')"`

## Important Notes
- Always use `--connect-timeout 5` and `-s` on curl calls
- Parse JSON responses. Don't dump raw JSON.
- Entity IDs are case-sensitive, snake_case
- For security actions (unlock, disarm), confirm with Derek first
- Fan speeds: low=33, medium=66, high=100
