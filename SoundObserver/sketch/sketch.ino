// MCU side (STM32U585) of the Urban Acoustic Sensor app.
//
// The heavy lifting (log-mel + DS-CNN inference) runs on the Linux side of the
// UNO Q in Python. This sketch owns the deterministic, real-time part: the
// local signalling LED required by the architecture (docs/system-architecture-
// model.md section 3.1) and, optionally, the informal `Monitor` log.
//
// Wiring: three active-high LEDs (or one RGB module) on the pins below. The
// UNO Q's ARDUINO header exposes D2..D13/A0..A5; change the constants to match
// your board. If you prefer the onboard LED, set only LED_GREEN to LED_BUILTIN.

#include "Arduino_RouterBridge.h"

constexpr int LED_GREEN = 2;
constexpr int LED_AMBER = 3;
constexpr int LED_RED   = 4;

constexpr int LED_OFF = 0;
constexpr int LED_GREEN_STATE = 1;
constexpr int LED_AMBER_STATE = 2;
constexpr int LED_RED_STATE = 3;

void write_leds(int green, int amber, int red) {
    digitalWrite(LED_GREEN, green ? HIGH : LOW);
    digitalWrite(LED_AMBER, amber ? HIGH : LOW);
    digitalWrite(LED_RED, red ? HIGH : LOW);
}

// Exposed to Python as Bridge.call("set_led", state).
// state: 0=off, 1=green (nominal), 2=amber (anomaly), 3=red (safety event).
void set_led(int state) {
    switch (state) {
        case LED_RED_STATE:   write_leds(0, 0, 1); break;
        case LED_AMBER_STATE: write_leds(0, 1, 0); break;
        case LED_GREEN_STATE: write_leds(1, 0, 0); break;
        default:              write_leds(0, 0, 0); break;
    }
}

// Exposed to Python as Bridge.call("log", message); mirrors a status line to
// the Monitor (Serial) of the MCU, useful when debugging without the Linux log.
void log_message(String message) {
    Monitor.println(message);
}

void setup() {
    pinMode(LED_GREEN, OUTPUT);
    pinMode(LED_AMBER, OUTPUT);
    pinMode(LED_RED, OUTPUT);
    write_leds(0, 0, 0);

    Monitor.begin(115200);
    Monitor.println("urban-acoustic-sensor: MCU ready");

    Bridge.begin();
    Bridge.provide("set_led", set_led);
    Bridge.provide("log", log_message);
}

void loop() {
    // The Python side drives everything through the Bridge callbacks above.
}
