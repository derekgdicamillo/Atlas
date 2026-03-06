# Confirmed Home Assistant Entity IDs

These entities have been verified and are known to exist.

## Lights & Switches
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `switch.master_bedroom_light` | Master Bedroom Light | Simple on/off switch |
| `light.master_shower_light` | Master Shower Light | |
| `light.master_bathroom_vanity_lights` | Master Bathroom Vanity Lights | Brightness, color temp |
| `switch.living_room_light` | Living Room Light | Simple on/off switch |
| `switch.girls_room_light` | Girls Room Light | Simple on/off switch |
| `switch.office_light` | Office Light | Simple on/off switch |
| `light.hallway_light` | Hallway Light | Brightness support |
| `switch.front_porch_light` | Front Porch Light | Simple on/off switch |
| `switch.back_patio_light` | Back Patio Light | Simple on/off switch |

**Important:** Some "lights" are `switch.*` entities (no dimming). Use `switch/turn_on` for those.

## Fans
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `fan.master_bedroom_fan` | Master Bedroom Fan | Speed in 33% steps |

## Climate
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `climate.main_floor` | Main Floor Thermostat | Honeywell T6 Pro Z-Wave. Modes: heat, cool, auto. Fan: auto, on |

## Locks
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `lock.front_door_lock` | Front Door Lock | Schlage BE469NX |

## Sensors
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `binary_sensor.front_door` | Front Door Sensor | Open/closed |
| `binary_sensor.back_door` | Back Door Sensor | Open/closed |
