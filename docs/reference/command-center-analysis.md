> Historical document: the product was formerly called Keel.

> **Nota per Claude Code: questo documento è CONTESTO, non specifica.**
> Descrive la piattaforma originale, single-tenant e costruita per un e-commerce che vende molto in contrassegno. Per questo l'analisi dà molto peso al contrassegno. **Per Keel quel peso non vale:** il core è indipendente dal metodo di pagamento, e tutto ciò che riguarda conferma degli ordini, assegnazione degli operatori, delivery score e rischio destinatario appartiene solo all'add-on `addon.cod`.
> La sezione "Proposta di core e tier" di questo documento è **superata**: i tier e i moduli validi sono quelli di `CLAUDE.md`. In caso di conflitto vale sempre `CLAUDE.md`.

# Command Center: analisi funzionalità e riusabilità come prodotto SaaS

Sep 30, 2026 · @Federico

## Sintesi e verdetto

Il Command Center è rivendibile come prodotto, ma non così com'è. Circa l'80% del valore sta nella logica e nei flussi scoperti sul campo; circa il 70% del codice è legato a Lorena. La strada è un nuovo core multi-tenant che riusa logica, SQL e manuale, non un porting del codice.

| Modulo | Adattabilità codice (1–5) | Valore del concetto | Tier proposto |
| --- | --- | --- | --- |
| Ordini | 2 | Alto | Core |
| Conferma contrassegno e assegnazione | 3–4 | Molto alto | Core |
| Delivery score e rischio destinatario | 3 | Alto | Core / Growth |
| Logistica, giacenze, rientri | 1 (codice) · 4 (modello) | Il più alto in euro | Growth |
| Catalogo, inventario, riordini, acquisti | 2–3 | Medio-alto | Growth |
| Intelligence: ads, margini, P/L | 3 | Molto alto | Growth |
| CRM WhatsApp con gruppo di controllo | 2 | Il più alto del prodotto | Scale |
| Strumenti AI | 2 (Studio) · 4 (assistente, MCP) | Alto | Scale / add-on |
| Piattaforma trasversale | 4 | Medio | Tutti |

**Tre cose da sapere prima di decidere:**

1. **Il differenziatore non è la conferma via WhatsApp** (commodity da 5 $), ma tre cose rare insieme: coda di conferma con operatori, margine reale per campagna, effetto delle campagne misurato con gruppo di controllo.
2. **Il cliente ideale è stretto:** Shopify, molto contrassegno, un team che conferma. Va contato prima di investire.
3. **Il primo mattone è lo stato canonico dell'ordine.** Finché lo stato viene dai tag di Lorena, nessun altro negozio può usare il prodotto.

