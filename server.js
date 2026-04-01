import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Telegram credentials from .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Validation
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ FEHLER: Telegram-Anmeldedaten nicht gesetzt!');
  console.error('   Bitte .env Datei mit TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID erstellen');
  process.exit(1);
}

console.log('✅ Telegram-Anmeldedaten geladen');

// Upload photo to temporary storage
async function uploadPhoto(photoBase64) {
  try {
    if (!photoBase64) return null;

    const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const formData = new FormData();
    formData.append('file', buffer, { filename: 'photo.jpg' });

    const uploadRes = await fetch('https://0x0.st', {
      method: 'POST',
      body: formData,
    });

    const text = await uploadRes.text();
    const fotoUrl = text.trim();

    if (!fotoUrl.startsWith('http')) {
      console.error('Upload-Fehler:', fotoUrl);
      return null;
    }

    return fotoUrl;
  } catch (err) {
    console.error('Foto-Upload fehlgeschlagen:', err.message);
    return null;
  }
}

// Send to Telegram
async function sendToTelegram(message, fotoUrl) {
  try {
    const fullMessage = fotoUrl
      ? `${message}\n\n📷 Foto: ${fotoUrl}`
      : message;

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: fullMessage,
        parse_mode: 'HTML',
      }),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('Telegram-Fehler:', result.description);
      return { success: false, error: result.description };
    }

    console.log('✅ Nachricht versendet:', result.result.message_id);
    return { success: true, messageId: result.result.message_id };
  } catch (err) {
    console.error('Telegram-Fehler:', err.message);
    return { success: false, error: err.message };
  }
}

// API Endpoint: Submit ticket
app.post('/api/ticket', async (req, res) => {
  try {
    const { id, standort, fehlertyp, automat, melder, spielbar, beschreibung, now, severity, spielbarText, severityLabel, foto } = req.body;

    if (!standort || !fehlertyp || !melder || !automat) {
      return res.status(400).json({ success: false, error: 'Erforderliche Felder fehlen' });
    }

    // Upload photo if provided
    let fotoUrl = null;
    if (foto) {
      fotoUrl = await uploadPhoto(foto);
    }

    // Build message
    const msg = `🎰 <b>NEUE STÖRUNG #${id}</b>\n\n📍 <b>Standort:</b> ${standort}\n🔧 <b>Fehler:</b> ${fehlertyp}\n${automat ? '🎰 <b>Automat:</b> ' + automat + '\n' : ''}${melder ? '👤 <b>Gemeldet:</b> ' + melder + '\n' : ''}🕹️ <b>Spielbar:</b> ${spielbarText}\n${beschreibung ? '📝 ' + beschreibung + '\n' : ''}<b>${severityLabel}</b>\n🕐 <b>Uhrzeit:</b> ${now}`;

    // Send to Telegram
    const telegramResult = await sendToTelegram(msg, fotoUrl);

    if (telegramResult.success) {
      res.json({
        success: true,
        id,
        foto: fotoUrl,
        message: 'Ticket erfolgreich versendet',
      });
    } else {
      res.status(500).json({
        success: false,
        error: telegramResult.error,
      });
    }
  } catch (err) {
    console.error('Fehler beim Ticket-Submit:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', telegram: 'connected' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 SlotWatch Backend läuft auf http://localhost:${PORT}`);
  console.log(`📍 Frontend: http://localhost:${PORT}/index.html`);
  console.log(`\n💡 Tipp: Nutze 'npm run dev' für auto-reload während Entwicklung\n`);
});
