# SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
#
# SPDX-License-Identifier: MPL-2.0

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.video_objectdetection import VideoObjectDetection
import json
import os
import threading
import time

logger = Logger("StudyAssistant")

PHONE_LABEL = "cell phone"
NEW_EVENT_GAP_SEC = 3.0   # A phone seen after this many seconds without one counts as a new detection
BEEP_COOLDOWN_SEC = 2.0   # While a phone stays in view, beep at most this often
HISTORY_DAYS = 8          # Keep detection events for the weekly chart
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "phone_events.json")

ui = WebUI()
detection_stream = VideoObjectDetection(confidence=0.5, debounce_sec=0.0)

ui.on_message("override_th", lambda sid, threshold: detection_stream.override_threshold(threshold))

lock = threading.Lock()
last_seen = 0.0
last_beep = 0.0


def load_events() -> list:
  try:
    with open(DATA_FILE) as f:
      return [float(t) for t in json.load(f)]
  except Exception:
    return []


def save_events():
  try:
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w") as f:
      json.dump(events, f)
    os.replace(tmp, DATA_FILE)
  except Exception as e:
    logger.warning(f"Could not save detection history: {e}")


events = load_events()  # Epoch timestamps (seconds) of each phone detection event


def send_stats():
  # The browser turns the timestamps into "today", hourly and weekly stats using its local time zone
  ui.send_message("stats", message={"events": events, "server_time": time.time()})


def on_get_stats(sid, _data=None):
  send_stats()


ui.on_message("get_stats", on_get_stats)


def beep():
  try:
    Bridge.call("beep")
  except Exception as e:
    logger.warning(f"Could not call beep on the sketch: {e}")


# Called on every frame where a cell phone is detected
def on_phone_detected():
  global last_seen, last_beep
  now = time.time()
  new_event = False
  with lock:
    if now - last_seen > NEW_EVENT_GAP_SEC:
      new_event = True
      events.append(now)
      cutoff = now - HISTORY_DAYS * 86400
      events[:] = [t for t in events if t >= cutoff]
      save_events()
    last_seen = now
    should_beep = now - last_beep >= BEEP_COOLDOWN_SEC
    if should_beep:
      last_beep = now

  if new_event:
    logger.info(f"Cell phone detected! Total events stored: {len(events)}")
    ui.send_message("phone_event", message={"timestamp": now})
    send_stats()
  if should_beep:
    beep()


detection_stream.on_detect(PHONE_LABEL, on_phone_detected)


# Forward every detection to the UI so the live "phone in view" badge stays updated
def send_detections_to_ui(detections: dict):
  for key, values in detections.items():
    for value in values:
      ui.send_message("detection", message={
        "content": key,
        "confidence": value.get("confidence"),
        "timestamp": time.time(),
      })


detection_stream.on_detect_all(send_detections_to_ui)

App.run()
