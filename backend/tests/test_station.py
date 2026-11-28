"""The quality station: every part that rests under the sensor becomes one entry of the part log."""

from __future__ import annotations

import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import explore, report
from app.buffer import SensorBuffer
from app.main import create_app
from app.partcheck import PartCheck
from app.station import Station

TOKEN = {"X-Cockpit-Token": "test-token"}
RATE = 500
STEP_S = 0.25
PLATE = 8000.0        # the empty plate, µm from the start of the measuring range
PART = 2000.0         # the top surface of the good part: 6 mm above the plate
OTHER = 3500.0        # a foreign part, 1.5 mm lower than the good one


class Line:
    """A sensor buffer on a manual clock with the part check and the quality station watching it."""

    def __init__(self, settings, tmp_path=None, path=None):
        self.sid = settings.sensors[0].id
        self.rng = np.random.default_rng(3)
        self.buf = SensorBuffer(RATE, 600, 3600)
        self.t = 1_700_000_000.0
        self.check = PartCheck(settings.sensors, None if tmp_path is None else tmp_path / "part.json")
        self.parts = []
        self.station = Station(settings.sensors, self.check,
                               path if path is not None else (None if tmp_path is None else tmp_path / "log.jsonl"),
                               on_part=lambda sid, part: self.parts.append(part))
        self.events = []
        self._since_eval = 0.0

    def hold(self, value, seconds, noise=1.0):
        """Hold the target at ``value`` µm for ``seconds``, watching every 0.25 s like the cockpit does."""
        left = seconds
        while left > 1e-9:
            step = min(0.05, left)
            n = int(round(step * RATE))
            self.t += n / RATE
            self.buf.append(np.full(n, float(value)) + self.rng.normal(0.0, noise, n), self.t)
            left -= n / RATE
            self._since_eval += n / RATE
            if self._since_eval >= STEP_S - 1e-9:
                self._since_eval = 0.0
                self.events.extend(self.check.evaluate({self.sid: self.buf}, self.t))
                self.events.extend(self.station.evaluate({self.sid: self.buf}, self.t))

    def teach(self):
        """Teach the empty plate and the good part, as the operator does before the run."""
        self.hold(PLATE, 2.0)
        self.check.learn(self.sid, self.buf, "empty")
        self.hold(PART, 2.0)
        self.check.learn(self.sid, self.buf, "part")

    def part(self, value=PART, stay=2.0, gap=1.0):
        self.hold(value, stay)
        self.hold(PLATE, gap)

    @property
    def records(self):
        return self.station.records(self.sid)

    def kinds(self):
        return [e.kind for e in self.events]


@pytest.fixture()
def line(settings, tmp_path):
    return Line(settings, tmp_path)


def test_nothing_is_counted_before_the_plate_and_the_part_are_taught(line):
    line.hold(PLATE, 2.0)
    line.part(PART, 2.0, 1.0)
    info = line.station.public(line.sid, line.t)
    assert line.records == [] and info["ready"] is False and "empty plate" in info["message"]
    line.check.learn(line.sid, line.buf, "empty")          # the plate alone is not enough either
    line.part(PART, 2.0, 1.0)
    assert line.records == []


def test_every_part_is_counted_with_its_height_and_verdict(line):
    line.teach()
    line.hold(PLATE, 1.0)                                    # the taught part leaves: that was part 1
    line.part(PART, 2.0, 1.0)
    line.part(OTHER, 2.0, 1.0)
    line.part(PART + 30, 3.0, 1.0)
    records = line.records
    assert [r.number for r in records] == [1, 2, 3, 4]
    assert [r.verdict for r in records] == ["good", "good", "different", "good"]
    assert records[1].height_um == pytest.approx(PLATE - PART, abs=3)
    assert records[2].height_um == pytest.approx(PLATE - OTHER, abs=3)
    assert records[1].dwell_s == pytest.approx(2.0, abs=0.15)
    assert records[3].dwell_s == pytest.approx(3.0, abs=0.15)
    assert records[2].gap_s == pytest.approx(1.0, abs=0.15)
    assert len(line.parts) == 4 and line.parts[-1]["number"] == 4      # each part is announced once
    info = line.station.public(line.sid, line.t)
    assert (info["parts"], info["good"], info["different"]) == (4, 3, 1)
    assert info["yield_percent"] == 75.0
    assert info["rhythm"]["known"] and info["rhythm"]["dwell_s"] == pytest.approx(2.0, abs=0.2)


