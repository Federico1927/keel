# Onboarding di un negozio (runbook)

Da "il contratto è firmato" a "i numeri del negozio tornano con Shopify". La prima volta leggilo dall'inizio alla fine; dopo usalo come checklist. Ogni passo finisce con **Verifica**: cosa guardare, e dove, prima di andare avanti. Versione inglese: [ONBOARDING.md](ONBOARDING.md) (fa fede in caso di differenze).

Percorsi: `/admin/…` è la console super-admin (anche `https://admin.<dominio>/…` quando `ADMIN_URL` è impostato); `/t/<negozio>/…` è l'app del tenant, dove `<negozio>` è lo slug del tenant. La pagina del tenant in console collega questo runbook sotto la checklist di setup.

Prima del primo negozio la piattaforma deve essere pronta: il tuo account owner (`HULLWISE_OWNER_EMAIL`), `HULLWISE_INTEGRATION_MODE=live` con il worker, i prerequisiti dei fornitori, i backup giornalieri. Vedi `docs/DEPLOY.md`, sezione **Production**.

## 0. Cosa chiedere al cliente prima di iniziare

- Dati aziendali: ragione sociale, paese, valuta, fuso orario (quello impostato in Shopify: admin Shopify → Impostazioni → Generali), lingua del team, aliquota IVA del paese, prefisso dei numeri d'ordine (come in Shopify, es. `#NW`).
- Nome ed email dell'owner, e le persone che useranno l'app con il loro ruolo (owner, admin, operations, customer care, marketing, viewer).
- Accessi: un account staff sul negozio Shopify con il permesso di creare app (oppure il titolare del negozio in call), accesso admin al Business Manager di Meta, a Google Ads e a TikTok Ads.
- Quanto storico ordini importare (predefinito: 24 mesi).
- Un costo per prodotto ("Costo per articolo" di Shopify o un foglio di calcolo), le commissioni dei loro sistemi di pagamento, e quanto costa in media una spedizione.

## 1. Crea il tenant

