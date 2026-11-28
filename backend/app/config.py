"""Configuration loading.

Two files hold everything a team is expected to change:

* ``backend/.env``                      secrets and runtime switches (API key, model, port, token)
* ``backend/config/sensors.live.yaml``  the sensor, how it is connected, and the alert thresholds

A sensor of a known model (the optoNCDT ILD5500 family) gets its data sheet from ``sensor_specs``: with
``tolerance: measuring_range`` the limits are the sensor's own measuring range, and readings are shown in the
millimetres the sensor itself reports.

The rest of the code reads the frozen :class:`Settings` object built here.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

from .sensor_specs import SensorSpec, find_spec, known_models

log = logging.getLogger("cockpit.config")

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"

load_dotenv(BACKEND_DIR / ".env", override=False)

# where the numbers come from; sources.register_source adds more (the tests add their simulated sensor)
SOURCE_TYPES = {"ild5500", "medaqlib"}
EVENT_KINDS = ("out_of_range", "invalid", "wrong_part", "jam", "double_feed", "trend")
# keys an older sensor file may still contain; they are read and ignored
RETIRED_KEYS = {"fixture", "settings", "part_rpm", "vibration_window_s", "vibration_ratio", "vibration_min_hz",
                "vibration_min_prominence", "noise_window_s", "noise_ratio", "noise_hold_s", "drift_window_s",
                "drift_min_rate_per_min", "drift_min_r2", "drift_hold_s", "drift_critical_minutes"}


class ConfigError(ValueError):
    """Raised when sensors.yaml or .env contains an invalid value."""


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from exc


_VARIABLE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def expand_env(value: Any, where: str) -> Any:
    """Replace ${NAME} and ${NAME:-default} in a text value by the entry in .env (or the default).

    This keeps addresses out of the sensor file: the file says ${LIVE_SENSOR_HOST:-169.254.168.150} and the
    laptop that runs the demo only has to set LIVE_SENSOR_HOST in backend/.env when the address differs."""
    if not isinstance(value, str) or "${" not in value:
        return value

    def fill(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        found = os.getenv(name)
        if found is not None and found.strip() != "":
            return found.strip()
        if default is not None:
            return default
        raise ConfigError(f"{where} uses ${{{name}}} but {name} is not set in backend/.env")

    return _VARIABLE.sub(fill, value)


@dataclass(frozen=True)
class Tolerance:
    low: float
    high: float

    def contains(self, value: float) -> bool:
        return self.low <= value <= self.high

    def as_dict(self) -> dict[str, float]:
        return {"low": self.low, "high": self.high}


@dataclass(frozen=True)
class Display:
    """How positions are shown when the sensor reports another unit than the signal: the optoNCDT shows
    millimetres, the cockpit computes in micrometres (3 decimals of a millimetre would hide the noise)."""

    unit: str = "mm"
    scale: float = 0.001        # signal unit times scale gives the display unit
    decimals: int = 4

    def text(self, value: float, decimals: int | None = None) -> str:
        digits = self.decimals if decimals is None else decimals
        return f"{value * self.scale:.{digits}f} {self.unit}"

    def as_dict(self) -> dict[str, Any]:
        return {"unit": self.unit, "scale": self.scale, "decimals": self.decimals}


@dataclass(frozen=True)
class SensorConfig:
    id: str
    name: str
    model: str
    unit: str
    nominal: float
    tolerance: Tolerance
    source: dict[str, Any]
    spec: SensorSpec | None = None         # the data sheet of a known model
    display: Display | None = None         # positions in the sensor's own unit (mm), signal stays in µm
    tolerance_kind: str = "part"           # part (limits of the workpiece) | measuring_range (of the sensor)

    @property
    def source_type(self) -> str:
        return str(self.source.get("type", ""))

    @property
    def limit_word(self) -> str:
        """What the limits are called in texts: the part's tolerance, or the sensor's measuring range."""
        return "measuring range" if self.tolerance_kind == "measuring_range" else "tolerance"

    def pos(self, value: float, digits: int = 1, signed: bool = True) -> str:
        """A position or a limit as text. In the sensor's own millimetres when there is a display unit,
        otherwise in the signal unit, signed like +6.0 µm."""
        if self.display is not None:
            return self.display.text(value)
        if signed:
            text = f"{0:.{digits}f}" if abs(value) < 0.5 * 10 ** -digits else f"{value:+.{digits}f}"
        else:
            text = f"{value:.{digits}f}"
        return f"{text} {self.unit}"

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "unit": self.unit,
            "nominal": self.nominal,
            "tolerance": self.tolerance.as_dict(),
            "tolerance_kind": self.tolerance_kind,
            "limit_word": self.limit_word,
            "display": self.display.as_dict() if self.display else None,
            "spec": self.spec.public() if self.spec else None,
            "source": self.source_type,
        }


@dataclass(frozen=True)
class DetectionConfig:
    eval_interval_s: float = 0.25
    baseline_s: float = 20.0            # the noise shown in the sensor tile is learned from this much data
    invalid_window_s: float = 1.0
    invalid_min_share: float = 0.2
    out_of_range_window_s: float = 0.5
    rearm_s: float = 3.0
    cooldown_s: dict[str, float] = field(
        default_factory=lambda: {
            "out_of_range": 30.0,
            "invalid": 20.0,
        }
    )


@dataclass(frozen=True)
class EngineConfig:
    analysis_rate_hz: int = 500
    fast_buffer_s: int = 600
    slow_buffer_s: int = 28800
    backfill_s: int = 900


@dataclass(frozen=True)
class CockpitConfig:
    title: str = "KI Sensor Cockpit"
    team: str = "Team Name"
    assistant_name: str = "Epsilon"
    language: str = "en"


@dataclass(frozen=True)
class Settings:
    openai_api_key: str
    realtime_model: str
    realtime_voice: str
    transcribe_model: str
    cockpit_token: str
    host: str
    port: int
    sensors_file: Path
    cockpit: CockpitConfig
    engine: EngineConfig
    detection: DetectionConfig
    sensors: tuple[SensorConfig, ...]
    # manuals and recommendations (all optional; the defaults work without a .env entry)
    embed_model: str = "text-embedding-3-small"
    knowledge_dir: Path = Path(__file__).resolve().parent.parent / "data" / "knowledge"
    openai_base_url: str = "https://api.openai.com/v1"
    # written answers from the manuals (Manuals panel) and the typed chat when voice is off
    # the manual library the answers come from: knowledge_dir plus these folders (all of a manufacturer's
    # operating instructions, for example); vectors are cut to embed_dimensions to keep them small
    manual_library: tuple[Path, ...] = ()
    embed_dimensions: int = 512
    answer_model: str = "gpt-5-mini"
    answer_reasoning: str = "low"
    chat_model: str = "gpt-5-mini"
    chat_reasoning: str = "low"

    @property
    def voice_enabled(self) -> bool:
        return bool(self.openai_api_key)

    def sensor(self, sensor_id: str) -> SensorConfig:
        for sensor in self.sensors:
            if sensor.id == sensor_id:
                return sensor
        raise KeyError(sensor_id)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _as_float(value: Any, where: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{where} must be a number, got {value!r}") from exc


def _parse_display(raw: Any, unit: str, kind: str, where: str) -> Display | None:
    """``display: mm`` (or {unit: mm, decimals: 4}) shows positions in millimetres; the signal stays in µm."""
    if raw is None:
        return Display() if kind == "measuring_range" and unit == "µm" else None
    if raw is False or str(raw).strip().lower() in ("none", "off", "false", "no"):
        return None
    settings = {"unit": raw} if isinstance(raw, str) else dict(raw) if isinstance(raw, dict) else None
    if settings is None:
        raise ConfigError(f"{where}.display must be mm or a mapping like {{unit: mm, decimals: 4}}")
    if str(settings.get("unit", "mm")).strip().lower() != "mm":
        raise ConfigError(f"{where}.display.unit: only mm is supported")
    if unit != "µm":
        raise ConfigError(f"{where}.display needs the sensor's unit to be µm, not {unit!r}")
    decimals = int(_as_float(settings.get("decimals", Display.decimals), f"{where}.display.decimals"))
    if not 0 <= decimals <= 6:
        raise ConfigError(f"{where}.display.decimals must be between 0 and 6")
    return Display(decimals=decimals)


def _parse_sensor(raw: dict[str, Any], index: int) -> SensorConfig:
    where = f"sensors[{index}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} must be a mapping")
    sensor_id = str(raw.get("id", "")).strip()
    if not sensor_id:
        raise ConfigError(f"{where}.id is required")
    model = str(raw.get("model", "unknown model"))
    unit = str(raw.get("unit", "µm"))

    # The data sheet: named in "spec", or recognised from the model text (optoNCDT ILD5500-10 and so on).
    spec_name = raw.get("spec")
    if spec_name is not None:
        spec = find_spec(str(spec_name))
        if spec is None:
            raise ConfigError(f"{where}.spec {spec_name!r} is not a known model; use one of: {known_models()}")
    else:
        spec = find_spec(model)

    tol_raw = raw.get("tolerance")
    tolerance_kind = "part"
    if isinstance(tol_raw, str):
        word = tol_raw.strip().lower().replace(" ", "_").replace("-", "_")
        if word not in ("measuring_range", "range"):
            raise ConfigError(f"{where}.tolerance must be {{low: .., high: ..}} or measuring_range, got {tol_raw!r}")
        if spec is None:
            raise ConfigError(f"{where}.tolerance: measuring_range needs a known sensor model. Put the model "
                              f"from the sensor label into 'model' (known: {known_models()}).")
        if unit != "µm":
            raise ConfigError(f"{where}.tolerance: measuring_range needs the unit µm, not {unit!r}")
        tolerance = Tolerance(low=spec.low_um, high=spec.high_um)
        tolerance_kind = "measuring_range"
    else:
        tol_raw = tol_raw or {}
        tolerance = Tolerance(
            low=_as_float(tol_raw.get("low", -50.0), f"{where}.tolerance.low"),
            high=_as_float(tol_raw.get("high", 50.0), f"{where}.tolerance.high"),
        )
        if tolerance.low >= tolerance.high:
            raise ConfigError(f"{where}.tolerance.low must be below tolerance.high")

    nominal_raw = raw.get("nominal", 0.0)
    if isinstance(nominal_raw, str) and nominal_raw.strip().lower() == "auto":
        nominal = spec.mid_um if tolerance_kind == "measuring_range" and spec else (tolerance.low + tolerance.high) / 2
    else:
        nominal = _as_float(nominal_raw, f"{where}.nominal")

    source = {key: expand_env(value, f"{where}.source.{key}")
              for key, value in dict(raw.get("source") or {}).items()}
    if source.get("type") not in SOURCE_TYPES:
        raise ConfigError(f"{where}.source.type must be one of {', '.join(sorted(SOURCE_TYPES))}, "
                          f"got {source.get('type')!r}")
    if source.get("type") == "ild5500" and spec is not None:
        given = source.get("range_mm")
        if given not in (None, "") and str(given).strip() != str(int(spec.measuring_range_mm)):
            log.warning("%s: source.range_mm %s does not match %s (%g mm); the model decides", where, given,
                        spec.model, spec.measuring_range_mm)
        source["range_mm"] = int(spec.measuring_range_mm)
        if tolerance_kind == "measuring_range":
            reference = str(source.get("reference_mm", "range_start")).strip().lower()
            if reference != "range_start":
                raise ConfigError(f"{where}.tolerance: measuring_range counts from the start of the measuring "
                                  f"range, so source.reference_mm must be range_start (it is {reference!r})")
            source["reference_mm"] = "range_start"
            if str(source.get("invert", False)).strip().lower() in ("1", "true", "yes", "on"):
                raise ConfigError(f"{where}.tolerance: measuring_range cannot be combined with source.invert: "
                                  "the readings are distances from the start of the range")

    for key in RETIRED_KEYS & set(raw):
        log.info("%s.%s is no longer used and is ignored", where, key)
    return SensorConfig(
        id=sensor_id,
        name=str(raw.get("name", sensor_id)),
        model=model,
        unit=unit,
        nominal=nominal,
        tolerance=tolerance,
        source=source,
        spec=spec,
        display=_parse_display(raw.get("display"), unit, tolerance_kind, where),
        tolerance_kind=tolerance_kind,
    )


def _parse_detection(raw: dict[str, Any] | None) -> DetectionConfig:
    raw = dict(raw or {})
    defaults = DetectionConfig()
    cooldown = dict(defaults.cooldown_s)
    cooldown.update({str(k): float(v) for k, v in (raw.pop("cooldown_s", None) or {}).items()})
    values: dict[str, Any] = {}
    for key, value in raw.items():
        if key in RETIRED_KEYS:
            log.info("detection.%s is no longer used and is ignored", key)
            continue
        if not hasattr(defaults, key):
            raise ConfigError(f"detection.{key} is not a known setting")
        values[key] = _as_float(value, f"detection.{key}")
    return DetectionConfig(cooldown_s=cooldown, **values)


def _parse_engine(raw: dict[str, Any] | None) -> EngineConfig:
    raw = raw or {}
    defaults = EngineConfig()
    values = {}
    for key in ("analysis_rate_hz", "fast_buffer_s", "slow_buffer_s", "backfill_s"):
        values[key] = int(raw.get(key, getattr(defaults, key)))
    if values["analysis_rate_hz"] < 50:
        raise ConfigError("engine.analysis_rate_hz must be at least 50")
    return EngineConfig(**values)


def load_settings(sensors_file: str | Path | None = None) -> Settings:
    """Read .env and the sensor file into an immutable Settings object."""
    path = Path(sensors_file or _env("SENSORS_FILE", "config/sensors.live.yaml"))
    if not path.is_absolute():
        path = BACKEND_DIR / path
    if not path.exists():
        raise ConfigError(f"Sensor file not found: {path}")
    with path.open(encoding="utf-8") as handle:
        doc = yaml.safe_load(handle) or {}

    sensors_raw = doc.get("sensors") or []
    if not sensors_raw:
        raise ConfigError(f"{path.name} defines no sensors")
    sensors = tuple(_parse_sensor(raw, i) for i, raw in enumerate(sensors_raw))
    ids = [s.id for s in sensors]
    if len(ids) != len(set(ids)):
        raise ConfigError("sensor ids must be unique")

    cockpit_raw = doc.get("cockpit") or {}
    cockpit = CockpitConfig(
        title=str(cockpit_raw.get("title", CockpitConfig.title)),
        team=str(cockpit_raw.get("team", CockpitConfig.team)),
        assistant_name=str(cockpit_raw.get("assistant_name", CockpitConfig.assistant_name)),
        language=str(cockpit_raw.get("language", CockpitConfig.language)),
    )

    return Settings(
        openai_api_key=_env("OPENAI_API_KEY"),
        realtime_model=_env("OPENAI_REALTIME_MODEL", "gpt-realtime-mini"),
        realtime_voice=_env("OPENAI_REALTIME_VOICE", "marin"),
        transcribe_model=_env("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
        cockpit_token=_env("COCKPIT_TOKEN"),
        host=_env("HOST", "0.0.0.0"),
        port=_env_int("PORT", 8000),
        sensors_file=path,
        cockpit=cockpit,
        engine=_parse_engine(doc.get("engine")),
        detection=_parse_detection(doc.get("detection")),
        sensors=sensors,
        embed_model=_env("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
        knowledge_dir=Path(_env("KNOWLEDGE_DIR", str(Path(__file__).resolve().parent.parent / "data" / "knowledge"))),
        openai_base_url=_env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        manual_library=tuple(Path(p.strip()) for p in _env("MANUAL_LIBRARY_DIRS").split(";") if p.strip()),
        embed_dimensions=_env_int("OPENAI_EMBED_DIMENSIONS", 512),
        answer_model=_env("OPENAI_ANSWER_MODEL", "gpt-5-mini"),
        answer_reasoning=_env("OPENAI_ANSWER_REASONING", "low").lower(),
        chat_model=_env("OPENAI_CHAT_MODEL", "gpt-5-mini"),
        chat_reasoning=_env("OPENAI_CHAT_REASONING", "low").lower(),
    )
