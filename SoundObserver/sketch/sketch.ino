// MCU side (STM32U585) of the Urban Acoustic Sensor app.
//
// The heavy lifting (log-mel + DS-CNN inference) runs on the Linux side of the
// UNO Q in Python. This sketch owns the deterministic, real-time part: the local
// signalling LED required by the architecture (docs/system-architecture-model.md
// section 3.1), the SSD1306 OLED that shows danger-event strings, and the
// informal `Monitor` log.
//
// Wiring: three active-high LEDs (or one RGB module) on the pins below, and a
// 128x64 SSD1306 OLED on the hardware I2C bus. The UNO Q's ARDUINO header
// exposes D2..D13/A0..A5; change the constants to match your board. If you prefer
// the onboard LED, set only LED_GREEN to LED_BUILTIN.

#include "Arduino_RouterBridge.h"
#include <U8g2lib.h>

#ifdef U8X8_HAVE_HW_SPI
#include <SPI.h>
#endif
#ifdef U8X8_HAVE_HW_I2C
#include <Wire.h>
#endif

constexpr int LED_GREEN = 2;
constexpr int LED_AMBER = 3;
constexpr int LED_RED   = 4;

constexpr int LED_OFF = 0;
constexpr int LED_GREEN_STATE = 1;
constexpr int LED_AMBER_STATE = 2;
constexpr int LED_RED_STATE = 3;

// 128x64 SSD1306 / SSD1308Z panel on hardware I2C (same wiring as before).
U8G2_SSD1306_128X64_ALT0_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);

// How long a danger-event string stays on screen before the rest line returns.
constexpr unsigned long OLED_HOLD_MS = 10000;
String g_oled_msg = "";
unsigned long g_oled_until = 0;

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

// Exposed to Python as Bridge.call("show_event", text): show a danger-event
// string on the OLED for OLED_HOLD_MS, then fall back to the rest line.
void show_event(String text) {
    g_oled_msg = text;
    g_oled_until = millis() + OLED_HOLD_MS;
    Monitor.println("OLED: " + text);
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

    u8g2.begin();

    Monitor.begin(115200);
    Monitor.println("urban-acoustic-sensor: MCU ready");

    Bridge.begin();
    Bridge.provide("set_led", set_led);
    Bridge.provide("show_event", show_event);
    Bridge.provide("log", log_message);
}

void loop() {
    const bool active = millis() < g_oled_until && g_oled_msg.length() > 0;

    u8g2.clearBuffer();
    if (active) {
        u8g2.setFont(u8g2_font_7x14_tr);
        u8g2.drawStr(6, 26, g_oled_msg.c_str());
        u8g2.setFont(u8g2_font_6x12_tr);
        u8g2.drawStr(6, 50, "ALLERTA SICUREZZA");
    } else {
        u8g2.setFont(u8g2_font_7x14_tr);
        u8g2.drawStr(6, 32, "MONITOR OK");
    }
    u8g2.sendBuffer();

    delay(200);
}
