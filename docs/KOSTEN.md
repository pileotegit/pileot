# Kostenübersicht (Stand 2026-11-11)

Preise von den Anbieterseiten, abgerufen am 2026-11-11. USD-Beträge in EUR sind grob
geschätzt (1 USD ca. 0,92 EUR), Steuern nicht berücksichtigt.

| Dienst | Plan | Preis | Was V1 braucht | Quelle |
|---|---|---|---|---|
| n8n Cloud | Starter | 20 EUR/Monat bei jährlicher Zahlung, 2.500 Ausführungen | ca. 1.600 Ausführungen plus Formulareinträge | n8n.io/pricing |
| Supabase | Free | 0 USD, Projekte pausieren nach 1 Woche Inaktivität | Test | supabase.com/pricing |
| Supabase | Pro | ab 25 USD/Monat (inkl. 10 USD Compute) | Empfehlung für den Livebetrieb | supabase.com/pricing |
| Supabase | Custom Domain | 10 USD/Monat | **nicht nötig** (statische Seiten auf eigener Domain) | supabase.com/pricing |
| Resend | Free | 0 USD, 3.000 Mails/Monat, 100 pro Tag | reicht für eine Kosmetikerin (Tageslimit 20) | resend.com/pricing |
| Resend | Pro | 20 USD/Monat, 50.000 Mails | ab mehreren Studios oder > 100 Mails/Tag | resend.com/pricing |
| Statischer Host | vorhandene pileot.de-Hosting | Annahme: 0 EUR zusätzlich | 2 kleine Seiten | offen, siehe unten |

## Pilot mit einer Kosmetikerin

| Szenario | Monatlich |
|---|---|
| Minimal (n8n Starter, Supabase Free, Resend Free) | ca. 20 EUR |
| Empfohlen (n8n Starter, Supabase Pro, Resend Free) | ca. 43 EUR |

Bei 150 EUR Umsatz pro Monat bleiben in der empfohlenen Variante ca. 107 EUR Deckungsbeitrag vor
Arbeitszeit. Die Plattformkosten sind weitgehend fix: ein zweites Studio kostet bis zu den
Kontingentgrenzen (n8n 2.500 Ausführungen, Resend 100 Mails pro Tag) fast nichts zusätzlich.

## Hinweise

- Supabase Free pausiert Projekte nach einer Woche Inaktivität. Für ein zahlendes Kundenprojekt ist
  das ein unnötiges Ausfallrisiko, deshalb die Empfehlung Pro.
- Vercel Hobby ist laut Vercel nur für nicht-kommerzielle Nutzung gedacht. Für `link.pileot.de`
  daher den bestehenden Host von pileot.de, Vercel Pro oder einen Host mit erlaubter kommerzieller
  Nutzung im Gratisplan verwenden. Vor der Wahl die aktuellen Bedingungen prüfen.
- n8n: Preise bei monatlicher Zahlung zeigt die Seite nur über einen Umschalter, ohne Betrag im Text.

## Quellen

- https://n8n.io/pricing/
- https://supabase.com/pricing
- https://supabase.com/changelog/29633-xhtml-responses-are-only-allowed-with-a-custom-domain-enabled
- https://resend.com/pricing
- https://resend.com/docs/dashboard/emails/idempotency-keys
