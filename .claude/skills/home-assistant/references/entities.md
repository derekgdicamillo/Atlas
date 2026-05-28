# Confirmed Home Assistant Entity IDs

These entities have been verified against the live HA instance (2026-05-23).

## Lights
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `light.family_room_light` | Family Room Light | Z-Wave, also has switch.family_room_light |
| `light.master_bedroom_light` | Master Bedroom Light | Also has switch.master_bedroom_light |
| `light.kitchen_sliding_door_light` | Kitchen Sliding Door Light | Also has switch.kitchen_sliding_door_light |
| `light.master_shower_light` | Master Shower Light | Z-Wave, electric consumption tracked |
| `light.master_shower_led` | Master Shower Led | Also has switch.smart_switch_6 |
| `light.hallway_light` | Hallway Light | -- removed or renamed, not found in current states |
| `light.front_porch_floodlight` | Front Porch Floodlight | Reolink camera floodlight |
| `light.backyard_floodlight` | BackYard Floodlight | Reolink camera floodlight |
| `light.side_door_floodlight` | Side door Floodlight | Reolink camera floodlight |
| `light.side_door_status_led` | Side door Status LED | Camera status indicator |
| `light.lizzy_heat_lamp` | Lizzy Heat Lamp | Also has light.lizzy_heat_lamp_2, switch.lizzy_heat_lamp |
| `light.smart_switch_6` | Master Shower LED | Duplicate entity for master shower LED |

## Switches (on/off only, no dimming)
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `switch.family_room_light` | Family Room Light | Use switch/turn_on, not light/turn_on |
| `switch.family_room_ceiling_fan` | Family Room Ceiling Fan | Simple on/off for fan |
| `switch.back_porch_light` | Back Porch Light | Z-Wave switch |
| `switch.kitchen_sliding_door_light` | Kitchen Sliding Door Light | Z-Wave switch |
| `switch.master_bedroom_light` | Master Bedroom Light | Z-Wave switch |
| `switch.smart_switch_6` | Master Shower Led | Z-Wave switch, energy monitoring |
| `switch.lizzy_heat_lamp` | Lizzy Heat Lamp | Z-Wave switch, energy monitoring |

**Important:** Many devices exist as BOTH light.* and switch.* entities. For simple on/off, use the `switch.*` entity with `switch/turn_on` and `switch/turn_off` services.

## Fans
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `fan.master_bedroom_fan` | Master Bedroom Fan | Speed in 33% steps (low/med/high) |
| `fan.family_room_ceiling_fan` | Family Room Ceiling Fan | Also has switch.family_room_ceiling_fan |

## Climate
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `climate.thermostat_thermostat` | Thermostat Thermostat | Main thermostat. Modes: off, heat, cool. Currently UNAVAILABLE |
| `climate.derek_s_device` | MiniSplit | Mini-split AC. Modes: cool, heat, fan_only, dry, heat_cool, off. Currently UNAVAILABLE |

**Note:** Both climate entities are currently unavailable, likely due to Z-Wave/device connectivity issues. The old `climate.main_floor` entity ID no longer exists.

## Locks
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `lock.office_door_lock` | Office Door Lock | Z-Wave, battery: 100% |
| `lock.side_door_lock` | Side Door Lock | Z-Wave, battery: 100% |

**Note:** The old `lock.front_door_lock` entity no longer exists. Current locks are office door and side door.

## Door/Window Sensors (via lock status binary sensors)
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `binary_sensor.office_door_lock_current_status_of_the_door` | Office Door Lock Current status | on=closed, off=open |
| `binary_sensor.side_door_lock_current_status_of_the_door` | Side Door Lock Current status | on=closed, off=open |

**Note:** The old `binary_sensor.front_door` and `binary_sensor.back_door` entities no longer exist. Door status is now tracked via the lock's built-in sensors.

## Cameras (Reolink)
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `camera.front_porch` | Front Porch | Motion, person, vehicle, animal detection |
| `camera.backyard` | BackYard | Motion, person, vehicle, animal detection |
| `camera.front_doorbell` | Front Doorbell | Motion, person, vehicle, pet, visitor detection |
| `camera.garageinside` | GarageInside | Motion, person, vehicle, animal detection |
| `camera.side_door` | Side door | Motion, person, vehicle, animal detection |
| `camera.prairie_d_security` | Prairie D Security | Additional security camera |

## Motion/Person Detection (binary_sensor)
| Entity ID | Friendly Name |
|-----------|---------------|
| `binary_sensor.front_porch_motion` | Front Porch Motion |
| `binary_sensor.front_porch_person` | Front Porch Person |
| `binary_sensor.backyard_motion` | BackYard Motion |
| `binary_sensor.backyard_person` | BackYard Person |
| `binary_sensor.front_doorbell_motion` | Front Doorbell Motion |
| `binary_sensor.front_doorbell_person` | Front Doorbell Person |
| `binary_sensor.garageinside_motion` | GarageInside Motion |
| `binary_sensor.side_door_motion` | Side door Motion |
| `binary_sensor.side_door_person` | Side door Person |

## Vacuum
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `vacuum.roborock_q_revo` | Roborock Q Revo | Docked. Services: start, stop, return_to_base, locate |

## Media Players
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `media_player.shield_living_room` | SHIELD Living Room | NVIDIA Shield, currently playing |
| `media_player.tv` | TV | Currently playing |
| `media_player.garage` | Garage | Sonos/speaker, idle |

## People
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `person.derek_dicamillo` | Derek DiCamillo | Tracked via HA Companion app |
| `person.esther` | Esther | |

## Automations
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `automation.heat_house_in_morning` | Heat House In Morning | Enabled |
| `automation.cool_house_evening` | Cool House Evening | Enabled |
| `automation.lizzy_light_on` | Lizzy Light On | Enabled |
| `automation.lizzy_lamp_off` | Lizzy Lamp Off | Enabled |
| `automation.fan_off_in_am` | Fan off in AM | Enabled |

## Network
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `sensor.zenwifi_et9_9f40_download_speed` | Download Speed | Mbps |
| `sensor.zenwifi_et9_9f40_upload_speed` | Upload Speed | Mbps |
| `sensor.zenwifi_et9_9f40_external_ip` | External IP | |

## Key Sensors
| Entity ID | Friendly Name | Notes |
|-----------|---------------|-------|
| `sensor.derek_cell_battery_level` | Derek's Phone Battery | Percentage |
| `sensor.derek_cell_geocoded_location` | Derek's Location | Address string |
| `sensor.derek_cell_blood_glucose` | Derek's Blood Glucose | mg/dL |
| `sensor.derek_cell_daily_steps` | Derek's Daily Steps | Count |
| `sensor.office_door_lock_battery_level` | Office Door Lock Battery | Percentage |
| `sensor.side_door_lock_battery_level` | Side Door Lock Battery | Percentage |

## Removed/Renamed Entities (no longer exist)
These were in the old entity list but are NOT in the current HA instance:
- `climate.main_floor` -> now `climate.thermostat_thermostat`
- `lock.front_door_lock` -> removed (current locks: office_door_lock, side_door_lock)
- `binary_sensor.front_door` -> removed (use lock-based door sensors)
- `binary_sensor.back_door` -> removed
- `switch.living_room_light` -> removed
- `switch.girls_room_light` -> removed
- `switch.office_light` -> removed
- `switch.front_porch_light` -> removed (floodlight is `light.front_porch_floodlight`)
- `switch.back_patio_light` -> removed (now `switch.back_porch_light`)
- `light.hallway_light` -> removed from current states
- `light.master_bathroom_vanity_lights` -> removed from current states