def test_a_part_must_rest_before_it_counts(line):
    line.teach()
    line.hold(PLATE, 1.0)
    line.hold(PART, 0.3)                                     # a hand passing through the beam
    line.hold(PLATE, 1.0)
    assert len(line.records) == 1


def test_a_short_glimpse_of_the_plate_separates_two_equal_parts(line):
    line.teach()
    line.hold(PLATE, 1.0)
    line.hold(PART, 2.0)
    line.hold(PLATE, 0.3)                                    # the next part follows almost at once
    line.hold(PART, 2.0)
    line.hold(PLATE, 1.0)
    assert len(line.records) == 3
    assert line.records[2].gap_s == pytest.approx(0.3, abs=0.12)


def test_a_part_replaced_by_another_without_the_plate_showing_is_two_parts(line):
    line.teach()
    line.hold(PLATE, 1.0)
    line.hold(PART, 2.0)
    line.hold(OTHER, 2.0)                                    # pushed out by a foreign part
    line.hold(PLATE, 1.0)
    assert [r.verdict for r in line.records] == ["good", "good", "different"]


def test_a_part_that_stays_far_too_long_is_a_possible_jam(line):
    line.teach()
    line.hold(PLATE, 1.0)
    for _ in range(4):
        line.part(PART, 2.0, 1.0)
    line.hold(PART, 5.5)
    assert "jam" not in line.kinds()                         # not yet: the limit is 6 s
    line.hold(PART, 1.0)
    assert line.kinds().count("jam") == 1
    assert "jam" in line.station.active_kinds(line.sid)
    jam = next(e for e in line.events if e.kind == "jam")
    assert jam.numbers["usual_stay_s"] == pytest.approx(2.0, abs=0.3) and "Possible jam" in jam.summary
    line.hold(PART, 10.0)
    assert line.kinds().count("jam") == 1                    # once per part
    line.hold(PLATE, 1.0)
    assert line.station.active_kinds(line.sid) == []
    assert "jam" in line.records[-1].flags
    assert line.station.public(line.sid, line.t)["jams"] == 1


def test_a_part_that_follows_far_too_soon_is_a_possible_double_feed(line):
    line.teach()
    line.hold(PLATE, 2.0)
    for _ in range(4):
        line.part(PART, 2.0, 5.0)
    assert "double_feed" not in line.kinds()
    line.hold(PART, 2.0)
    line.hold(PLATE, 2.5)                                    # 2.5 s is no double feed ...
    line.hold(PART, 2.0)
    line.hold(PLATE, 1.5)                                    # ... 1.5 s is one
    line.hold(PART, 2.0)
    line.hold(PLATE, 2.0)
    assert line.kinds().count("double_feed") == 1
    event = next(e for e in line.events if e.kind == "double_feed")
    assert event.numbers["gap_s"] == pytest.approx(1.5, abs=0.12)
    assert event.numbers["usual_gap_s"] == pytest.approx(5.0, abs=0.3)
    assert "double_feed" in line.records[-1].flags


def test_no_rhythm_alerts_before_the_rhythm_is_known(line):
    line.teach()
    line.hold(PART, 20.0)                                    # the first part stays a long time
    line.hold(PLATE, 0.3)
    line.part(PART, 2.0, 1.0)
    assert "jam" not in line.kinds() and "double_feed" not in line.kinds()


def test_good_parts_that_drift_towards_the_edge_give_one_trend_warning(line):
    line.teach()
    line.hold(PLATE, 1.0)
    for k in range(1, 11):                                   # each part 6 µm lower than the one before
        line.part(PART + 6.0 * k, 2.0, 1.0)
    trends = [e for e in line.events if e.kind == "trend"]
    assert len(trends) == 1
    assert "lower" in trends[0].summary and trends[0].numbers["parts_to_limit"] < 40
    info = line.station.public(line.sid, line.t)["trend"]
    assert info["clear"] and info["slope_um_per_part"] == pytest.approx(6.0, abs=0.5)


