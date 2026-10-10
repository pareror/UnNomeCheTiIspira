# Report Finale: Dataset Urban Safety & Addestramento Modello TinyML

Report tecnico del modulo acustico di rilevamento pericoli urbani e classificazione sonora.

---

## 1. Composizione del Dataset (`urban_safety`)

Il dataset è stato generato combinando clip da **UrbanSound8K** (rumore urbano standard), **ESC-50** (voci ed eventi impulsivi) e il dataset aperto **Human Scream Detection** (urla reali femminili e maschili).

- **Frequenza di campionamento**: 16.000 Hz, mono.
- **Rappresentazione**: Log-mel spectrograms (40 mel × 49 frame per finestra da 1 secondo).
- **Clip audio totali**: **1.552 file**.
- **Finestre 1s estratte**: **5.811 campioni**.

### Distribuzione per Classe (Bilanciamento)

| ID | Classe | Tipologia | Clip | Finestre 1s | % Finestre | Note / Fonte |
|:--:|---|---|:---:|:---:|:---:|---|
| 0 | `scream` | **Pericolo (Safety)** | 72 | 698 | 12.0% | Freesound / GitHub (hop 0.5s) |
| 1 | `gunshot` | **Pericolo (Safety)** | 200 | 295 | 5.1% | UrbanSound8K |
| 2 | `siren` | Emergenza | 200 | 783 | 13.5% | UrbanSound8K |
| 3 | `traffic` | Urbano ordinario | 200 | 783 | 13.5% | UrbanSound8K (`engine_idling`) + ESC-50 |
| 4 | `speech` | Negativo vocale | 200 | 804 | 13.8% | ESC-50 (`laughing`, `crying`, `coughing`) + US8K |
| 5 | `car_horn` | Allerta stradale | 200 | 543 | 9.3% | UrbanSound8K + ESC-50 |
| 6 | `construction`| Inquinamento acustico | 200 | 694 | 11.9% | US8K (`drilling`, `jackhammer`) |
| 7 | `impact_crash`| Incidenti / rotture | 80 | 400 | 6.9% | ESC-50 (`glass_breaking`, `knock`) |
| 8 | `ambient_quiet`| Background | 200 | 811 | 14.0% | US8K (`air_conditioner`, `street_music`) + ESC-50 |
| **Tot** | **9 classi** | | **1.552** | **5.811** | **100%** | |

---

## 2. Risultati dell'Addestramento

Il classificatore impiega l'architettura **DS-CNN** (Depthwise-Separable CNN) TinyML progettata per microcontrollori ESP32-S3:
- **Parametri**: 13.802 parametri INT8/FP32.
- **Dimensione pesi**: 69 KB (ampiamente sotto la soglia di 100 KB di SRAM).
- **Testa Duale**:
  - `urban_head`: Softmax su 9 classi per classificazione urbana.
  - `safety_head`: Logit binario con funzione sigmoide per allarme prioritario (*urla/spari*).

### Metriche Ottenute

- **Epoche di convergenza**: 35 (best checkpoint all'epoca 31).
- **Validation Accuracy (9 classi)**: **79.69%**.
- **Safety Recall (urla e spari)**: **93.6%** (grazie al peso $\times 2.0$ della loss di sicurezza).
- **Validation Loss**: 0.7421.

---

## 3. Disgiunzione Rigorosa dei Set (Zero Data Leakage)

I file audio sono stati partizionati **a livello di file (`clip_id`)** su 10 fold:
- Nessun file audio è presente contemporaneamente in due partizioni.
- Tutte le finestre da 1s derivanti dallo stesso file sorgente rimangono nella stessa partizione.

### Verifica Empirica

```json
{
  "is_disjoint": true,
  "train_clips": 1277,
  "val_clips": 141,
  "test_clips": 134,
  "train_windows": 4790,
  "val_windows": 522,
  "test_windows": 499,
  "overlap_train_val": 0,
  "overlap_train_test": 0,
  "overlap_val_test": 0
}
```

---

## 4. Modelli e Artefatti Salvati

1. **Checkpoint PyTorch**:
   - Percorso: `models/artifacts/ds_cnn_urban_safety.pt` (69 KB)
   - Contenuto: dizionario con pesi, parametri di normalizzazione log-mel (`norm_mean: -2.1625`, `norm_std: 4.8041`), metriche ed etichette.
2. **Modello ONNX (Deploy MCU)**:
   - Percorso: `models/artifacts/ds_cnn_urban_safety.onnx` (43 KB)
   - Opsets: 18 (grafo statico batch=1, pronto per TFLite INT8 Micro).
3. **Tensori featurizzati**:
   - Percorso: `models/data/urban_safety_features.pt` (5.811 finestre da 1s).
4. **Metadati CSV**:
   - Percorso: `models/data/urban_safety/metadata.csv`.

---

## 5. Comandi di Testing e Verifica

Dalla cartella `models/`:

### A. Verificare che Train, Validation e Test siano disgiunti
```bash
python -m acoustic_models.urban_safety --verify-splits
```

### B. Eseguire la suite di test automatica (18 test)
```bash
python -m pytest tests
```

### C. Rieseguire l'addestramento e il salvataggio
```bash
python -m acoustic_models.train_classifier --dataset urban_safety --epochs 35 --out artifacts/ds_cnn_urban_safety.pt --export-onnx artifacts/ds_cnn_urban_safety.onnx
```

### D. Benchmark multi-fold ed anomaly scoring
```bash
python -m acoustic_models.experiments --dataset urban_safety --epochs 30
```
