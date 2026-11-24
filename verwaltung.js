// Gemeinsame Hilfen für die Verwaltungs-Seiten (uebersicht.html, admin.html, qr.html).
// Das Kennwort bleibt nur in diesem Browser gespeichert und wird nur an den SlotWatch-Dienst geschickt.
window.SW = {
  // Betreiber aus der Adresse (?b=...). Leer = eigene Hallen.
  betreiber: (new URLSearchParams(location.search).get('b') || '').toLowerCase(),
  eingerichtet() { return !!window.SLOTWATCH_API; },
  anhang() { return this.betreiber ? '?b=' + encodeURIComponent(this.betreiber) : ''; },
  speicherName() { return 'sw_admin_key' + (this.betreiber ? '_' + this.betreiber : ''); },
  kennwort() { try { return localStorage.getItem(this.speicherName()) || ''; } catch (e) { return ''; } },
  merke(k) { try { localStorage.setItem(this.speicherName(), k); } catch (e) {} },
  vergiss() { try { localStorage.removeItem(this.speicherName()); } catch (e) {} },

  // Aufruf an den Dienst. Liefert { code, daten }; bei fehlender Verbindung { code: 0, daten: null }.
  async ruf(pfad, koerper) {
    const opt = { headers: { 'X-Admin-Key': this.kennwort() } };
    if (koerper !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(koerper); }
    try {
      const res = await fetch(window.SLOTWATCH_API + pfad + this.anhang(), opt);
      return { code: res.status, daten: await res.json() };
    } catch (e) {
      return { code: 0, daten: null };
    }
  },
  fehlerText(r) {
    if (r.code === 0) return 'Keine Verbindung zum Dienst. Bitte nochmal versuchen.';
    return (r.daten && r.daten.text) || 'Unbekannter Fehler.';
  },

  // Element bauen — Inhalte immer als reiner Text (die Daten stammen aus dem öffentlichen Meldeformular).
  el(tag, klasse, text) {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
  },

  // Datei im Browser zum Speichern anbieten.
  speichere(dateiname, inhalt, typ) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([inhalt], { type: typ }));
    a.download = dateiname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
};
