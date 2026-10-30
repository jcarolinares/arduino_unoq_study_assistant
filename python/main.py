# SPDX-FileCopyrightText: Copyright (C) 2026 jcarolinares
#
# SPDX-License-Identifier: GPL-3.0-or-later

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.video_objectdetection import VideoObjectDetection
import json
import os
import threading
import time

logger = Logger("StudyAssistant")

PHONE_LABEL = "cell phone"
NEW_EVENT_GAP_SEC = 3.0      # A phone seen after this many seconds without one counts as a new detection
BEEP_COOLDOWN_SEC = 2.0      # While a phone stays in view, beep at most this often
PHONE_IN_VIEW_SEC = 3.0      # A phone counts as "in view" until this long after it was last seen
PHONE_PAUSE_MIN_SEC = 10.0   # The focus timer stays paused at least this long after a phone is seen
HISTORY_DAYS = 8             # Keep detection events and sessions for the weekly chart
TIMER_MODES = {"focus": 25 * 60, "short": 5 * 60, "long": 15 * 60}
LONG_BREAK_EVERY = 4         # Every 4th completed focus session is followed by a long break

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
EVENTS_FILE = os.path.join(DATA_DIR, "phone_events.json")
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")

# LED matrix states, must match the State enum in sketch.ino
MATRIX_IDLE, MATRIX_FOCUS, MATRIX_PAUSED, MATRIX_PHONE, MATRIX_BREAK, MATRIX_DONE, MATRIX_RESUMED = range(7)
MATRIX_PIXELS = 8 * 13
CELEBRATE_SEC = 5.0          # How long the "session complete" animation plays
RESUMED_SEC = 2.0            # How long the check mark shows after the timer resumes

# Buzzer sounds, must match SOUNDS in sketch.ino
SOUND_PHONE, SOUND_DONE, SOUND_BREAK_OVER, SOUND_START = range(4)

ui = WebUI()
detection_stream = VideoObjectDetection(confidence=0.5, debounce_sec=0.0)



def on_sensitivity(sid, value):
  detection_stream.override_threshold(float(value))


ui.on_message("override_th", on_sensitivity)

APP_STARTED = time.time()   # Lets open dashboards notice the app restarted and reload the new version
lock = threading.Lock()
bridge_lock = threading.Lock()
last_seen = 0.0
last_beep = 0.0


def load_list(path: str) -> list:
  try:
    with open(path) as f:
      return json.load(f)
  except Exception:
    return []


def save_list(path: str, data: list):
  try:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
      json.dump(data, f)
    os.replace(tmp, path)
  except Exception as e:
    logger.warning(f"Could not save {path}: {e}")


def prune(items: list, now: float, key=lambda x: x) -> list:
  cutoff = now - HISTORY_DAYS * 86400
  return [x for x in items if key(x) >= cutoff]


events = [float(t) for t in load_list(EVENTS_FILE)]  # Epoch timestamps (seconds) of each phone detection
sessions = load_list(SESSIONS_FILE)                   # Completed focus sessions: {"t": epoch, "minutes": 25}


def bridge_call(method: str, *args):
  try:
    with bridge_lock:
      Bridge.call(method, *args, timeout=2)
  except Exception as e:
    logger.warning(f"Bridge call {method} failed: {e}")


def play_sound(sound: int):
  bridge_call("play_sound", sound)


