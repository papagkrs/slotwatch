# SlotWatch – Plan und Stand

Stand: 25.11.2026. Diese Datei ist der eine Ort für „was ist fertig, was ist offen“.

## Was SlotWatch ist

Mitarbeiter scannen in der Halle einen QR-Code, melden in drei Schritten eine Störung (optional mit Foto),
der Techniker bekommt sie per Telegram mit den Knöpfen „Bin dran“ und „Erledigt“.
Die Seiten liegen auf GitHub Pages, das zentrale Gedächtnis ist ein Dienst bei Cloudflare (`worker/`, siehe `worker/README.md`).

## Offen – braucht eine Entscheidung oder Handlung des Inhabers

| Nr. | Was | Warum offen |
|---|---|---|
| A1 | Telegram-Schlüssel wechseln, alten Weg aus `index.html`/`erledigt.html` entfernen | Zurückgestellt (24.11.). Der alte Schlüssel steht öffentlich im Verlauf; wer ihn hat, schreibt am Dienst vorbei in den Chat. |
| A2 | Kennwort `ADMIN_KEY` bei Cloudflare als Geheimnis eintragen | Ohne Kennwort sind Übersicht, Standort-Verwaltung, Sicherung und Betreiber-Verwaltung gesperrt (Antwort 503). |
| C2 | Sicherung regelmäßig herunterladen | Es gibt nur den Knopf in der Übersicht. Eine automatische Sicherung außerhalb von Cloudflare ist nicht gebaut. |
| C3 | Aufbewahrungsfrist bestätigen | Voreinstellung: Namen und Freitext werden nach 12 Monaten entfernt (`AUFBEWAHRUNG_MONATE`). Welche Frist rechtlich passt, ist nicht geprüft. |
| C5 | Test auf mehreren echten Handys | Getestet sind ein echtes Handy und nachgestellte Handy-Ansichten. |
| B4 | Erinnerungszeiten bestätigen | Voreinstellung: 2 Std. (nicht spielbar) und 24 Std. (spielbar), je Störung eine Erinnerung. |
| D3 | Eigene Adresse, Nutzungsbedingungen, Datenschutzerklärung, Abrechnung | Nicht begonnen: braucht Kauf-, Rechts- und Zahlungsentscheidungen. |

## Erledigt

| Nr. | Was | Seit |
|---|---|---|
| – | Zweite Meldung hintereinander, Foto-Fehler sichtbar, doppeltes „Bin dran“ | 24.11. |
| – | Zentrales Gedächtnis bei Cloudflare, eindeutige Ticket-Nummern, Bremse, Übersicht | 24.11. |
| A3 | Testeinträge gelöscht | 25.11. |
| A4 | Stillgelegten Wächter entfernt | 25.11. |
| B1 | Standorte zentral, Verwaltung in `admin.html`, QR-Seite liest die zentrale Liste | 25.11. |
| B2 | Melder sieht den echten Stand auf der Erfolgsseite | 25.11. |
| B3 | Reaktions- und Reparaturdauer in der Übersicht | 25.11. |
| B4 | Erinnerung an offene Störungen | 25.11. |
| B5 | Alte Nur-dieses-Handy-Liste auf der Meldeseite ausgeblendet | 25.11. |
| B6 | Technikername bei „Bin dran“/„Erledigt“ | 25.11. |
| C1 | Tests laufen bei jeder Änderung automatisch (GitHub Actions) | 25.11. |
| C2 | Sicherung als Download (CSV/JSON) | 25.11. |
| C3 | Namen/Freitext werden nach Frist entfernt | 25.11. |
| C4 | Fotos werden vor dem Senden verkleinert | 25.11. |
| D1 | Marktrecherche: `docs/MARKTRECHERCHE_2026-11.md` | 25.11. |
| D2 | Weitere Betreiber technisch getrennt (eigener Chat, eigenes Kennwort, eigene Daten) | 25.11. |

## Bekannte Grenzen

- Unbekannte Standorte werden angenommen und nur markiert. Ablehnen wäre erst sicher, wenn die zentrale Liste geprüft vollständig ist.
- Ein weiterer Betreiber wird über die Schnittstelle angelegt (`worker/README.md`), eine Seite dafür gibt es nicht.
- Alle Betreiber nutzen denselben Telegram-Bot.
- Verkaufsoption: Laut Recherche ist die Zielgruppe klein und es gibt günstige Alternativen. Vor weiterer Entwicklung für den Verkauf: Gespräche mit anderen Betreibern.