def test_parts_that_scatter_without_a_direction_give_no_trend(line):
    line.teach()
    line.hold(PLATE, 1.0)
    rng = np.random.default_rng(5)
    for _ in range(14):
        line.part(PART + rng.normal(0.0, 15.0), 2.0, 1.0)
    assert "trend" not in line.kinds()


def test_the_part_log_survives_a_restart_and_a_new_run_clears_it(settings, tmp_path):
    first = Line(settings, tmp_path)
    first.teach()
    first.hold(PLATE, 1.0)
    first.part(PART, 2.0, 1.0)
    assert len(first.records) == 2
    again = Line(settings, tmp_path)                         # the same files, as after a restart
    assert [r.number for r in again.records] == [1, 2]
    again.station.new_run(again.sid, again.t)
    assert again.records == [] and (tmp_path / "log.jsonl").read_text() == ""
    assert Line(settings, tmp_path).records == []


def test_a_damaged_part_log_keeps_the_readable_lines(settings, tmp_path):
    first = Line(settings, tmp_path)
    first.teach()
    first.hold(PLATE, 1.0)
    path = tmp_path / "log.jsonl"
    path.write_text(path.read_text() + "{not json\n", encoding="utf-8")
    assert len(Line(settings, tmp_path).records) == 1


# -- through the cockpit ----------------------------------------------------------------------------


@pytest.fixture()
def client(settings):
    # without "with": the acquisition loop does not run, so only the parts fed below reach the buffer
    return TestClient(create_app(settings))


def run_line(engine, sid, parts):
    """Feed the engine's buffer directly and let the part check and the station watch it."""
    line = Line(engine.settings)
    line.sid, line.buf = sid, engine.buffers[sid]
    line.check, line.station = engine.partcheck, engine.station
    line.t = time.time() - 120.0                            # the part charts count back from now
    line.teach()
    line.hold(PLATE, 1.0)
    for value, stay in parts:
        line.part(value, stay, 1.0)
    for event in line.events:
        engine.publish_event(event)
    return line


def test_the_endpoints_show_the_log_and_need_the_token_to_reset(client):
    engine = client.app.state.engine
    info = client.get("/api/parts/s1").json()
    assert info["ready"] is False and info["parts"] == 0
    run_line(engine, "s1", [(PART, 2.0), (OTHER, 2.0)])
    data = client.get("/api/parts/s1?limit=10").json()
    assert data["parts"] == 3 and [r["number"] for r in data["records"]] == [3, 2, 1]
    assert data["records"][0]["verdict"] == "different"
    csv = client.get("/api/parts/s1/csv")
    assert csv.status_code == 200 and "attachment" in csv.headers["content-disposition"]
    rows = csv.text.lstrip("﻿").strip().splitlines()
    assert rows[0].startswith("part;start;") and len(rows) == 4
    assert client.post("/api/parts/s1/reset").status_code == 401
    assert client.post("/api/parts/s1/reset", headers=TOKEN).json()["parts"] == 0
    status = client.get("/api/status").json()["sensors"]["s1"]
    assert status["station"]["ready"] is True and status["station"]["parts"] == 0


def test_the_part_charts_explain_the_log(client):
    engine = client.app.state.engine
    empty = explore.build(engine, "parts", ["s1"])
    assert empty["parts"] == [] and "Teach" in empty["insights"][0]["text"]
    run_line(engine, "s1", [(PART + 3.0 * k, 2.0) for k in range(9)] + [(OTHER, 2.0)])
    parts = explore.build(engine, "parts", ["s1"])
    assert parts["counts"] == {"parts": 11, "good": 10, "different": 1}
    assert parts["band"]["low"] < PLATE - PART < parts["band"]["high"]
    assert any(s["anchor"] and s["anchor"]["type"] == "point" and s["anchor"]["x"] == 11 for s in parts["insights"])
    counts = explore.build(engine, "part_counts", ["s1"])
    assert sum(counts["good"]) == 10 and sum(counts["different"]) == 1 and counts["group_by"] == "minute"
    heights = explore.build(engine, "part_heights", ["s1"])
    series = heights["series"][0]
    assert sum(series["counts"]) == 11 and series["outside"] == 1 and heights["per"] == "parts"
    assert client.get("/api/explore?chart=part_counts&sensors=s1").status_code == 200


