# Pitch script: 4 minutes and 1 minute of questions

One person talks, one person drives the laptop and puts the parts under the sensor. Everything you show is the real
optoNCDT 5500 measuring real parts: there is no simulator and no recording behind it.

The story: a laser sensor that measures to a micrometre becomes a quality station that anyone on the shop floor
understands. It counts every part, photographs it, flags the wrong one the moment it lands, gives every part a
passport and says what is going on.

## Before you go on stage (10 minutes earlier)

1. Sensor warm (30 minutes on), `.\scripts\run.ps1` running, browser on `http://localhost:8000` in full screen (F11).
   Press **Unlock** in the top bar if it asks for the token.
2. The top bar says **Live** and the **Sensor** panel on the left says Connection: Live.
3. **Part check** tab: plate empty, **Teach the empty plate** (only if the plate shows a reading; without it the
   passport cannot show the height above the plate). If it says the plate is outside the measuring range, that is fine: skip it. Then one good part in the laser spot, **Teach this part**.
   Take the part away: "Nothing under the sensor" and nothing is flagged.
4. **Part log** tab, **New run**, **Clear the part log**: the counter starts at 0 on stage.
5. Press **C** for the camera. Check the picture is upright (turn it with the rotate button) and drag it into a
   corner where it covers nothing. Put a part down once and check the photo shows the part.
6. The right column shows the 3D model small. Leave it there: you make it big on stage.
7. Phones: `cloudflared tunnel --url http://localhost:8000` running, the address pasted under **Q** once.
8. Try your manual question once (for example "What is the measuring range of the ILD5500-10?") and check the answer
   names the page.
9. Sound up. Five good parts and two different ones (a taller and a lower one) on the table, within reach.
10. Do not leave a part under the sensor while you wait: after a few parts the station knows the rhythm and a part
    that lies there longer than 6 s is a "possible jam". Before the first part it says nothing.

## 0:00 The problem (30 s)

"Micro-Epsilon sensors measure to a micrometre. But on the shop floor nobody wants curves. They want to know: is this
the right part, is the line running, is something about to go wrong. Our cockpit turns one laser sensor into a quality
station that answers exactly that, and says it out loud."

Point at the big reading and the gauge: the measuring range comes from the data sheet, the live signal runs below.

## 0:30 Bring the jury in (20 s)

Press **Q**. "Please scan this with your phones." Wait until the top bar counts a few phones, press **Q** again.
"Your phones are now the shop floor's alarm."

## 0:50 The line runs (60 s)

Press **⇄ 3D model large** (or double-click the small 3D model): the 3D model moves to the middle, the live signal
to the right. Put good parts under the laser one after the other: put one down, count to two, take it away, wait
about three seconds, the next one. Faster than 2 s between parts is a "possible double feed".

- "We taught it one good part. That is all the setup there is."
- Each part shows up green in the 3D model, and the counter in the Part log panel goes up the moment it leaves.
- "Every part gets a number, its height measured to a micrometre, and a photo." Point at the camera picture: it says
  "Part N photographed".

## 1:50 The wrong part (40 s)

Put a different part under the laser.

- Within half a second the part in the 3D model turns red, the alert appears, every phone in the room flashes and
  Epsilon says "Different part detected", with how much higher or lower it is than the taught part.
- "No threshold to type, no program to write: it knows the good part, so everything else is flagged."

Take it away and put a good part back: green again. Press **⇄ Live signal large**: the moment of the wrong part is
shaded red in the signal.

## 2:30 The part passport (25 s)

Open the **Part log** tab and click the red part.

- "Every part has a passport: the photo taken while it lay under the sensor, its height, how far it is from the taught
  part, when it came and every alert while it was there."
- "Scan the code and the passport is on your phone. That is traceability for every single part."

Close it with **Escape**.

## 2:55 Ask it (35 s)

Hold **Space** (or type):

- "How many parts so far?" Epsilon gives the count, how many were good and the yield.
- "Show me the height of every part." The chart opens: a green band for the taught part, a dot per part, the red dot
  for the foreign one.
- Your manual question. Epsilon answers from the Micro-Epsilon manuals and names the page.

"Every number it says comes from the measurement, and every manual answer from the real manual. The language model
only phrases it."

## 3:30 The run report (15 s)

Open the **Report** tab (or press **R**). "The whole run on one page: every part, every alert, likely causes and next
steps. Scan the code and it is on your phone, and the part log goes to Excel with one click."

## 3:45 Close (15 s)

"One sensor, one good part taught, and the line is watched: every part counted, measured and photographed, the wrong
one caught at once, a jam, a double feed or a creeping height trend reported before it costs scrap. And with
Micro-Epsilon's MEDAQLib, any of their sensors plugs in the same way. Thank you."

## Questions you may get

| Question | Answer |
| --- | --- |
| Two different parts with the same height? | The sensor sees the height of the top surface only, so it cannot tell them apart, and we say so. The photo in the passport shows it to a person; a second sensor or a profile scanner would see the shape. |
| How does it know a part is there? | It cuts the 20 kHz signal into 50 ms frames. Half a second of something that is not the empty plate is a part; the plate showing for 0.15 s ends it. |
| How fast is the alert? | About half a second: the part must rest that long so a part that is still sliding in is not flagged. |
| Does the AI make numbers up? | No. Counts, heights and limits come from tool calls on the data, manual answers from the Micro-Epsilon PDFs with the page. The model only phrases them. |
| Where does the photo come from? | Any camera on the laptop, here a phone over USB. The cockpit takes the picture while the part lies under the sensor and stores it with the part number. |
| What is the trend warning? | A straight line through the heights of the last good parts. When it is clear and points to the edge of the band, it says in how many parts the parts will leave it. A worn tool or a fixture that moves does this. |
| More sensors? | Each sensor is a few lines in the sensor file; the cockpit, the 3D model and the alerts take any number. MEDAQLib finds Micro-Epsilon sensors on Ethernet and USB by itself. |
| What if the sensor fails? | The cockpit says what the sensor reports, for example no target or outside the measuring range, with the page of the manual, and reconnects by itself. |

## If something fails on stage

| Problem | Do this |
| --- | --- |
| The AI voice does not connect | Type the questions in the box: the same commands work, Epsilon answers in text and with the browser voice. |
| Phones cannot join | Go on without them; the alert still shows on the big screen. |
| The camera picture is black or gone | Press **C** twice. If it stays black, go on: the passport still has every number, only without the photo. |
| Taking a part away raises "Different part" | The empty plate was not taught (or the plate moved): **Part check**, **Teach the empty plate**. |
| The counter does not count | Teach the good part again in the **Part check** tab, with the part in the laser spot. |
| A "possible jam" pops up while you talk | "It noticed that a part has been lying there far longer than the parts before. On a line that is a jam." Take the part away. |
| The cockpit says "sensor not connected" | Check the Ethernet cable. The cockpit reconnects by itself within seconds. |
| The 3D model is blank | Press **⇄ Live signal large** and go on with the live signal; the counter, the alerts and the charts still work. |