# ---------- Focus timer (runs on the board so it works without the web page) ----------
class FocusTimer:
  def __init__(self):
    self.mode = "focus"
    self.remaining = float(TIMER_MODES["focus"])
    self.end_at = None            # Epoch time when the running timer reaches zero
    self.phone_paused_at = None   # Set while paused because a phone was detected
    self.celebrate_until = 0.0
    self.resumed_until = 0.0
    self.completed = 0            # Focus sessions completed since the app started

  @property
  def duration(self) -> int:
    return TIMER_MODES[self.mode]

  @property
  def running(self) -> bool:
    return self.end_at is not None

  def _sync(self, now: float):
    if self.running:
      self.remaining = max(0.0, self.end_at - now)

  def start(self, now: float):
    if not self.running:
      self.phone_paused_at = None
      self.end_at = now + self.remaining
      if self.mode == "focus" and self.remaining >= self.duration - 1:
        play_sound(SOUND_START)

  def pause(self, now: float):
    self._sync(now)
    self.end_at = None
    self.phone_paused_at = None

  def set_mode(self, mode: str):
    if mode in TIMER_MODES:
      self.mode = mode
      self.remaining = float(self.duration)
      self.end_at = None
      self.phone_paused_at = None

  def reset(self):
    self.set_mode(self.mode)

  def pause_for_phone(self, now: float):
    if self.mode == "focus" and self.running:
      self._sync(now)
      self.end_at = None
      self.phone_paused_at = now
      logger.info("Focus timer paused: phone detected")

  def tick(self, now: float) -> bool:
    """Advances the timer. Returns True when the state changed in a way the UI should know about."""
    changed = False
    if self.phone_paused_at is not None:
      if now - self.phone_paused_at >= PHONE_PAUSE_MIN_SEC and now - last_seen >= PHONE_IN_VIEW_SEC:
        self.phone_paused_at = None
        self.end_at = now + self.remaining
        self.resumed_until = now + RESUMED_SEC
        logger.info("Focus timer resumed: phone gone")
        changed = True
    self._sync(now)
    if self.running and self.remaining <= 0:
      if self.mode == "focus":
        sessions.append({"t": now, "minutes": self.duration // 60})
        sessions[:] = prune(sessions, now, key=lambda s: s["t"])
        save_list(SESSIONS_FILE, sessions)
        self.completed += 1
        self.set_mode("long" if self.completed % LONG_BREAK_EVERY == 0 else "short")
        self.end_at = now + self.remaining  # Breaks start on their own
        self.celebrate_until = now + CELEBRATE_SEC
        play_sound(SOUND_DONE)
        logger.info("Focus session complete")
      else:
        self.set_mode("focus")
        play_sound(SOUND_BREAK_OVER)
        logger.info("Break over")
      changed = True
    return changed

  def matrix_state(self, now: float) -> tuple:
    focus_progress = int((1 - self.remaining / self.duration) * MATRIX_PIXELS) if self.mode == "focus" else 0
    if now < self.celebrate_until:
      return MATRIX_DONE, 0
    if now - last_seen < PHONE_IN_VIEW_SEC:
      return MATRIX_PHONE, 0
    if self.phone_paused_at is not None:
      return MATRIX_PAUSED, focus_progress
    if now < self.resumed_until:
      return MATRIX_RESUMED, 0
    if self.running:
      return (MATRIX_FOCUS, focus_progress) if self.mode == "focus" else (MATRIX_BREAK, 0)
    if self.remaining < self.duration:
      return MATRIX_PAUSED, focus_progress
    return MATRIX_IDLE, 0

  def to_message(self) -> dict:
    return {
      "mode": self.mode,
      "duration": self.duration,
      "remaining": round(self.remaining, 1),
      "running": self.running,
      "phone_paused": self.phone_paused_at is not None,
      "sessions": sessions,
      "app_started": APP_STARTED,
    }


timer = FocusTimer()


def send_timer():
  ui.send_message("timer", message=timer.to_message())


def on_timer_cmd(sid, cmd):
  action = (cmd or {}).get("action")
  now = time.time()
  with lock:
    if action == "start":
      timer.start(now)
    elif action == "pause":
      timer.pause(now)
    elif action == "reset":
      timer.reset()
    elif action == "mode":
      timer.set_mode(cmd.get("mode", "focus"))
  send_timer()


ui.on_message("timer_cmd", on_timer_cmd)


# ---------- Phone detection statistics ----------
def send_stats():
  # The browser turns the timestamps into "today", hourly and weekly stats using its local time zone
  ui.send_message("stats", message={"events": events, "server_time": time.time()})


def on_get_stats(sid, _data=None):
  send_stats()
  send_timer()


ui.on_message("get_stats", on_get_stats)


# Called on every frame where a cell phone is detected
def on_phone_detected():
  global last_seen, last_beep
  now = time.time()
  new_event = False
  with lock:
    if now - last_seen > NEW_EVENT_GAP_SEC:
      new_event = True
      events.append(now)
      events[:] = prune(events, now)
      save_list(EVENTS_FILE, events)
    last_seen = now
    should_beep = now - last_beep >= BEEP_COOLDOWN_SEC
    if should_beep:
      last_beep = now
    was_running = timer.running
    timer.pause_for_phone(now)
    paused_now = was_running and not timer.running

  if new_event:
    logger.info(f"Cell phone detected! Total events stored: {len(events)}")
    ui.send_message("phone_event", message={"timestamp": now})
    send_stats()
  if paused_now:
    send_timer()
  if should_beep:
    play_sound(SOUND_PHONE)


detection_stream.on_detect(PHONE_LABEL, on_phone_detected)


# Forward every detected object to the dashboard so the live "phone in view" badge stays updated
def forward_detections(detections: dict):
  now = time.time()
  for label, hits in detections.items():
    for hit in hits:
      ui.send_message("detection", message={"content": label, "confidence": hit.get("confidence"), "timestamp": now})


detection_stream.on_detect_all(forward_detections)


# ---------- Main loop: advances the timer and drives the LED matrix ----------
last_matrix = None
last_matrix_push = 0.0
last_timer_push = 0.0


def loop():
  global last_matrix, last_matrix_push, last_timer_push
  now = time.time()
  with lock:
    changed = timer.tick(now)
    matrix = timer.matrix_state(now)
  # Send changes right away, and repeat every few seconds in case the sketch restarted
  if matrix != last_matrix or now - last_matrix_push >= 5.0:
    bridge_call("set_state", *matrix)
    last_matrix = matrix
    last_matrix_push = now
  if changed or now - last_timer_push >= 1.0:
    send_timer()
    last_timer_push = now
  time.sleep(0.2)


App.run(user_loop=loop)
