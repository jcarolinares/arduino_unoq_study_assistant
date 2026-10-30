// SPDX-FileCopyrightText: Copyright (C) 2026 jcarolinares
//
// SPDX-License-Identifier: GPL-3.0-or-later

#include <Arduino_RouterBridge.h>
#include <Arduino_Modulino.h>
#include <Arduino_LED_Matrix.h>

// ---------- LED matrix ----------
const uint8_t ROWS = 8;
const uint8_t COLS = 13;
const uint8_t PIXELS = ROWS * COLS;

// States sent by Python with set_state(state, progress)
enum State {
  STATE_IDLE = 0,     // No session running: blinking smiley
  STATE_FOCUS = 1,    // Focus session running: matrix fills up as time passes
  STATE_PAUSED = 2,   // Session paused: dim progress with blinking pause bars
  STATE_PHONE = 3,    // Phone in view: shaking phone with a blinking X
  STATE_BREAK = 4,    // Break running: steaming coffee cup
  STATE_DONE = 5,     // Focus session complete: celebration
  STATE_RESUMED = 6,  // Phone gone, session resumed: check mark
};

Arduino_LED_Matrix matrix;
uint8_t frame[PIXELS];

volatile int currentState = STATE_IDLE;
volatile int currentProgress = 0;  // Lit pixels (0-104) for the focus and paused progress
volatile unsigned long stateStart = 0;

// ---------- Modulino Buzzer ----------
ModulinoBuzzer buzzer;
bool buzzerReady = false;

struct Note {
  uint16_t freq;  // 0 = silence
  uint16_t ms;
};

const Note SOUND_PHONE[] = { { 2000, 150 }, { 0, 50 }, { 2600, 150 } };
const Note SOUND_DONE[] = { { 1047, 120 }, { 1319, 120 }, { 1568, 120 }, { 2093, 320 } };
const Note SOUND_BREAK_OVER[] = { { 1568, 150 }, { 0, 60 }, { 1568, 150 }, { 0, 60 }, { 2093, 300 } };
const Note SOUND_START[] = { { 1319, 100 }, { 1760, 160 } };

struct Sound {
  const Note *notes;
  uint8_t count;
};

const Sound SOUNDS[] = {
  { SOUND_PHONE, sizeof(SOUND_PHONE) / sizeof(Note) },
  { SOUND_DONE, sizeof(SOUND_DONE) / sizeof(Note) },
  { SOUND_BREAK_OVER, sizeof(SOUND_BREAK_OVER) / sizeof(Note) },
  { SOUND_START, sizeof(SOUND_START) / sizeof(Note) },
};
const int SOUND_COUNT = sizeof(SOUNDS) / sizeof(Sound);

volatile int pendingSound = -1;  // Set by Python, played from loop() so the Bridge never blocks
const Sound *playing = nullptr;
uint8_t noteIndex = 0;
unsigned long noteEnd = 0;

// ---------- Functions exposed to Python ----------
void set_state(int state, int progress) {
  if (state != currentState) {
    stateStart = millis();
  }
  currentState = state;
  currentProgress = constrain(progress, 0, (int)PIXELS);
}

void play_sound(int id) {
  if (id >= 0 && id < SOUND_COUNT) {
    pendingSound = id;
  }
}

// Kept for compatibility: same as play_sound(0)
void beep() {
  play_sound(0);
}

// ---------- Drawing helpers ----------
void clearFrame() {
  memset(frame, 0, PIXELS);
}

void setPixel(int x, int y, uint8_t v) {
  if (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
    frame[y * COLS + x] = v;
  }
}

// Draws a bitmap given as strings: '#' = full brightness, '+' = dim, anything else = off
void drawBitmap(const char *const rows[], int h, int ox, int oy, uint8_t bright) {
  for (int y = 0; y < h; y++) {
    for (int x = 0; rows[y][x]; x++) {
      char c = rows[y][x];
      if (c == '#') setPixel(ox + x, oy + y, bright);
      else if (c == '+') setPixel(ox + x, oy + y, bright > 4 ? 2 : 1);
    }
  }
}

// Fills the matrix column by column, from the bottom-left corner
void drawProgress(int lit, uint8_t bright) {
  for (int i = 0; i < lit && i < PIXELS; i++) {
    setPixel(i / ROWS, ROWS - 1 - (i % ROWS), bright);
  }
}

// ---------- Animations ----------
const char *const SMILE[] = {
  "...........",
  "...##...##..",
  "...##...##..",
  "............",
  "..#.......#.",
  "...#.....#..",
  "....#####...",
  "............",
};
const char *const SMILE_BLINK[] = {
  "............",
  "............",
  "...##...##..",
  "............",
  "..#.......#.",
  "...#.....#..",
  "....#####...",
  "............",
};

void animIdle(unsigned long t) {
  // Gentle breathing brightness with a blink every 4 seconds
  int phase = (t / 120) % 16;
  uint8_t bright = 3 + (phase < 8 ? phase : 15 - phase) / 2;
  bool blink = (t % 4000) < 160;
  drawBitmap(blink ? SMILE_BLINK : SMILE, 8, 1, 0, bright);
}

