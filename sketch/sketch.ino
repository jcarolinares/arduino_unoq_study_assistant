// SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
//
// SPDX-License-Identifier: MPL-2.0

#include <Arduino_RouterBridge.h>
#include <Arduino_Modulino.h>

ModulinoBuzzer buzzer;

// Function exposed to Python: plays a short double beep on the Modulino Buzzer
void beep() {
  buzzer.tone(2000, 150);
  delay(200);
  buzzer.tone(2600, 150);
}

void setup() {
  Bridge.begin();

  // Initialize Modulino I2C communication
  Modulino.begin(Wire1);

  // Detect and connect to the buzzer module
  while (!buzzer.begin()) {
    delay(1000);
  }

  Bridge.provide("beep", beep); // Expose the function to Python
}

void loop() {
  // Nothing to do: the buzzer sounds whenever Python calls "beep"
}