def test_a_report_on_a_jam_shows_the_heights_of_the_last_parts(client):
    engine = client.app.state.engine
    run_line(engine, "s1", [(PART, 2.0)] * 4 + [(PART, 14.0)])
    jam = engine.last_event("jam", "s1")
    assert jam is not None
    rep = report.build(engine, jam.id)
    assert rep["title"].startswith("Possible jam")
    assert any(c["type"] == "parts" for c in rep["charts"])
    assert any("stuck" in c for c in rep["causes"])
    html = client.get(f"/report/{jam.id}").text
    assert "part number" in html and "Time under the sensor" in html


def test_the_run_report_lists_every_part_and_alert(client):
    engine = client.app.state.engine
    run_line(engine, "s1", [(PART, 2.0), (OTHER, 2.0)])
    page = client.get("/run-report/s1")
    assert page.status_code == 200
    assert "Quality station" in page.text and "different part" in page.text and "Different part" in page.text
    assert page.text.count("<tr class='good'>") == 2 and page.text.count("<tr class='different'>") == 1
    assert client.get("/run-report/nope").status_code in (400, 404)


def test_teaching_the_plate_as_the_part_is_refused(line):
    from app.partcheck import PartCheckError
    line.hold(PLATE, 2.0)
    line.check.learn(line.sid, line.buf, "empty")
    with pytest.raises(PartCheckError, match="empty plate"):
        line.check.learn(line.sid, line.buf, "part")              # nothing in the laser spot


def test_teaching_the_empty_plate_where_the_part_was_taught_is_refused(line):
    from app.partcheck import PartCheckError
    line.hold(PLATE, 2.0)
    line.check.learn(line.sid, line.buf, "part")                  # the mix-up: the plate taught as the part
    with pytest.raises(PartCheckError, match="Forget what was taught"):
        line.check.learn(line.sid, line.buf, "empty")


def test_without_a_visible_plate_no_reading_stands_for_the_empty_plate(line):
    nothing = float("nan")                                   # the plate is outside the measuring range
    line.hold(nothing, 1.0)
    line.hold(PART, 2.0)
    line.check.learn(line.sid, line.buf, "part")
    line.hold(nothing, 1.0)
    line.part(PART, 2.0, 0)
    line.hold(nothing, 1.0)
    line.part(OTHER, 2.0, 0)
    line.hold(nothing, 1.0)
    assert [r.verdict for r in line.records] == ["good", "good", "different"]
    assert line.records[1].height_um is None


JPEG = b"\xff\xd8\xff\xe0" + b"0" * 200 + b"\xff\xd9"


def test_a_part_photo_shows_in_the_passport_the_log_and_the_alert_report(client):
    engine = client.app.state.engine
    assert client.post("/api/parts/s1/2/photo", content=JPEG).status_code == 401
    run_line(engine, "s1", [(PART, 2.0), (OTHER, 2.0)])
    up = client.post("/api/parts/s1/3/photo", content=JPEG, headers=TOKEN)
    assert up.json()["url"] == "/photos/s1/3.jpg"
    assert client.post("/api/parts/s1/3/photo", content=b"not a jpeg", headers=TOKEN).status_code == 400
    assert client.get("/photos/s1/3.jpg").content == JPEG
    assert client.get("/photos/s1/2.jpg").status_code == 404
    records = client.get("/api/parts/s1?limit=5").json()["records"]
    assert records[0]["photo"] == "/photos/s1/3.jpg" and records[1]["photo"] is None
    page = client.get("/part/s1/3").text
    assert "Part 3" in page and "Different part" in page and "/photos/s1/3.jpg" in page
    assert "No camera picture" in client.get("/part/s1/2").text
    assert client.get("/part/s1/99").status_code == 404
    wrong = engine.last_event("wrong_part", "s1")
    rep = report.build(engine, wrong.id)
    assert rep["part"] == 3 and rep["photo"] == "/photos/s1/3.jpg"
    assert "/photos/s1/3.jpg" in client.get(f"/report/{wrong.id}").text
    client.post("/api/parts/s1/reset", headers=TOKEN)
    assert client.get("/photos/s1/3.jpg").status_code == 404
