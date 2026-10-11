#include <Arduino.h>
#include <U8g2lib.h>

#ifdef U8X8_HAVE_HW_SPI
#include <SPI.h>
#endif
#ifdef U8X8_HAVE_HW_I2C
#include <Wire.h>
#endif


U8G2_SSD1306_128X64_ALT0_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE); // SSD1306 and SSD1308Z are compatible

void setup() {
  u8g2.begin();
  pinMode(6,OUTPUT);
  pinMode(7,OUTPUT);
  pinMode(8,OUTPUT);
  //digitalWrite(7,1);
  Serial.begin(9600);

  Bridge.begin();
  Bridge.provide_safe("set_led_level",set_led_state_level);

}

void loop() {
    //Serial.write("Test to check the serial port\n");
  u8g2.clearBuffer();                   // clear the internal memory
  u8g2.setFont(u8g2_font_10x20_tr);   // choose a suitable font
  u8g2.drawStr(5,20,"Hello World!");    // write something to the internal memory
  u8g2.sendBuffer();                    // transfer internal memory to the display
  delay(1000);  
}

void set_led_state_level(int db) {
  Serial.print("Valore ricevuto da linux: ");
  Serial.println(db);

    if (db < 40) {
      digitalWrite(6,0);
      digitalWrite(7,0);
      digitalWrite(8,0);
          }
    else if (db < 60) {
      digitalWrite(6,0);
      digitalWrite(7,0);
      digitalWrite(8,0);
          }
    else if (db < 66) {
      digitalWrite(6,1);
      digitalWrite(7,0);
      digitalWrite(8,0);
    }
    else if (db < 81) {
      digitalWrite(6,1);
      digitalWrite(7,0);
      digitalWrite(8,0);
    }
    else if (db <= 90) {
      digitalWrite(6,1);
      digitalWrite(7,1);
      digitalWrite(8,0);
    } else {

      digitalWrite(6,1);
      digitalWrite(7,1);
      digitalWrite(8,1);
    }

}
