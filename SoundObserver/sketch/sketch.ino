void setup() {
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
      digitalWrite(6,0);
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
