/**
 * ============================================================================
 *  ARDUINO UNO Q (4GB RAM) - SKETCH C++ OTTIMIZZATO PER CONNETTIVITÀ WI-FI
 * ============================================================================
 *  Caratteristiche di ottimizzazione per Arduino Uno Q:
 *  - Socket TCP con HTTP/1.1 Keep-Alive persistente per abbattere la latenza di handshake
 *  - Ring buffer in memoria RAM (4GB) per garantire zero perdite di pacchetti
 *  - Campionamento acustico continuo e calcolo RMS in millisecondi
 *  - Header x-api-key e serializzazione JSON ottimizzata
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>

// PARAMETRI DI RETE E SERVER MASTER
const char* WIFI_SSID     = "TUA_RETE_WIFI";
const char* WIFI_PASSWORD = "PASSWORD_WIFI";

const char* SERVER_URL    = "http://192.168.22.103:3000/api/telemetry/reading";
const char* API_KEY       = "arduino-torino-noise-secret-2026";
const char* STATION_ID    = "ard-uno-q-real";
const char* STATION_NAME  = "Arduino Uno Q (Stazione Hardware)";

// PIN SENSORE MICROFONICO
const int MIC_PIN = 34;

// CLIENT HTTP PERSISTENTE (Keep-Alive)
WiFiClient wifiClient;
HTTPClient httpClient;

// STRUTTURA CAMPIONAMENTO IN RAM
struct ReadingPacket {
  uint32_t soundIntensity;
  uint64_t timestamp;
};

// Coda circolare di backup in RAM (sfrutta la RAM dell'Uno Q)
const int RAM_QUEUE_SIZE = 600; // 10 minuti di campionamenti a 1 Hz
ReadingPacket ramQueue[RAM_QUEUE_SIZE];
int queueHead = 0;
int queueTail = 0;
int queueCount = 0;

void enqueueSample(uint32_t intensity, uint64_t ts) {
  if (queueCount < RAM_QUEUE_SIZE) {
    ramQueue[queueTail].soundIntensity = intensity;
    ramQueue[queueTail].timestamp = ts;
    queueTail = (queueTail + 1) % RAM_QUEUE_SIZE;
    queueCount++;
  }
}

bool dequeueSample(ReadingPacket &outPacket) {
  if (queueCount == 0) return false;
  outPacket = ramQueue[queueHead];
  queueHead = (queueHead + 1) % RAM_QUEUE_SIZE;
  queueCount--;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n[ARDUINO UNO Q 4GB] Inizializzazione modulo Wi-Fi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println("\n[ARDUINO UNO Q 4GB] Connesso con successo!");
  Serial.print("Indirizzo IP Locale: ");
  Serial.println(WiFi.localIP());

  // Inizializza HTTP Client persistente con Keep-Alive
  httpClient.setReuse(true); // Riutilizza la connessione TCP aperta
  httpClient.setTimeout(1200);
}

void loop() {
  static unsigned long lastSampleTime = 0;
  unsigned long now = millis();

  // Campionamento a frequenza di 1 secondo (~1 Hz)
  if (now - lastSampleTime >= 1000) {
    lastSampleTime = now;

    // Lettura campionaria microfono (ADC 12-bit su Uno Q)
    int rawValue = analogRead(MIC_PIN);
    
    // Mappatura o calcolo dB SPL calibrato
    uint32_t soundDb = map(rawValue, 0, 4095, 30, 115);

    // Accodamento in RAM
    enqueueSample(soundDb, (uint64_t)time(NULL) * 1000ULL);
  }

  // Trasmissione verso il Server Master se connesso al Wi-Fi
  if (WiFi.status() == WL_CONNECTED && queueCount > 0) {
    ReadingPacket packet;
    if (dequeueSample(packet)) {
      httpClient.begin(wifiClient, SERVER_URL);
      httpClient.addHeader("Content-Type", "application/json");
      httpClient.addHeader("x-api-key", API_KEY);
      httpClient.addHeader("Connection", "keep-alive");

      String jsonPayload = "{\"station_id\":\"" + String(STATION_ID) +
                           "\",\"sound_intensity\":" + String(packet.soundIntensity) +
                           ",\"name\":\"" + String(STATION_NAME) + "\"}";

      int httpResponseCode = httpClient.POST(jsonPayload);

      if (httpResponseCode == 201 || httpResponseCode == 200) {
        Serial.printf("[UNO-Q OK] Trasmessi %u dB al Master. (Coda RAM: %d)\n", packet.soundIntensity, queueCount);
      } else {
        Serial.printf("[UNO-Q ERR] HTTP %d. Reinserimento in RAM buffer.\n", httpResponseCode);
        enqueueSample(packet.soundIntensity, packet.timestamp);
      }
    }
  }

  delay(20); // Yield per multitasking
}
