# SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
#
# SPDX-License-Identifier: MPL-2.0
# Created by Julián Caro Linares for Arduino s.r.l using as a base the original example by Arduino "Video Object Detection"


# from arduino.app_utils import App
from arduino.app_utils import *
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.video_objectdetection import VideoObjectDetection
from datetime import datetime, UTC
import time

# Object Flags Variables
cell_phone = False

ui = WebUI()
detection_stream = VideoObjectDetection(confidence=0.5, debounce_sec=0.0)

ui.on_message("override_th", lambda sid, threshold: detection_stream.override_threshold(threshold))

# Register a callback for when all objects are detected
def send_detections_to_ui(detections: dict):
  global cell_phone
    
  for key, values in detections.items():
    for value in values:
      entry = {
        "content": key,
        "confidence": value.get("confidence"),
        "timestamp": datetime.now(UTC).isoformat()
      }
      if key == "cell phone":
          print("Cell phone detected!")
          time.sleep(0.2)
          cell_phone = True
          Bridge.call("set_cell_phone", cell_phone)
          cell_phone = False;

      ui.send_message("detection", message=entry)

detection_stream.on_detect_all(send_detections_to_ui)

App.run()
