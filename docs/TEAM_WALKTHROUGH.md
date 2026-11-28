# Team walkthrough

Everything a team member needs to run the cockpit with the real optoNCDT 5500, rehearse it without the sensor and
answer for what it does. The pitch itself is in `DEMO_SCRIPT.md`.

## 1. Run it (Windows)

1. `git pull` in `U:\ki-cockpit-v2` (or wherever the project is).
2. `cd frontend`, `npm install`, `npm run build`, `cd ..`
3. `.\scripts\run.ps1`
4. Chrome or Edge: `http://localhost:8000/?token=<COCKPIT_TOKEN from backend\.env>`, then Ctrl+F5.

`backend\.env` holds `SENSORS_FILE=config/sensors.live.yaml`, the token and the OpenAI key. Never commit it.

## 2. What you should see

- Top bar: "Target in measuring range (live data)".
- Sensor tile: the reading in mm, the gauge with the measuring range (0 to 10 mm, extended −2.5 to 12.5 mm),
  "Live sensor 20 kHz 169.254.168.150".
- The twin: the sensor on its gantry, the laser, the plate, the measuring range as a faint violet band.

## 3. Teach, then run parts

1. Plate empty: **Part check** in the tile, **Teach the empty plate**.
2. One good part under the laser, still: **Teach this part**. The tile says "Taught part", the twin paints it green.
3. Take it away: "Nothing under the sensor", no alert. The counter appears in the tile.
4. Put parts down and take them away, one after the other. Each one is counted when it leaves.
5. A different part: red in the twin and the tile, the alert in the copilot and on the phones.
6. Click the counter: the **Quality station** sheet with the counts, the yield, the rhythm, the trend and the list of
   parts. From here: **Height of every part**, **Bar chart**, **Height spread**, **Download for Excel**, **New run**.

How a part is found: the signal is cut into 50 ms frames. A frame near the taught empty plate is "plate", anything
else with valid readings is "something on the plate". Half a second of something is a part; the plate showing for
0.15 s ends it. Its height is the empty plate minus its top surface, from the steady readings while it rested.

The station's alerts:

| Alert | When |
| --- | --- |
| Different part | The part check: a steady reading outside the band of the taught part (±0.10 mm unless changed). |
| Possible jam | After three parts: a part stays longer than 6 s (and longer than 1.5 usual stays). Once per part, while it is still there. |
| Possible double feed | After three parts: a part comes less than 2 s after the previous one (and sooner than half the usual gap). |
| Height trend | After eight good parts: a clear straight line through their heights (R² ≥ 0.6) that reaches the edge of the band within 40 parts. Critical within 10. |

## 4. Ask Epsilon

Hold **Space** and speak, or type in the box. With the OpenAI key Epsilon understands free questions; without it the
typed and spoken commands below still work.

- "How many parts so far?", "what was the last part?", "is there a trend?"
- "Show me a bar chart" (good and different parts per minute), "show the part heights", "show a histogram".
- "Explain this chart": the steps are computed from the data and marked on the chart one by one.
- "Write a report", "status", "teach this part", "how do I mount this sensor?" (needs the manuals).

## 5. Rehearse without the sensor

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\fake_ild5500.py --scenario line --after 15
```

Put `LIVE_SENSOR_HOST=127.0.0.1` in `backend\.env` (take it out again for the real sensor) and start the cockpit.
The plate shows for 15 s: teach it. Part 1 rests 8 s: teach it. Then parts come every 3 s, part 7 is foreign, part 12
follows almost at once, part 18 stays 14 s, and the parts slowly get lower until they leave the band.

## 6. Known limits (say these out loud if asked)

- The sensor sees the height of the top surface only: a different part of the same height passes as good.
- Two equal parts that follow each other without the plate showing in between are counted as one that stayed long.
- The station needs the empty plate taught; without it taking a part away would itself look like a foreign part.
- MEDAQLib plug and play was built from the manual and tested with a stand-in for the DLL, not with the real sensor.

## 7. Where things are

| What | Where |
| --- | --- |
| Sensor connection | `backend/app/sources/ild5500.py`, MEDAQLib in `medaqlib.py` |
| Part check | `backend/app/partcheck.py` |
| Quality station | `backend/app/station.py`, part charts in `part_charts.py` |
| Reports | `backend/app/report.py` |
| The voice copilot's tools and instructions | `backend/app/realtime.py`, `frontend/src/controller.ts` |
| Digital twin | `frontend/src/lib/twin.ts` |
| Quality station sheet | `frontend/src/components/PartsPanel.tsx` |
| Taught part, part log | `backend/data/part_reference.json`, `backend/data/part_log.jsonl` (git-ignored) |
