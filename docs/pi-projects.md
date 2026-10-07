# Pi-projektit ja niiden suhde Entropiin

Tutkittu verkosta 7.10.2026. Lähteinä projektien omat README:t ja pakettitiedot. Tämä on tutustumiskatsaus ja oma arvio soveltuvuudesta. Projekteja ei asennettu tai ajettu, eikä niiden lupauksia varmennettu käytössä. GitHubin kehityshaara voi erota julkaistusta paketista.


## Mistä Pi-perheessä on kyse

Pi on tarkoituksella pieni ja laajennettava agenttiharness. CLI:tä voi mukauttaa extensioneilla, skilleillä, prompt-pohjilla ja teemoilla; niitä voi jakaa Pi-paketteina. Käyttötapoja ovat interaktiivinen CLI, print/JSON, RPC ja TypeScript SDK. CLI:n oletusominaisuuksista puuttuvat esimerkiksi subagentit ja plan mode, joita voi lisätä laajennuksilla. [Pi-monorepo](https://github.com/earendil-works/pi).

Pi:n ympärillä on kolme eri asiaa: viralliset kirjastot, niiden päälle tehdyt sovellukset ja CLI:n laajennukset. Samankaltainen nimi tai ominaisuus ei tarkoita yhteistä toteutusta tai yhteensopivaa API:a.

## 1. Ergonomia: käyttöpinnat ja ihmisen kontrolli

### Pi Pocket — lähin vertailukohta

Itsenäinen yhteisöprojekti, joka rakentuu Pi Durablelle. README kuvaa yhteiset live-sessiot, läsnäolon, ihmisten sivukeskustelun, maininnat, pinnaukset, reaktiot, muistilaput ja puheenvuorot. Agenttia voi ohjata, jonottaa viestejä ja pysäyttää; keskusteluista voi tehdä forkkeja ja käyttää omia worktreeitä.

Ergonomiassa mukana ovat puhelinkäyttö, push-hyväksynnät, Omarchy-teemat, Hyprland-tyyliset ikkunat, diff-näkymät, artefaktit ja yhteisesti käytettävä selain. Lisäksi README kuvaa ajastukset, `/until`-tavoitteet, katselu-/ohjausroolit, kutsut sekä henkilö- ja sessiokohtaiset kulurajat. [Pi Pocket](https://github.com/TannerMidd/pi-pocket).

**Oma arvio:** tämä osuu poikkeuksellisen moneen sinun ajatukseesi. Erityisesti puheenvuorot, sivukeskustelu, reconnect, rajattu päivitysvirta ja puhelimesta tehtävä päätös ovat tarkastelun arvoisia käyttötapoja. Entropin oikeiden ulkoisten töiden, realmien ja vastuiden kokonaisuus vaatii silti oman tarkastelunsa.

Pocket itse rajaa malliaan: ohjausoikeus antaa agentin kautta host-käyttäjän pääsyn; sessiokutsu rajaa sovelluksen näkyvyyttä. Worktree ei ole sandbox. Tavalliset Pi CLI -extensionit eivät lataudu Pocketiin sellaisinaan, vaan sillä on omat Durable-extensionit. [Pocketin rajat](https://github.com/TannerMidd/pi-pocket#limitations).

### Kaksi eri Pi Desktopia

| Projekti | Projektin kuvaama toteutus | Oma arvio Entropin kannalta |
|---|---|---|
| [FaqFirebase/pi-desktop](https://github.com/FaqFirebase/pi-desktop) | Alpha-vaiheen Electron-GUI Pi:lle ja oh-my-pi:lle RPC:n kautta. Keskustelu, tiedostot, terminaali, diff-review, taustasessiot, Mission Control, ilmoitukset, teemat ja paikallinen puhesyöttö. | Hyviä vertailukohtia taustatyön näkyvyydelle, review-kuorman käsittelylle ja nopealle siirtymiselle töiden välillä. |
| [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) | Early Preview -vaiheen paikallinen työympäristö. Agenttien, mallien ja workflowiden lisäksi pluginit voivat lisätä paneeleita, widgettejä, teemoja, MCP-palvelimia ja taustapalveluja. | Kiinnostava esimerkki siitä, että työympäristön laajennus voi sisältää kokonaisen käyttökokemuksen. Entropin palvelu- ja core-raja pitää arvioida omista töistä. |

Näillä on eri tekijät ja eri koodipohjat. Kumpaakaan ei tässä varmennettu Entropin asiakkaaksi.

### Review Loop ja Pi Voice

| Projekti | Projektin tarjoama toiminto | Oma arvio |
|---|---|---|
| [pi-review-loop](https://github.com/earendil-works/pi-review-loop) | Pysyvä inkrementaalinen diff-review. Review tallentaa sessioon checkpointin; seuraava kierros näyttää sen jälkeen muuttuneen sisällön. Kommentit viedään Pi:n editoriin käyttäjän lähetettäviksi. | Konkreettinen ratkaisu siihen, ettei ihmisen tarvitse tarkastaa jo käsiteltyä muutosta uudelleen. Entropissa kuittaus voi tarvittaessa liittyä työhön tai patchsetiin. |
| [pi-voice](https://github.com/earendil-works/pi-voice) | Paikallinen puheesta tekstiksi -syöttö ja `transcribe_file` ääni-/videotiedostoille. Entinen pi-transcribe on siirtynyt Pi Voiceksi. | Rakennusidea puheella ohjaamiseen ja aineiston litterointiin. Kokouksen päätökset, vastuut ja evidenssi vaativat tämän päälle työn käsittelyä. |

## 2. Työ: yhteistyö, työnjako ja muisti

### pi-chat — agentti olemassa olevaan keskusteluun

Virallinen Pi-extension yhdistää Discord-kanavat sekä Telegramin yksityis- ja ryhmäkeskustelut Pi-sessioihin. Yhteydellä on Gondolin-microVM, pysyvä workspace, jaettu tallennus, muisti ja skillit. Mukana ovat liitteet, historian haku, striimatut vastaukset ja keskustelukomennot kuten stop ja status. Muisti ja skillit jakautuvat tilin yhteiseen ja kanavan omaan tasoon. [pi-chat](https://github.com/earendil-works/pi-chat).

**Oma arvio:** käyttökelpoinen esimerkki hiljaisesta kanava-agentista ja vaihtoehtoisesta käyttöpinnasta. README:n ”durable memory” tarkoittaa tässä pysyviä muistifilejä; siitä ei voi päätellä Pi Durable -runtimen tai Entropin työn tilakoneen käyttöä.

### Subagentit — monta erillistä toteutusta

| Projekti | Dokumentoitu painotus | Oma arvio |
|---|---|---|
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | Kohdistetut lapsiagentit, foreground/background, valmiit roolit, workflowt, fleet-näkymä, steering ja stop. | Hyvä vertailukohta näkyvälle delegoinnille ja työn tarkastelulle. |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | Claude-tyyliset subagentit, omat agenttityypit, taustasuoritus, ohjaus ja JavaScript-workflowt `agent`/`parallel`/`pipeline`. | Esimerkki suoritusstrategiasta, jonka voisi sijoittaa executorin tai swarm-palvelun vastuulle. |
| [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents) | Nimetyt agentit, tuore tai forkattu konteksti, viestintä, taustatyöt ja interaktiiviset lapset Herdrissä tai muissa terminaalipinnoissa. | Lähellä nykyistä tapaa seurata ja ohjata rinnakkaisia agentteja. |

**Oma arvio:** usean agentin suoritus tarvitsee Entropissa yhteyden työn vastuuseen, näkyvyyteen, päätöksiin ja pysäytykseen. Näiden extensionien olemassaolo ei vielä tee niistä Durable-adaptereita. Pi Durablella on myös omat task-, child-task- ja subagenttirakenteensa. [Durablen tehtävät](https://github.com/earendil-works/pi/tree/main/packages/durable).

### Muistiprojektit ratkaisevat eri tarpeita

| Projekti | Projektin kuvaama muistimalli | Oma arvio suhteessa Entropiin |
|---|---|---|
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | Kerää havaintoja ja niistä johdettuja reflektioita taustalla. Compaction rakentaa kontekstin valmiista muistista; recall voi palauttaa muistimerkinnän lähde-evidenssin. | Vertailukohta OptChatille: mikä kannattaa säilyttää havaintona ja miten alkuperään pääsee takaisin. Vaikutusta tarkkuuteen ja viiveeseen ei tässä mitattu. |
| [pi-portia](https://github.com/vihu/pi-portia) | Beta-vaiheen projektikohtainen SQLite-muisti: polkuviitteet, päätökset, invariantit, gotchat, haku, inspektrio, vanhentuneen tiedon korjaus ja rajattu kontekstin injektio. | Kiinnostava agenttien jakama projektimuisti. Entropin realmien ja yksityisen tiedon jakamisen säännöt pitää toteuttaa erikseen. |
| [pi-agent-continuity](https://github.com/vishn9893/pi-agent-continuity) | Pieni extension-scaffold, joka yhdistää sessio-/subagenttitapahtumat ja compaction-havainnot paikalliseen JSONL-ledgeriin; silta subagent-extensioniin. | Hyvä pieni rajaus jatkuvuudelle. README erottaa toteutetun perustan esimerkiksi myöhemmästä automaattisesta kontekstin injektiosta. |

Entropissa säilyvä alkuperäishistoria, agentin työmuisti ja ihmisen poissaolosta paluun kooste voivat käyttää samaa aineistoa, mutta ne palvelevat eri tilanteita. Tämä on katsauksen oma johtopäätös.

### oh-my-pi — vaihtoehtoinen coding harness

Pi:stä forkattu coding agent, joka kuvaa sisäänrakennetut LSP-/debugger-työkalut, subagentit, reviewn, projektimuistin, yhteisen session linkillä sekä ACP-käytön editorista. [oh-my-pi](https://github.com/can1357/oh-my-pi).

**Oma arvio:** liittyy Unicorn-/vaihdettava-executor-ajatukseen. Sitä voisi arvioida työn suorittajana erillisen adapterin takana; Entropi-yhteensopivuutta, palautumista tai ulkoisen työn ohjausta ei tässä kokeiltu. Projektin suorituskykylupauksia ei käytetty vertailutuloksina.

## 3. Teknologia: viralliset rakennuspalikat

| Palikka ja lähde | Sen vastuu | Oma arvio Entropin kannalta |
|---|---|---|
| [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) | Yhteinen mallirajapinta, providerit, autentikoinnin ratkaisu, tool-skeemat, striimaus sekä token-/kuluseuranta. | Vaihdettava inferenssi; jo käytössä Entropissa. |
| [pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent) | Tilallinen agenttilooppi, toolien suoritus ja tapahtumavirta pi-ai:n päällä. | Eri rakennuspalikka kuin pysyvä Harness; nykyinen Entropi käyttää Durablea. |
| [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) | Kokeellinen pysyvä harness: keskustelut, tallennetut task-vaiheet, dokumentit, commitit, resume, fork, steer ja compaction. | Agenttisuorituksen pysyvyys; jo käytössä. |
| [chord](https://github.com/earendil-works/pi/tree/main/packages/chord) | Itsenäinen sovellusten koostamisruntime: facetit, palvelut, replikoitu tila ja liitettävä etäpalveluraja. | Mahdollinen tuki laajennusten eri prosessi-/käyttöpintaosille. Entropi käyttää Chordia jo Pi:n yhteydessä. |
| [pi-coding-agent / Pi](https://github.com/earendil-works/pi) | Käytettävä CLI, SDK, RPC ja laajennusekosysteemi. | Oma agentti+skill -käyttöpinta tai erillinen coding executor. |
| [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) | Terminaalin komponentit, differentiaalinen renderöinti, teemat ja tuetuissa terminaaleissa kuvat. | Rakennuspalikka mahdolliselle TUI-asiakkaalle. |
| [pi-telemetry](https://github.com/earendil-works/pi/tree/main/packages/telemetry) | Backendista riippumattomat telemetry-sopimukset, spanit ja tyypitetyt skeemat; sovellus tuo exporter-adapterin. | Suorituksen havainnointi ja Gym-mittaukset tarvitsevat lisäksi oman keruun ja tulkinnan. |

### pi-server ja pi-protocol — samaan sessioon useita käyttöpintoja

Kokeellinen pi-server reitittää asiakkaita sovelluksen hostaamiin pysyviin Sessioneihin. Sama Session voi saada useita presentation-liitoksia. Sovellus omistaa session hakemiston, hallinnan ja workerin; palvelin hoitaa liitoksen reitityksen ja hylkää vanhat tai ristiriitaiset reitit. Kokeellisen Unix-transportin peer-auth jää sovellukselle. [pi-server](https://github.com/earendil-works/pi/tree/main/packages/server).

Pi-protocol määrittelee reititetyt viestikehykset, request/response-korrelaation, peruutuksen, subscription-päivitykset sekä CBOR-/byte-stream-kehystyksen. Chord vastaa niiden sisällä kulkevien palvelukutsujen ja replikoidun tilan semantiikasta. Protokolla on kokeellinen ilman yhteensopivuustakuuta. [pi-protocol](https://github.com/earendil-works/pi/tree/main/packages/protocol).

**Oma arvio:** nämä ovat suoraan relevantteja ”UI voi olla mikä tahansa” -ajatukselle. Niiden reititys käsittelee sessioita ja liitoksia; Entropin realm, käyttäjän päätösvalta ja ulkoisen työn merkitys ovat sovelluksen vastuuta. Rakennuspalikoita kannattaa verrata nykyiseen yhteyskerrokseen todellisen usean käyttöpinnan kokeilun yhteydessä. Tässä ei ehdoteta nykyisen HTTP/SSE-polun vaihtoa.

### ExecutionEnv ja Gondolin — suoritusympäristön raja

Durablen `ExecutionEnv` tarjoaa vaihdettavan tiedosto-/komentoympäristön. Host muodostaa sen keskustelukohtaisesti; peruutus kulkee Contextin kautta. Näin built-in toolit voivat käyttää sovelluksen valitsemaa ympäristöä. [Durablen ympäristörajapinta](https://github.com/earendil-works/pi/tree/main/packages/durable#environment).

Gondolin tarjoaa paikallisen Linux-microVM:n ja JavaScriptillä ohjattavat hostin verkko-/tiedostopolitiikat. Oikea salaisuus voidaan lisätä vain sallittuun ulospäin lähtevään HTTP-pyyntöön, jolloin guest näkee placeholderin. QEMU on oletus; krun on kokeellinen vaihtoehto. [Gondolin](https://github.com/earendil-works/gondolin).

**Oma arvio:** ExecutionEnv on luonteva kohta Entropin Podman-/Kube-ympäristölle. Gondolin on tutkittava vaihtoehtoinen backend ja esimerkki credentials-välityksestä. Käyttäjän lupa tehdä tietty toiminto ja suoritusympäristön tekninen pääsy ovat molemmat tarpeellisia rajoja, eri kerroksissa.

### Pysyvyyden käytännön rajat

Durable ilmoittaa tallennukselle yhden omistajaprosessin kerrallaan ilman prosessien välistä lukitusta. Sama `requestId` löytää aiemman submissionin. Prosessin katketessa toolien jatkaminen riippuu niiden replay-safe-luokittelusta. Näistä ei seuraa ulkoisen toiminnon yleistä exactly-once-takuuta. API on kokeellinen. [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

**Oma arvio:** Entropin outbox, ulkoisen adapterin idempotenssi ja työn todellisen tilan tarkistus säilyvät merkityksellisinä. Multiuser voidaan toteuttaa yhden hallitun writerin ja useiden asiakkaiden kautta; usean workerin malli tarvitsee selkeän tallennuksen omistajuuden.

## Mitä tämä kertoo Entropin suunnasta

Alla on oma tulkinta luettujen projektien ja Entropin tuotekartan suhteesta.

| Entropin tarve | Lähin tutkittu vertailukohta | Entropissa selvitettävä kohta |
|---|---|---|
| Yhteinen agentti puhelimesta ja työpöydältä | Pi Pocket | Työ yli session, käyttäjän toimivalta ja realmit |
| Vaihdettava käyttöpinta ja laajennukset | Chord, pi-server, pi-protocol | Tuotteen omat palvelut ja käyttäjäkohtaiset näkymät |
| Hallittava review-kuorma | Review Loop, FaqFirebase Desktop | Kuittauksen suhde ulkoiseen muutokseen ja työn tilaan |
| Agentti mukana ihmisten keskustelussa | pi-chat | Työn tunnistaminen, vastuut ja päätösten siirto kanavasta |
| Jatkuva työmuisti | Observational Memory, Portia, Continuity | Alkuperä, näkyvyys, tiedon jakaminen ja ihmisen paluukooste |
| Swarm ja vahva yksittäinen executor | Subagent-projektit, oh-my-pi, Durable tasks | Strategian kytkentä pysyvään työhön ja ihmisen kontrolliin |
| Eristetty suoritus | ExecutionEnv, Gondolin | Nykyisten backendien elinkaari, identiteetti ja credentials |

Minusta Entropin oma kokonaisuus näkyy siinä, miten sama pitkäikäinen työ yhdistää ihmiset, agentit, ulkoisen totuuden, päätökset ja huomionhallinnan. Pi-perhe tarjoaa paljon suorituksen ja käyttöpintojen rakennuspalikoita. Niiden rinnalla tuotteen suunta tarkentuu käyttämällä Entropia oikeaan työhön.

## Muut tutkitut lähteet

- [Earendil Works](https://github.com/earendil-works): virallisten projektien hakemisto.
- [pi-demo](https://github.com/earendil-works/pi-demo): ruudun ja kamerakuvan tallennus, automaattinen zoom ja demovienti Pi:n sisältä. Tuotteen esittelyn työkalu.