void animFocus(unsigned long t, int lit) {
  drawProgress(lit, 2);
  // The next pixel to fill pulses so you can see the timer is running
  if (lit < PIXELS) {
    int phase = (t / 90) % 14;
    uint8_t v = phase < 7 ? phase + 1 : 14 - phase;
    setPixel(lit / ROWS, ROWS - 1 - (lit % ROWS), v);
  }
  // A light sweeps across the filled part every 3 seconds
  int sweep = (t % 3000) / 120;
  if (sweep < COLS) {
    for (int y = 0; y < ROWS; y++) {
      int i = sweep * ROWS + (ROWS - 1 - y);
      if (i < lit) setPixel(sweep, y, 5);
    }
  }
}

void animPaused(unsigned long t, int lit) {
  drawProgress(lit, 1);
  if ((t / 600) % 2 == 0) {
    for (int y = 1; y <= 6; y++) {
      setPixel(4, y, 7);
      setPixel(5, y, 7);
      setPixel(7, y, 7);
      setPixel(8, y, 7);
    }
  }
}

const char *const PHONE[] = {
  "#####",
  "#...#",
  "#...#",
  "#...#",
  "#...#",
  "#...#",
  "#.#.#",
  "#####",
};
const char *const CROSS[] = {
  "#...#",
  ".#.#.",
  "..#..",
  ".#.#.",
  "#...#",
};

void animPhone(unsigned long t) {
  // The phone shakes like it is vibrating and the X blinks
  int shake = ((t / 70) % 2) ? 1 : 0;
  drawBitmap(PHONE, 8, 1 + shake, 0, 7);
  if ((t / 250) % 2 == 0) {
    drawBitmap(CROSS, 5, 8, 1, 7);
  }
}

const char *const CUP[] = {
  "#######..",
  "#######.#",
  "#######.#",
  ".#####.#.",
};

void animBreak(unsigned long t) {
  drawBitmap(CUP, 4, 2, 4, 6);
  // Three wisps of steam rise from the cup and wiggle left and right
  for (int s = 0; s < 3; s++) {
    int baseX = 3 + s * 2;
    int offset = (t / 220 + s * 2) % 4;
    for (int y = 0; y < 4; y++) {
      int age = (y + offset) % 4;
      int wiggle = ((y + t / 400 + s) % 2) ? 1 : 0;
      setPixel(baseX + wiggle, y, age == 0 ? 0 : 1 + age);
    }
  }
}

void animDone(unsigned long t) {
  // Rings expand from the center, with random sparkles around them
  float cx = 6.0, cy = 3.5;
  float r = (t % 700) / 700.0 * 8.0;
  for (int y = 0; y < ROWS; y++) {
    for (int x = 0; x < COLS; x++) {
      float d = sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      float diff = fabs(d - r);
      if (diff < 0.7) setPixel(x, y, 7);
      else if (diff < 1.4) setPixel(x, y, 3);
    }
  }
  randomSeed(t / 80);
  for (int i = 0; i < 6; i++) {
    setPixel(random(COLS), random(ROWS), random(4, 8));
  }
}

const int8_t CHECK[][2] = {
  { 2, 4 }, { 3, 5 }, { 4, 6 }, { 5, 5 }, { 6, 4 }, { 7, 3 }, { 8, 2 }, { 9, 1 }, { 10, 0 },
};

void animResumed(unsigned long t) {
  // The check mark is drawn stroke by stroke, then stays on
  int n = min((int)(t / 60) + 1, (int)(sizeof(CHECK) / sizeof(CHECK[0])));
  for (int i = 0; i < n; i++) {
    setPixel(CHECK[i][0], CHECK[i][1], 7);
    setPixel(CHECK[i][0], CHECK[i][1] + 1, 4);
  }
}

// ---------- Sound player ----------
void updateSound() {
  unsigned long now = millis();
  if (pendingSound >= 0) {
    playing = &SOUNDS[pendingSound];
    pendingSound = -1;
    noteIndex = 0;
    noteEnd = 0;
  }
  if (!playing || now < noteEnd) return;
  if (!buzzerReady) {
    playing = nullptr;
    return;
  }
  if (noteIndex >= playing->count) {
    playing = nullptr;
    return;
  }
  const Note &n = playing->notes[noteIndex++];
  if (n.freq > 0) buzzer.tone(n.freq, n.ms);
  noteEnd = now + n.ms;
}

void setup() {
  matrix.begin();
  matrix.setGrayscaleBits(3);  // Brightness levels 0-7
  matrix.clear();

  Bridge.begin();

  // Initialize Modulino I2C communication. The matrix keeps working even without a buzzer.
  Modulino.begin(Wire1);
  for (int i = 0; i < 5 && !buzzerReady; i++) {
    buzzerReady = buzzer.begin();
    if (!buzzerReady) delay(500);
  }

  Bridge.provide("set_state", set_state);
  Bridge.provide("play_sound", play_sound);
  Bridge.provide("beep", beep);
  stateStart = millis();
}

void loop() {
  unsigned long t = millis() - stateStart;
  int lit = currentProgress;

  clearFrame();
  switch (currentState) {
    case STATE_FOCUS: animFocus(t, lit); break;
    case STATE_PAUSED: animPaused(t, lit); break;
    case STATE_PHONE: animPhone(t); break;
    case STATE_BREAK: animBreak(t); break;
    case STATE_DONE: animDone(t); break;
    case STATE_RESUMED: animResumed(t); break;
    default: animIdle(t); break;
  }
  matrix.draw(frame);

  updateSound();
  delay(30);
}