**Fai.** `/admin/tenants/new`: nome, slug (l'indirizzo, minuscolo, da non cambiare più), paese, valuta, fuso orario, lingua predefinita, prefisso numeri d'ordine, piano, aliquota (in punti base: 2200 = 22%), nome ed email dell'owner. **Crea tenant** prepara lo spazio di lavoro, le regole di stato predefinite, gli slot delle integrazioni del piano, un abbonamento in prova con la fattura della fee di setup, e un invito per l'owner.

**Verifica.** **Apri la checklist di setup** (`/admin/tenants/<id>`): "Dati azienda" spuntato con paese · valuta · fuso; "Account owner" indica *invito in attesa*. La scheda **Abbonamento e fatture** mostra la prova e la fattura di setup.

## 2. L'accesso dell'owner (e il tuo finché l'email è spenta)

L'owner entra accettando l'email di invito. Le email partono solo con `RESEND_API_KEY` impostata (altrimenti la pagina **Email** della console dice "Email non configurata" e l'invito resta nel registro come catturato dal mock).

- **Email attiva:** l'owner apre il link (valido 7 giorni, monouso), sceglie la password ed entra nel negozio. Per reinviare l'invito: `/t/<negozio>/users` → **Inviti**.
- **Email spenta:** fai tu il setup con **Apri come supporto** (`/admin/tenants/<id>`, in alto a destra): agisci come owner, un banner lo segnala, e ogni azione finisce nell'audit come super-admin. Invita il team del cliente solo quando l'email funziona (passo 7).

**Verifica.** Come supporto, `/t/<negozio>` si apre con il banner di supporto. Con l'email attiva: la checklist in console spunta "Account owner" quando l'owner accetta; `/t/<negozio>/users` lo elenca come Attivo.

## 3. Collega Shopify e importa lo storico

**Fai.** Prima scegli quanti mesi di ordini importare: `/t/<negozio>/settings` → **Soglie e commissioni** → "Storico ordini letto al collegamento di Shopify (mesi, 0 = tutti)". Poi `/t/<negozio>/integrations` → scheda **Shopify** → segui la sua checklist con il cliente (app propria nella Shopify Dev Dashboard, versione con gli scope richiesti, release e installazione sul negozio, copia di Client ID e Client secret) e incolla dominio del negozio (`nome.myshopify.com`), Client ID e Client secret → **Collega**. La scheda spiega ogni errore possibile (secret sbagliato, negozio fuori dall'organizzazione dell'app → "Installa sul tuo negozio", versione non rilasciata, scope mancanti). La guida completa con gli scope per modulo è in `/t/<negozio>/integrations/guide/shopify`.

Il collegamento verifica credenziali e scope, registra i webhook e avvia in background l'importazione dello storico (prodotti, clienti, ordini; riprendibile).

**Verifica.**
- La scheda Shopify dice **Collegata**, modalità *live*, con il nome del negozio; se manca qualcosa, "permessi facoltativi non ancora concessi" lo elenca.
- Riquadro **Importazione dello storico ordini** sulla scheda: *In corso* poi *Completata*, con il numero di ordini e la data del più vecchio. Se si ferma (*Non riuscita*), **Risincronizza** riprende da dove si era fermata.
- **Esecuzioni recenti** (stessa pagina, sotto le schede): righe `shopify/orders · storico` (e prodotti, clienti) con stato *Riuscita*, righe lette e modificate.
- **Registro webhook** (stessa pagina): pochi minuti dopo il primo ordine nuovo o la prima modifica di un prodotto sul negozio compaiono righe come `orders/create`, `orders/updated`, `products/update` con stato *Elaborato*. Una riga *Fallito* ha il pulsante per riprovare e il suo errore.
- `/t/<negozio>/orders`: ci sono gli ultimi ordini, con gli stessi numeri dell'admin Shopify.
- Checklist in console: "Shopify collegato" e "Storico ordini importato" spuntati.

## 4. Stati degli ordini: regole e anteprima

Hullwise ha stati d'ordine propri (nuovo, da verificare, confermato, in evasione, spedito, consegnato, in attesa, annullato, reso…), calcolati da quello che dice Shopify tramite regole che il negozio controlla; niente viene dedotto da tag fissi nel codice.

**Fai.** `/t/<negozio>/settings/order-states`: rileggi con il cliente le regole predefinite e adattale al suo modo di lavorare (es. ordini con tag `hold` → in attesa, un metodo di pagamento da controllare a mano → da verificare). Ogni regola: condizioni (tag, metodo di pagamento, stato finanziario, stato di evasione), stato risultante, priorità (vince la più bassa; annullamenti, rimborsi, resi e consegne prevalgono sempre).

**Verifica.** La tabella **Anteprima sugli ordini recenti** nella stessa pagina applica le regole attuali agli **ultimi 50 ordini** del negozio: "Sugli ultimi 50 ordini le regole attuali ne cambierebbero N"; le righe cambiate sono evidenziate con *Attuale* e *Diventerebbe*. Scorri le righe evidenziate con il cliente finché ogni *Diventerebbe* è quello che si aspetta. Checklist in console: "Regole di stato" spuntato (almeno una regola attiva).

## 5. Costi (senza, i margini sembrano migliori di quanto sono)

**Fai.**
1. **Costi prodotto.** Se il cliente compila il "Costo per articolo" di Shopify, l'importazione l'ha già portato (fonte *platform*). Altrimenti, o per correggerlo: `/t/<negozio>/products/import-costs` → carica un CSV con `sku,cost` (l'esportazione dei costi di Shopify va bene così com'è; c'è un modello da scaricare) → **Anteprima** (niente è ancora scritto, gli SKU non trovati sono elencati) → scegli "Completa solo gli ordini senza costo" o "Ricalcola tutti gli ordini passati" → importa. Un prodotto solo: la sua pagina → **Costo prodotto**. In seguito anche il ricevimento di un ordine d'acquisto aggiorna il costo.
2. **Commissioni di pagamento.** `/t/<negozio>/settings` → **Soglie e commissioni** → **Commissioni di pagamento**: percentuale (punti base, 180 = 1,80%) e commissione fissa per ordine per ogni metodo (carta, wallet, bonifico, BNPL, contrassegno, altro).
3. **Spedizioni.** Stessa scheda: "Costo spedizione predefinito" per ordine; poi `/t/<negozio>/analytics/costs` per la fattura mensile del corriere (stima prima, effettivo quando arriva) e i costi fissi (affitto, personale, strumenti).
4. **Aliquote.** `/t/<negozio>/settings` → **Aliquote**: un'aliquota per ogni paese di spedizione in cui vende, e se i prezzi includono le tasse.

**Verifica.**
- Report dei costi mancanti: `/t/<negozio>/products/quality?issue=missing_cost` elenca le varianti attive senza costo; l'obiettivo è nessuna, o solo varianti trascurabili.
- `/t/<negozio>/analytics?tab=pnl` sul mese scorso: nessun avviso "N ordini contengono prodotti senza costo" (o una quota che il cliente accetta); il link dell'avviso apre quegli ordini.
- Checklist in console: "Costi configurati" spuntato.

## 6. Pubblicità: Meta, Google, TikTok (e GA4)

**Fai.** `/t/<negozio>/integrations`, una scheda per piattaforma, ciascuna con la sua checklist e il cliente alla tastiera:
- **Meta Ads**: utente di sistema nel suo Business Manager, token senza scadenza con `ads_read`, `ads_management`, `business_management`, id dell'account pubblicitario; altri account si aggiungono dalla scheda. L'id del pixel per la Conversions API è facoltativo.
- **Google Ads**: **Accedi con Google** e scegli l'account (serve l'app Google della piattaforma, vedi DEPLOY); altrimenti il percorso avanzato con le sue credenziali.
- **TikTok Ads** (dal piano Growth): **Collega TikTok** e scegli gli account inserzionista.
- **Google Analytics 4** (facoltativo): aggiungere la nostra email di lettura come Visualizzatore sulla proprietà e incollare l'ID della proprietà.

**Verifica.**
- Ogni scheda **Collegata**, *live*, con il nome dell'account; **Testa connessione** risponde OK.
- **Esecuzioni recenti**: righe `meta/…`, `google/…`, `tiktok/…` con stato *Riuscita*; la spesa compare giorno per giorno in `/t/<negozio>/campaigns`, e il **Registro giornaliero ads** (`/t/<negozio>/campaigns/ledger`) torna con la spesa di ieri nel gestore inserzioni della piattaforma (piccole differenze su oggi sono normali: le piattaforme ricalcolano i giorni recenti).
- Checklist in console: una spunta per ogni piattaforma pubblicitaria del piano.

## 7. Utenti e ruoli

**Fai.** `/t/<negozio>/users` → **Invita un membro**: email, ruolo, nome facoltativo. Ruoli: owner (tutto, billing, esportazione dati), admin, operations, customer care, marketing, viewer; la matrice di cosa vede ogni ruolo è nell'app. Serve l'email (passo 2).

**Verifica.** Ogni persona risulta *Attiva* dopo aver accettato; "Inviti" mostra quelli in sospeso con la scadenza. Checklist in console: "Almeno due utenti" spuntato. Chiedi a un utente non owner di entrare e confermare che vede ciò che gli serve e niente di più.

## 8. Add-on su richiesta

Gli add-on (contrassegno, campagne clienti, WhatsApp, abbonamenti, invio alla contabilità, …) li attiva per tenant il titolare della piattaforma, quando sono venduti.

**Fai.** `/admin/tenants/<id>` → **Piano e add-on** → attiva l'add-on (si possono attivare solo versioni rilasciate), con una nota. Poi configuralo nel negozio: es. contrassegno in `/t/<negozio>/cod/settings`, WhatsApp in `/t/<negozio>/whatsapp/settings` (incollare il nostro URL webhook in Spoki), abbonamenti dalla scheda **App di abbonamenti** in Integrazioni. I connettori "Disponibile su richiesta" (3PL, provider di messaggistica locali) sono lavoro su misura, non un interruttore.

**Verifica.** Le pagine dell'add-on compaiono nel menu del negozio; la pagina del tenant in console lo mostra attivo con la data; la prossima fattura lo include.

## 9. Revisione finale con il cliente

**Fai.** Prendi l'ultimo mese chiuso e percorrilo insieme:
- `/t/<negozio>` (dashboard) e `/t/<negozio>/analytics` (**Panoramica**): ricavi, ordini, scontrino medio, tassi di annullamento e reso, clienti nuovi e ricorrenti, con il confronto sul periodo precedente.
- `/t/<negozio>/analytics?tab=pnl`: ricavo netto, costo del venduto, margine lordo, spedizioni, commissioni di pagamento, margine di contribuzione, pubblicità, costi fissi, utile operativo. Ogni numero apre gli ordini che lo compongono.
- `/t/<negozio>/campaigns`: spesa, ordini attribuiti, profitto e ROAS per campagna; i consigli tengono conto dello stock.

**Verifica.** Il cliente riconosce i numeri (nessun ordine mancante, nessun margine assurdo). Le stranezze vengono quasi sempre da un costo mancante (passo 5), da una regola di stato (passo 4) o da un'aliquota (passo 5.4).

## 10. Riconciliazione con l'admin Shopify (±0,5%)

**Fai.** Sullo stesso mese chiuso:
- Hullwise: `/t/<negozio>/analytics/daily-sales?from=<AAAA-MM-01>&to=<AAAA-MM-ultimo>` → riga **Totale**: vendite lorde, sconti, rimborsi, vendite nette, spedizione, tasse, totale, e il numero di vendite. Se serve, esporta il CSV.
- Admin Shopify: **Statistiche → Report → Riepilogo finanziario** (o "Vendite totali nel tempo") sulle stesse date (i nomi dei report cambiano: da verificare il giorno stesso). Shopify definisce vendite lorde − sconti − resi = vendite nette, + spedizione + tasse = vendite totali, la stessa identità della pagina di Hullwise.

**Verifica.** Vendite nette e numero di ordini entro **±0,5%**. Se no, in quest'ordine: il fuso orario (impostazioni del tenant contro quello del negozio Shopify: un fuso diverso sposta ordini tra giorni e mesi), l'importazione dello storico (passo 3: copre tutto il mese?), ordini di test, ordini POS o bozze che il cliente non conta, carte regalo, ordini in una valuta di presentazione diversa da quella del negozio, rimborsi datati in un altro mese. Annota le due cifre e la differenza nella tua scheda di onboarding.

## Dopo la messa in produzione

- Tieni d'occhio per una settimana: `/t/<negozio>/integrations` (nessuna scheda in errore, esecuzioni verdi), le pagine **Alert** e **Integrazioni** della console.
- Controlla il ciclo di vita nella pagina del tenant in console: prova finché l'abbonamento non è pagato, poi attivo.
- Richieste privacy, cancellazione di un tenant, rotazione dei segreti, backup: `docs/DEPLOY.md`, sezione **Production**.