**Cosa ho letto:** struttura del repository, memoria del progetto, manuale di integrazioni, ordini, conferma contrassegno, assegnazione, delivery score, logistica, giacenze, catalogo, riordini, campagne ↔ stock, controllo ads, campagne WhatsApp. **Cosa non ho letto per intero:** acquisti, customer care, resi, AI Studio, assistente AI, MCP, dashboard e impostazioni (descritti dall'indice del manuale) e il codice sorgente delle edge function.

## Architettura attuale

Il Command Center è un'app single-tenant solida: regge oltre 240.000 ordini con sync resilienti, ma ogni tabella, cron e segreto appartiene a un solo negozio.

| Livello | Cosa c'è oggi | Note per il prodotto |
| --- | --- | --- |
| Frontend | React + TypeScript, Tailwind, shadcn/ui, generato e mantenuto in Lovable | Riusabile; UI solo in italiano, palette e stile del brand Lorena |
| Backend | Supabase: Postgres con RLS, edge function Deno, pg\_cron, migrazioni Drizzle | Riusabile come stack; RLS separa i ruoli, non i clienti |
| Dati | Ordini, righe, prodotti, varianti, contatti, spedizioni, eventi logistici, snapshot inventario, conversazioni WhatsApp, P/L | Nessuna colonna cliente/tenant: va aggiunta ovunque |
| Job | Cron globali: retry webhook ogni 5 min, riconciliazioni notturne, sync inventario 01:00 UTC, backfill Meta ogni minuto | Vanno resi per tenant, con code e limiti per cliente |
| Configurazione | Tabella `app_settings` globale, segreti come variabili d'ambiente | Serve un vault di credenziali per cliente |
| AI | Lovable AI Gateway (Gemini), Kling, Creatify, ElevenLabs, Google TTS | Il gateway Lovable non segue il codice fuori da Lovable: va sostituito con chiavi proprie |

**Integrazioni cablate oggi:** Shopify (API 2025-01, webhook + sync bulk), Elogy (3PL), Qapla' (tracking), GLS (giacenze), Spoki (WhatsApp), Meta Marketing API, Google Ads, Make.com (metriche Facebook), Slack, un server MCP per Claude.

**Punti di forza da preservare:** ack immediato dei webhook con elaborazione in background, retry automatici con idempotenza, riconciliazioni notturne, backfill a finestre riavviabili, wrapper di errori leggibili per le edge function. Questa parte vale più delle schermate: è quella che un concorrente impiega mesi a imparare.

## Mappa delle funzionalità

Punteggio di adattabilità *così com'è*: 5 = funziona per un altro e-commerce Shopify cambiando solo configurazione; 1 = va riscritto. Il valore del concetto è indicato a parte: spesso è alto anche dove il codice non si riusa.

### 1. Ordini

**Cosa fa.** Centro del ciclo ordine, dalla ricezione via webhook Shopify alla consegna o al rientro. Include:

- lista server-side su oltre 240.000 ordini, ricerca per numero, nome, email, telefono;
- creazione manuale con tre metodi di pagamento (contrassegno, link carta via email, bonifico), recupero cliente, venditore registrato;
- modifica di indirizzo, telefono e note via REST; qualsiasi modifica ai prodotti passa da "Annulla e Ricrea" con lineage (il nuovo ordine eredita data, operatore e attribuzione);
- unione di ordini doppi, applicazione sconti, conferma programmata alle 05:00, segna come pagato;
- attesa stock: backorder collegati agli ordini d'acquisto, hold dell'evasione su Shopify, sblocco automatico al rientro;
- timeline con autore e diff campo per campo, note interne con @menzioni, storico cliente con match a catena su ID, email, telefono, indirizzo.

**Come funziona.** Edge function `shopify-order-actions` per tutte le scritture; stato visibile calcolato da `deriveOrderState()` e dalla funzione SQL `derive_order_workflow_from_tags()`.

**Legato a Lorena.**

- Lo stato di workflow si ricava da una lista fissa di tag: `Confermato`, `ElogyV2`, `Variazione`, `Già pagato`, `Momoka confermato`, `Conferma WhatsApp`, `Da chiamare`, `Da lavorare`. La lista è ripetuta in tre punti (frontend, filtro, SQL).
- Molte regole esistono per convivere con i Flow Shopify di Lorena, che aggiungono e tolgono tag.
- IVA sempre inclusa e `tax_exempt` forzato, commissione contrassegno riconosciuta dal titolo italiano, prefisso `LM-`, telefoni normalizzati in `+39`, autocomplete indirizzi limitato all'Italia, ordini Releasit gestiti come caso speciale.

**Adattabilità: 2/5.** Il flusso operativo è il migliore del prodotto, ma poggia su tag e automazioni che un altro negozio non ha. **Valore del concetto: alto.** Va rifatto sopra uno stato canonico con una mappatura tag → stato configurabile per cliente.

### 2. Conferma contrassegno e assegnazione

**Cosa fa.** Coda di conferma telefonica degli ordini in contrassegno, gestita da operatori, non da un bot. Priorità per richieste di modifica, richiamate scadute e tentativi falliti; esiti registrati (conferma, non risponde, richiamare, annulla, modifica); al terzo tentativo l'ordine diventa non raggiungibile. KPI per operatore e vista supervisore.

L'**assegnazione automatica** distribuisce gli ordini in proporzione alle ore lavorate: calendario per operatore, ferie ed extra, round-robin pesato sul "debito" di ciascuno, riassegnazione se cambia il tag. Rilascio, trasferimento ed escalation con regole anti-abuso: dopo la prima chiamata solo un admin può spostare l'ordine.

**Come funziona.** Funzione SQL unica `is_cod_queue_order` (dal 25/09/2026 basata sullo stato reale e non sui tag), RPC `cod_queue_page`, funzioni `auto_assign_cod_order`, `claim_cod_order`, sweep ogni 10 minuti.

**Legato a Lorena.** I cinque tag operativi (`Da chiamare`, `Richiesta modifica`, `Da lavorare`, `Potenziale Double Type`, `Da confermare`) sono cablati nei filtri e nelle abilitazioni degli operatori. I template dei messaggi si copiano negli appunti invece di partire da WhatsApp.

**Adattabilità.** Coda: 3/5. Assegnazione: 4/5, è il pezzo più generico di tutto il prodotto. **Valore del concetto: molto alto.** È ciò che separa questo prodotto dalle app da 5 $/mese: quelle mandano un messaggio, questa gestisce un call center.

### 3. Delivery Score e rischio destinatario

**Cosa fa.** Punteggio 0–100 di probabilità di consegna per ogni ordine, spiegato fattore per fattore, con pop-up "controlli prima di procedere" quando si apre un ordine in coda. Diciassette fattori, tra cui storico cliente con decadimento a 180 giorni, esiti di ordini simili per CAP, qualità indirizzo, tentativi, risposte WhatsApp, valore fuori media, ordini doppi dello stesso cliente. Pesi regolabili dall'admin con anteprima live.

Il **rischio destinatario** classifica chi rifiuta sistematicamente i pacchi (blacklist, alto rischio) sul numero di telefono, con costo già generato e valore atteso. È solo un suggerimento: nessun ordine viene toccato in automatico.

**Legato a Lorena.** Alcuni fattori sono da calzature (taglie diverse nel carrello, paia duplicate, taglia diversa dallo storico, 10 punti di peso). Le regole sull'indirizzo presuppongono CAP italiani a 5 cifre e provincia. Il costo dei rientri arriva dall'import delle fatture Elogy.

**Adattabilità: 3/5.** Motore e pesi configurabili sono già generici; servono fattori per categoria (taglia per moda, variante per altri) e regole indirizzo per paese. **Valore del concetto: alto e vendibile da solo.**

### 4. Logistica, giacenze e rientri

**Cosa fa.** Una riga di spedizione per ordine, stato ricalcolato da un trigger che combina più fonti: vince Qapla' se ha un evento nelle ultime 24 ore, altrimenti Elogy; eccezioni "appiccicose" solo con causa reale e auto-chiusura dopo 15 giorni; conflitti tra fonti registrati. Coda **giacenze** GLS con quattro esiti e istruzione inviata al corriere via email. **Rientri al mittente** automatici: annullamento su Shopify senza restock, void del pagamento, tag, casi dubbi in revisione manuale.

**Legato a Lorena.** Quasi tutto:

- push ordini, codici di tracking (19, 19.1, 21, 30…) e payload specifici di Elogy;
- giacenze solo GLS, email in italiano firmata "Lorena Milano – Customer Care";
- motore regole giacenze costruito ma fermo in simulazione, adapter GLS ancora mock;
- feed Qapla' silente da giugno 2026.

**Adattabilità: 1/5 per il codice, 4/5 per il modello.** Il pattern "ogni fonte scrive il proprio campo, un trigger decide lo stato con precedenze" è esattamente l'architettura giusta per un prodotto multi-corriere. Le integrazioni vanno rifatte una per una. **Valore del concetto: il più alto in euro**, perché il recupero delle consegne fallite è dove il cliente perde più soldi.

### 5. Catalogo, inventario, riordini e acquisti

**Cosa fa.**

- **Catalogo (PIM leggero):** creazione prodotto con codice obbligatorio, varianti generate da colori × taglie, SKU automatico `Nome-Codice-TagliaColoreEN`, traduzione colori con AI, immagini per colore, pubblicazione su Shopify singola o bulk in background, anti-duplicati.
- **Inventario:** quattro livelli di sync (webhook in tempo reale, full sync notturno, forzatura manuale, refresh della singola variante), matrice colore × taglia con disponibile, impegnato e in arrivo.
- **Riordini:** velocità di vendita per variante su lookback variabile, giorni di copertura, rischio; suggerimento di acquisto "a blocchi" con curva taglie per fornitore e simulazione per colore.
- **Acquisti (ODA):** stati da bozza ad "a stock", registro e saldi fornitori, copertura dei backorder cliente. Il caricamento a stock sblocca in automatico gli ordini in attesa. *Descrizione ricavata dai rimandi negli altri moduli: la scheda Acquisti non è stata letta per intero.*

**Legato a Lorena.** Blocchi e curva taglie attivi solo sulle categorie calzature; lista categorie fissa (Sneakers, Sandali, Decollette…); pattern SKU e codice prodotto di Lorena; confronto con lo stock fisico Elogy; SKU `Contrassegno` e `Assicurazione-pacco` esclusi a mano.

**Adattabilità.** Inventario e riordini: 3/5, la logica di velocità e copertura è universale. Catalogo: 2/5, perché molti negozi gestiscono il catalogo direttamente in Shopify e non vogliono un secondo PIM. Acquisti: 3/5. **Valore del concetto: medio-alto** per moda e calzature (curva taglie a blocchi), medio per gli altri.

### 6. Intelligence: ads, margini e P/L

**Cosa fa.**

- **Campagne ↔ Stock:** una riga per campagna Meta attiva con spesa, ordini attribuiti, ricavi, MOL, profitto, ROI, ROAS, CPA; semaforo "va bene / medio / male"; azione consigliata (spegni, accendi, considera) eseguibile con un clic via API Meta; stock del prodotto collegato alla campagna e consiglio di riacquisto.
- **Controllo Ads:** registro giornaliero data × campagna con tutti i rapporti ricalcolati in SQL a ogni lettura, badge del motivo quando un dato manca, export CSV.
- **Marketing overview e attribuzione:** attribuzione su tre livelli dagli UTM Shopify, customer journey via GraphQL, sync Google Ads con gclid, backfill Meta riavviabile a finestre mensili.
- **P/L ed EBITDA:** conto economico per ordine con costi di logistica per spedizione configurabili per mese.

**Come funziona.** Vista unica `v_order_economics` per il margine di ogni ordine, vista `v_campaign_day_perf` condivisa tra le pagine, così i numeri coincidono ovunque.

**Legato a Lorena.**

- IVA fissa al 22% (`total / 1.22`), fuso Europe/Rome in tutte le viste.
- Contano solo gli ordini **confermati**, non quelli consegnati o incassati: per un negozio in contrassegno il margine reale è più basso di quello mostrato.
- Una campagna è collegata a un prodotto principale: funziona per chi fa una campagna per prodotto, come Lorena, meno per chi fa campagne di catalogo.
- Metriche Facebook in parte ancora importate con uno scenario Make.

**Adattabilità: 3/5.** La matematica è universale; vanno parametrizzati IVA per paese, fuso, stato che "conta" come vendita e il legame campagna → prodotti. **Valore del concetto: molto alto.** Aggiungendo il filtro "consegnato" diventa il ROAS reale di cui parlavamo, che è la leva di vendita più forte verso chi fa Meta Ads.

### 7. CRM WhatsApp: segmenti, campagne, misura dell'effetto

**Cosa fa.** È un prodotto a sé, e il più sofisticato dell'app:

- costruttore di segmenti con gruppi E/O fino a 3 livelli e 30 condizioni, taglia e categoria prevalente, fasce RFM, ricettività WhatsApp, campione casuale stabile;
- wizard in 6 passi con test A/B, caroselli per taglia, sequenze fino a 10 passi con condizioni di uscita, campagne "sempre attive" che fanno entrare ogni giorno i nuovi clienti del segmento;
- **gruppo di controllo** con calcolo dell'incremento, intervallo al 95%, p-value, margine netto per persona, e un assistente che suggerisce quanto deve essere grande il controllo;
- controlli pre-avvio bloccanti (template approvato, stock disponibile, credito residuo con 100 € di riserva per i transazionali), fascia oraria 9–20, auto-pausa sugli errori, priorità tra campagne;
- codici sconto personali generati in blocco su Shopify, link e pagina personale con i modelli nella taglia della cliente;
- matrice RFM con soglia di convenienza del messaggio.

**Legato a Lorena.** Tutto passa dall'API Spoki; dominio `lorenamilano.app` nei link personali; prefisso codici `LM-WA`; variabili `LM_PAGINA`, `LM_CODICE`; taglie 35–46 e collezioni `taglia-38`; saluto di riserva "cara"; margine medio di 19 € per ordine usato nella soglia RFM.

**Adattabilità: 2/5 per il codice, perché Spoki e le taglie sono ovunque.** **Valore del concetto: il più alto dell'intero prodotto.** La misura dell'effetto con gruppo di controllo è rara nel mercato: la maggior parte degli strumenti di marketing WhatsApp mostra aperture e clic, non il margine incrementale \[Probabile\]. Con WhatsApp Cloud API al posto di Spoki e "attributo prevalente" al posto di "taglia" diventa vendibile a qualsiasi negozio.

### 8. Strumenti AI

**Cosa fa.** *Sezione basata sull'indice del manuale, non sulla lettura completa delle schede.*

- **AI Studio:** testi, immagini prodotto, Clip Studio e Video Composer con Kling, voiceover ElevenLabs e sottotitoli karaoke, virtual try-on (prodotto indossato su modella), "riprese vere" con cambio scarpa su foto reali, libreria di creatività approvate con notifica Slack.
- **AI Assistant marketing:** chat per l'admin con Gemini 2.5 Pro, strumenti predefiniti e SQL in sola lettura su viste dedicate.
- **MCP per Claude:** il Command Center come connettore di Claude, con strumenti di lettura e di preparazione in bozza (segmenti, template, campagne in approvazione), permessi per ruolo e dati mascherati.

**Legato a Lorena.** Prompt e preset pensati per calzature (prima/dopo, "scarpa prima coerente con la famiglia"), Lovable AI Gateway come fornitore dei modelli, costi Kling e ElevenLabs a carico di un solo account.

**Adattabilità.** AI Studio: 2/5, costoso da operare e dipendente dalla categoria. Assistente e MCP: 4/5, perché dipendono solo dal modello dati. **Valore del concetto:** alto per MCP e assistente, che sono un argomento di vendita moderno; l'AI Studio va venduto come add-on a consumo, mai incluso nel canone.

### 9. Piattaforma e servizi trasversali

**Cosa fa.** Ruoli (admin, operations, customer care, marketing) con permessi per pagina; "visualizza come" per l'admin; notifiche in-app; annunci delle novità generati dall'AI dopo ogni rilascio; salute delle integrazioni con auto-retry; vista mobile curata; customer care con I miei ordini e vista supervisore; resi; contatti; sconti sincronizzati con Shopify; manuale del team aggiornato a ogni modifica.

**Adattabilità: 4/5.** È infrastruttura generica; vanno solo tradotti i testi e separati i dati per cliente. **Valore del concetto: medio,** ma riduce il costo di supporto: un cliente che vede lo stato delle sue integrazioni apre meno ticket.

## Dipendenze specifiche di Lorena Milano

Le dipendenze sono tredici e nessuna è un vicolo cieco: ognuna ha una generalizzazione nota. Il problema è che sono sparse in tutti i moduli, quindi vanno tolte nel nuovo core, non una alla volta nel codice attuale.

| Dipendenza | Dove compare | Come si generalizza |
| --- | --- | --- |
| Stato ordine derivato dai tag Shopify | Ordini, coda, P/L, dashboard, assegnazione | Stato canonico interno + regole tag/campi → stato configurabili per cliente |
| Convivenza con Flow Shopify e Releasit | Webhook, pulizia tag, blocco "Variazione" | Il core non scrive tag operativi; li scrive solo se il cliente lo chiede |
| Elogy (3PL) | Push ordini, stati, stock fisico, fatture, rientri | Interfaccia "magazzino" con adapter; import CSV come adapter di default |
| Qapla' e GLS | Tracking, giacenze, istruzioni email | Interfaccia "corriere" + aggregatore di tracking; istruzioni giacenza come template per corriere |
| Spoki | Chat, template, campagne, webhook | WhatsApp Cloud API diretta con onboarding del numero del cliente |
| Interfaccia e testi in italiano | Tutta l'app, email, messaggi | Internazionalizzazione (it, en, es come prime lingue) |
| Telefono `+39`, CAP a 5 cifre, provincia, Google Places solo Italia | Ordini, storico cliente, score | Libreria telefonica internazionale e regole indirizzo per paese |
| Fuso Europe/Rome, IVA 22% | Viste, cron, P/L, ROAS | Impostazioni per cliente: fuso, valuta, aliquote |
| Taglie 35–46, categorie calzature, blocchi di riordino | Catalogo, riordini, score, campagne per taglia | "Attributo prevalente" configurabile (taglia, colore, formato) |
| Commissione contrassegno €2,95 riconosciuta dal titolo | Ordini, sconti, unioni | Prodotto "commissione" scelto in configurazione |
| Branding: palette, firma email, dominio `lorenamilano.app`, prefissi `LM-` | UI, email GLS, link personali, codici sconto | Tema, dominio e prefissi per cliente |
| Lovable AI Gateway e scenario Make | AI, metriche Facebook | Chiavi proprie dei fornitori AI; import Meta nativo |
| `app_settings` globale, segreti in variabili d'ambiente, cron globali | Tutto il backend | Impostazioni e credenziali per cliente, job in coda per cliente |

La riga che pesa di più è la prima: lo stato derivato dai tag tocca quasi ogni modulo. Una volta sostituita con uno stato canonico, il resto è lavoro di adapter e configurazione.

## Proposta di core e tier

Il modello core a tier + setup + sviluppi custom regge, ma solo se il custom vive fuori dal core. Il cliente ideale si restringe: un e-commerce Shopify con molto contrassegno e **persone** che confermano gli ordini, perché il valore principale (coda operatori, assegnazione, score) serve solo a chi ha un team di conferma. Chi non ha operatori compra un'app da 5 $.

| Tier | Moduli inclusi | Per chi | Prezzo \[Ipotesi\] |
| --- | --- | --- | --- |
| **Core · Ordini e contrassegno** | Ordini, coda di conferma con operatori, assegnazione automatica, delivery score, storico cliente, WhatsApp transazionale, salute integrazioni | Negozio con 1–3 operatori, 1–5k ordini/mese | 249–349 €/mese |
| **Growth · Profitto** | + P/L ed EBITDA, ROAS reale su consegnati, Campagne ↔ Stock con spegnimento, riordini e acquisti, rischio destinatario, giacenze e rientri | Negozio che spende su Meta e vuole il margine vero | 590–890 €/mese |
| **Scale · CRM** | + CRM WhatsApp con gruppo di controllo, segmenti e RFM, sequenze, codici personali, assistente AI e connettore Claude | Negozio con base clienti grande da riattivare | 1.290–1.890 €/mese |
| **Add-on AI Studio** | Immagini, video, try-on | Chi produce creatività in casa | A consumo, con margine sui costi dei fornitori |

I prezzi sono ipotesi da validare: vanno legati anche al volume di ordini mensili, perché il costo di infrastruttura cresce con gli ordini, non con i clienti.

**Setup a pagamento** \[Ipotesi 1.500–5.000 €\]: mappatura stati e tag del cliente, collegamento magazzino e corrieri, import dello storico ordini (serve al delivery score e allo storico cliente), configurazione team e turni, formazione. Il setup non è un extra: senza lo storico importato score e rischio destinatario partono vuoti.

**Sviluppi custom, con una regola sola:** si sviluppano come adapter o plugin dentro confini definiti (nuovo corriere, nuovo 3PL, nuovo fattore di score, nuova regola), mai come modifica del core per un singolo cliente. Un adapter richiesto da un cliente diventa disponibile per tutti gli altri dello stesso paese: è così che il custom finanzia il prodotto invece di frammentarlo.

**Conflitto con Facebook Ads.** Con setup a pagamento e configurazione, il canale principale è la vendita assistita: demo e call. Facebook Ads resta utile per generare contatti con il caso Lorena, non per vendere in self-serve.

## Piano di uscita da Lovable

La regola centrale: Lorena resta sull'app attuale finché il core non copre i suoi moduli, poi diventa il primo cliente del core. Mai due versioni dello stesso modulo in sviluppo attivo per mesi. Tempi indicati come ipotesi per 2 sviluppatori con Claude Code.

1. **Accordo scritto sulla proprietà del codice** (settimana 1). Il progetto sta nel workspace Lovable di Lorena Milano e il backend Supabase è legato a quel progetto: serve un documento che dica che il codice è di Automations Lab e che Lorena ne ha la licenza d'uso.
2. **Repository ed estrazione** (settimane 1–2). Esportare il codice su GitHub, nuovo repository per il core, nuovo progetto Supabase, Claude Code come ambiente di sviluppo. Il manuale del team e la memoria del progetto diventano la specifica funzionale: sono la parte più preziosa dell'esportazione.
3. **Fondamenta multi-tenant** (settimane 2–6). Modello dati canonico, colonna cliente e sicurezza per cliente su ogni tabella, impostazioni e credenziali per cliente, job in coda per cliente, internazionalizzazione, adapter Shopify e WhatsApp Cloud API.
4. **Primo tier vendibile: Core** (settimane 6–12). Portare Ordini, coda di conferma, assegnazione, delivery score e storico cliente, riscritti sopra lo stato canonico. Import CSV come adapter di magazzino di default.
5. **Pilota con 2–3 negozi esterni** (settimane 12–16). Setup pagato anche se scontato: serve a verificare che la configurazione regga senza codice nuovo. Ogni richiesta di codice nuovo va annotata: è la misura di quanto il core è davvero generico.
6. **Growth** (settimane 16–24). P/L, ROAS reale su consegnati, Campagne ↔ Stock, riordini, rischio destinatario, primo adapter corriere e giacenze.
7. **Migrazione di Lorena sul core** (quando Growth è pronto). Le sue particolarità (Elogy, GLS, blocchi taglie) diventano adapter e plugin del core.
8. **Scale** (dal mese 6). CRM WhatsApp con gruppo di controllo, MCP e assistente AI.

**Cosa non portare:** le correzioni puntuali su singoli ordini, i backfill una tantum, le regole nate per aggirare i Flow Shopify di Lorena, il motore giacenze fermo in simulazione (va riprogettato sul primo corriere reale).

## Rischi e domande aperte

Il rischio più probabile non è tecnico: è costruire un core generico e scoprire che ogni cliente chiede il suo "Lorena" su misura.

| Rischio | Probabilità \[Ipotesi\] | Contromisura |
| --- | --- | --- |
| Ogni cliente vuole modifiche al core | Alta | Regola adapter/plugin, pilota che misura le richieste di codice nuovo |
| Mercato ristretto: pochi negozi con molto contrassegno e un team di conferma | Media | Validare il numero di negozi target in Italia e Spagna prima della fase 4 |
| Doppia manutenzione durante la migrazione di Lorena | Media | Nessuna nuova funzione sull'app attuale dopo la fase 3, solo correzioni |
| Ogni corriere e ogni 3PL è un'integrazione nuova | Alta | Import CSV di default, aggregatore di tracking, adapter venduti per paese |
| Onboarding WhatsApp e App Review Meta lenti | Media | Avviare verifica aziendale e tech provider subito |
| Concorrenza: app COD economiche, Klaviyo e Omnisend con WhatsApp, GoKwik in India | Media | Posizionarsi su call center + margine reale + effetto misurato, non sul singolo messaggio |
| Qualità del codice generato in Lovable | Media | Riscrivere il core, riusare la logica SQL e i test esistenti dove ci sono |

**Domande aperte**

- [ ] L'accordo sulla proprietà del codice con Lorena Milano è già scritto o solo verbale?
- [ ] Primo mercato: Italia, Spagna o entrambi?
- [ ] Chi sviluppa il core, e per quante ore a settimana?
- [ ] Lorena accetta di diventare il caso studio pubblico e il primo cliente del core?
- [ ] Quanti negozi Shopify con team di conferma contrassegno esistono nel primo mercato?
