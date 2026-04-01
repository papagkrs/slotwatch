# 🔐 SlotWatch Backend Setup

Die Sicherheit wurde verbessert! Der Telegram-Token ist jetzt geschützt im Backend.

---

## 📋 Voraussetzungen

- **Node.js** installiert (Download: https://nodejs.org)
- **Telegram Bot Token** (von @BotFather)
- **Chat ID** (Deine Telegram User ID oder Gruppe)

---

## 🚀 Installation (3 Schritte)

### **Schritt 1: Dependencies installieren**
```bash
npm install
```

### **Schritt 2: .env Datei erstellen**

1. Kopiere `.env.example` → `.env`
2. Öffne `.env` und fülle aus:

```env
TELEGRAM_BOT_TOKEN=dein_bot_token_hier
TELEGRAM_CHAT_ID=deine_chat_id_hier
PORT=3000
```

### **Schritt 3: Server starten**

**Produktiv:**
```bash
npm start
```

**Entwicklung (auto-reload):**
```bash
npm run dev
```

Die App läuft dann auf: **http://localhost:3000**

---

## 🤖 Telegram Credentials beschaffen

### **1. Bot Token von @BotFather bekommen:**
1. Öffne Telegram und schreibe **@BotFather**
2. Sende `/newbot`
3. Folge den Anweisungen
4. Du bekommst einen Token wie: `123456789:ABCdefGHIjklmno`

### **2. Chat ID herausfinden:**

**Option A: Direct Chat (privat)**
1. Schreibe deinem Bot eine Nachricht
2. Öffne: `https://api.telegram.org/bot<DEIN_TOKEN>/getUpdates`
3. Suche nach `"chat"` → `"id": <DEINE_CHAT_ID>`

**Option B: Gruppe**
1. Füge Bot zur Gruppe hinzu
2. Schreibe eine Nachricht
3. Nutze die gleiche URL wie oben

---

## ✅ Testen

```bash
curl http://localhost:3000/api/health
```

Sollte zurückgeben:
```json
{"status":"ok","telegram":"connected"}
```

---

## 🔒 Sicherheit

✅ **Vorher (UNSICHER):**
- Token sichtbar im Code
- Jeder konnte Token sehen
- Code auf GitHub/öffentlich = Token gehackt

✅ **Nachher (SICHER):**
- Token in `.env` (nicht committet)
- `.env` in `.gitignore`
- Token nur auf Server vorhanden

---

## 📝 .gitignore

Stelle sicher, dass `.env` nicht committed wird:

```bash
# .gitignore
.env
node_modules/
```

---

## 🐛 Fehlersuche

| Problem | Lösung |
|---------|--------|
| `Cannot find module 'express'` | `npm install` ausführen |
| `TELEGRAM_BOT_TOKEN not set` | `.env` Datei prüfen |
| `Connection refused` | Port 3000 frei? `npm start` eingeben |
| `Telegram error: Unauthorized` | Token in `.env` überprüfen |

---

## 📞 Support

Fragen? Öffne einen Issue auf GitHub!
