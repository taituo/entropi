# Entropin tuotekartta

Koottu 7.10.2026 keskusteluista `/home/tiny/tra`, Crewpin ensimmäisestä toteutuksesta ja Entropin tämänhetkisestä koodista. Tämä on muistikuva tavoitteista, mahdollisuuksista ja toteutuksen tilanteesta. Se ei ole speksi, ADR, hyväksytty backlog tai käsky toteuttavalle agentille. Tuote tarkentuu rakentamalla, ajamalla, testaamalla ja korjaamalla.

Toteutuksen tilanne perustuu luettuun koodiin ja committeihin, viimeisin tarkasteltu commit `faf9e09`. Työpuussa oli lisäksi Pi-runtimeen, HTTP-rajapintaan ja testeihin keskeneräisiä muutoksia. Tässä koonnissa ei ajettu testejä eikä arvioitu ominaisuuksia tuotantovalmiiksi.

## Lähtökohta

Entropi on multiuser-agent OS: yhteinen pysyvä tilakone, jossa ihmisillä ja agenteilla on identiteetit, toimivalta, työt, yhteistyötilat ja päätökset. Web, natiivisovellus, TUI tai käyttäjän oma agentti ja skill ovat käyttöpintoja samaan järjestelmään. Tila ei kuulu käyttöliittymään.

Omistajan konkreettinen ongelma on hajallaan oleva työ: noin 25 terminaalia, agenttisessiot, Temporal-prosessit, TR:t, muutokset, CI ja jatkuva review-/hyväksyntäkuorma. Entropi kokoaa tilanteen, mahdollistaa ohjaamisen ja auttaa päättämään, mikä tarvitsee juuri tämän ihmisen huomiota.

Taustalla voi toimia paljon enemmän agentteja kuin ihminen pystyy seuraamaan. Omistajan tavoite on, ettei ihmiselle generoida enempää näkyvää sisältöä kuin hän pystyy käsittelemään. Ihmisen harkinta, innovointi ja kontrolli kuuluvat tuotteen tarkoitukseen.


## Kolme näkökulmaa samaan tuotteeseen

| Näkökulma | Kysymys | Entropin tehtävä |
|---|---|---|
| **Ergonomia: ihmisen kokemus** | Mitä minun pitää ymmärtää, huomata ja pystyä ohjaamaan? | Tilannekuva, fokus, paluu työhön, sopiva määrä tietoa, välitön kontrolli ja oma työympäristö. |
| **Työ: yhteinen tekeminen** | Mitä tehdään, kenen vastuulla ja missä vaiheessa? | Ihmiset ja agentit, työn jatkuvuus, yhteistyö, päätökset, evidenssi ja oikeat ulkoiset työt. |
| **Teknologia: toteutuksen keinot** | Millä tila säilyy ja työ voidaan suorittaa? | Core, Pi, adapterit, muisti, suoritusympäristöt, integraatiot, swarm ja kehityksen työkalut. |

Lukujärjestys on ihmisen tarve → yhteinen työ → toteutuksen keinot. Rakentamisessa kaikkia kolmea tarkennetaan samassa käytön ja korjaamisen kierrossa. Yksi idea voi koskea jokaista näkökulmaa; featurelistassa se on sijoitettu pääasiallisen tehtävänsä mukaan.

### Missä ergonomia, työ ja teknologia kohtaavat

| Kokemus tai tilanne | Yhteisen työn merkitys | Tarvittava tekniikka | Mahdollinen core-osa |
|---|---|---|---|
| ”Mitä tarvitsee minua juuri nyt?” | Työ odottaa tietyn ihmisen ratkaisua | Lähdehavainnot, kooste, ilmoitus ja käyttöpinta | Vastuu, päätös, vastausoikeus ja määräaika |
| ”Seuraan näitä kolmea työtä” | Ihmisellä on valitut kiinnostuksen kohteet | Fokuspalvelu, näkymät ja suodatus | Käyttäjän valinnat, jos ne jaetaan käyttöpintojen välillä |
| ”Mitä tapahtui poissa ollessani?” | Muutokset ja avoimet vastuut paluun jälkeen | Tapahtumien haku ja lähteisiin sidottu tiivistys | Käyttäjän käsittelemä tapahtumakohta ja kuittaus tarvittaessa |
| ”Keskeytä tai muuta suuntaa” | Työ on ihmisen ohjattavissa myös delegoituna | Komentorajapinta, runtimen peruutus ja executor-adapterit | Kutsujan oikeus, työn vastuusuhteet ja pyynnön pysyvä tila |
| ”Echo vastaa kun olen poissa” | Toinen saa tietoa ilman minun tekemääni päätöstä | Edustaja ja sallittuun muistiin rajattu haku | Läsnäolo, edustussuhde, näkyvyys ja toimivallan rajat |
| ”Tarkistan vain uudet muutokset” | Ihmisen review säilyy työn edetessä | Diff-näkymä, muutossarjat ja lähdejärjestelmän adapteri | Työn/artefaktin yhteys; kuittaus jos sillä on yhteinen merkitys |
| ”Näytä mistä tämä päätelmä tuli” | Päätös voidaan perustella alkuperäisellä evidenssillä | Historia, muistin haku, liitteet ja aika-/lähdeviitteet | Evidenssin identiteetti, yhteydet ja näkyvyys |
| ”Agentti jatkaa kaatumisen jälkeen” | Työ ja vastuu pysyvät vaikka worker vaihtuu | Pi Durable, tallennus ja outbox | Työn identiteetti, omistaja ja tila |
| ”Työpöytäni toimii omalla tavallani” | Sama työ jatkuu webissä, puhelimessa, TUI:ssa tai omalla agentilla | Vaihdettavat asiakkaat ja käyttäjäkohtaiset asetukset | Yhteiset työn säännöt; jaettavat asetukset vain tarpeen mukaan |

## Tuotteen kaari

| Kehitysvaihe keskusteluissa | Mitä opittiin tai tavoiteltiin |
|---|---|
| Pi Durable ja Pi Pocket -tutustuminen | Pysyvät agentit, rinnakkaiset keskustelut ja monen ihmisen osallistuminen ovat mahdollinen perusta. |
| K3s-testipenkki | Kokeillaan valvontaa ja kehitystä todellisilla työkaluilla, rajatuilla oikeuksilla ja vaihdettavalla inferenssillä. |
| CrewPi / Crew | Rakennetaan toimiva yhteinen työhuone: kanavat, agenttiroolit, hyväksynnät, repo, klusteri, sandbox, muisti ja workflowt. Käyttöliittymä osoittautuu onnistuneeksi. |
| Ensimmäisen version kokemukset | Koko ketju toimii, mutta ympäristö, tunnistautuminen ja integraatiot pakkautuvat samaan sovellukseen. |
| Swarm ja Unicorn | Halutaan saman yhteistyökerroksen alle myös kollektiivinen päättely ja kaupallisen harnessin itsenäinen suoritus. |
| Entropi ja realm-ajattelu | Erotetaan yleinen työn, identiteetin, toimivallan, huomion ja päätösten ydin ympäristöistä. |
| Ihmisen työympäristö | Fokus, zoom, Echo, hiljaiset agentit, multimodaalinen yhteistyö ja täysin muokattava nopea käyttöliittymä. |
| Nykyinen Entropi | Core, Pi-adapteri, outbox, muistipuu, kuvat, stop, web-käyttöpinta ja sandbox-adapterit on rakennettu. Ulkoisten töiden yhdistäminen ja laajempi ihmisen huomionhallinta ovat vielä edessä. |

Tämä kaari kuvaa ajattelun kehitystä. Se ei määrää toteutusjärjestystä.


## Miten luetaan featurelistaa

- **O**: omistajan keskusteluissa ilmaisema tavoite tai toive.
- **E**: aiemman assistentin ehdotus. Ei sellaisenaan hyväksytty ominaisuus.
- **R**: toteutuksesta tunnistettu ominaisuus tai rakenne.
- **Entropissa**: toteutus näkyy nykyisessä koodissa; laajuus voi olla rajallinen.
- **Osittain**: perusta on olemassa, mutta laajempi tavoite ei toteudu vielä.
- **Crewissä**: ensimmäisessä versiossa toteutettu; ei vielä vastaavasti nykyisessä Entropissa.
- **Idea**: tavoitteena tai ehdotuksena keskusteluissa; toteutusta ei tunnistettu.


## 1. Ergonomia — ihmisen kokemus

Tavoite on vähentää tilanteen selvittämisen ja ohjaamisen kuormaa. Ulkoasu, agenttikäyttöpinta ja huomionhallinta ovat eri keinoja tähän.

### Huomio, fokus ja oma työympäristö

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Mitä tapahtuu missäkin -tilannekuva | O | Osittain: Work/ExternalRef; oikeiden lähteiden yhdistely puuttuu |
| NOW / WAITING ON ME / BACKGROUND -tyyppinen rajattu näkymä | O, E, R | Osittain: Focus ja Needs you -paneeli |
| Käyttäjä valitsee muutaman seurattavan työn ja zoomaa sisään/ulos | O | Idea |
| Mukautuminen käyttäjän vastuisiin ja prioriteetteihin | O | Idea |
| Hiljainen henkilökohtainen assistentti suodattaa ja niputtaa keskeytyksiä | O | Idea |
| Poissaolon aikana tapahtuneen työn kooste ja reagointitarpeet | O | Idea; tapahtumat mahdollistavat perustan |
| Away + Echo vastaa kysymyksiin, ilman itsenäistä kontribuutiota tai päätöksiä | O | Osittain: presence ja päätöskielto |
| Käyttäjän osaamisen ja vahvuuksien huomiointi telemetrian avulla | O | Idea |
| Kysymysten ohjaaminen sopivalle ihmiselle | E, liittyy O | Idea |
| Visible output rajataan ihmisen käsittelykykyyn | O | Tuoteperiaate; ei vielä yleistä toteutusta |
| Calm / Normal / Detailed / Debug -tiheydet | E | Idea |
| Keskeytystä edeltävän oman ajatuskontekstin palauttaminen | E | Idea |
| Nopea käyttöjärjestelmän tuntu ja välitön kontrolli | O | Osittain: kevyt web ja live-päivitykset; ei mitattua kattavaa viivebudjettia |
| Täysin muokattava ulkoasu ja työympäristö | O | Osittain: branding ja accent |
| Toimiva wireframe ensin, teemat päälle kerroksina | O, erillinen idea log | Idea |
| Viivojen, fonttien, kokojen ja näkyvyyden säätö | O, idea log | Idea |
| Omat taustakuvat, musiikki, blur ja tilannekohtaiset kerrokset | O | Idea |
| Kokouksen aikana äänen vaimennus ja fokuksen vaihto | O, E | Idea |
| Ilmoitukset ja hyväksyntöjen push-toimitus | E | Idea |

### Käyttöpinnat ja näkyvä ohjaus

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Web-käyttöliittymä, live-päivitykset ja roolikohtaiset toiminnot | O, R | Entropissa |
| Natiivi-/desktop-käyttöpinta | O | Idea; Tauri on E |
| TUI ja Hyprlandin kaltainen ikkunoitu käyttöpinta | O | Idea |
| Oma agentti ja skill käyttöpintana | O | Idea; API-perusta olemassa |
| Agentin kyvykkyyksien, työvaiheiden ja läsnäolon näyttö | O, R | Entropissa; kortin kuvaus ei itsessään anna toimivaltaa |

### Muistin ja aineiston tarkastelu

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Muistipuun inspektrio ja käsin tiivistäminen | R | Entropissa |
| Puheella vastaaminen kysymyksiin | O | Idea |
| Tilanteen mukaan syntyvät näkymät, chartit ja taulukot | E, R | Crewissä generative UI; Entropin renderer on mukana, tuotantotyökalupolku puuttuu |

## 2. Työ — yhteinen tekeminen

Täällä ovat työt, osallistujat, vastuut, päätökset ja yhteistyön sisältö. Sama työ voi käyttää useita suorittajia ja käyttöpintoja.

### Ihmiset, agentit ja yhteiset työtilat

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Useat ihmiset ja agentit samassa pysyvässä järjestelmässä | O, R | Entropissa |
| Henkilökohtaiset, tiimi-, tuote-, organisaatio-, incident- ja autonomiset realmit | O, R | Osittain: tyypit ja eristys; laajempi UX ja käytännön politiikat puuttuvat |
| Useiden tiimien yhteistyö ja johdon koosteet | O | Idea |
| Pysyvät kanavat, case-tilat ja yksityiset agenttikeskustelut | O, R | Entropissa |
| Ihmisten keskinäinen keskustelu, agentit mukana tarvittaessa | O, R | Entropissa perustasolla |
| Säikeet ja keskustelun haarautuminen | E | Idea; Pi tarjoaa rakennuspalikoita |
| Agenttien kutsuminen @maininnalla ja näkyvä delegointi | O, R | Entropissa |
| Ihmisen hyväksyntä ja roolien mukaiset päätösoikeudet | O, R | Entropissa; core-rajoissa korjattavaa |
| Tunnistautuminen Keycloakilla tai vastaavalla | O, R | Crewissä sisäinen; Entropissa dev/proxy, tunnistautuminen infrastruktuurissa |
| Työn keskeyttäminen delegointiketjun läpi | R | Entropissa Pi-runtimeen kytkettynä |
| Pause, steer, take over, resume yhtenäisinä käyttäjätoimintoina | E | Osittain: Pi:n mekanismeja käytössä; yhtenäinen tuote-API/UI puuttuu |

### Oikeat työnkulut ja ulkoiset järjestelmät

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Agentit seuraavat ja ohjaavat olemassa olevia workflowta | O | Crewissä osittain; Entropissa lähdeperusta |
| TR: triage → plan → implement → Gerrit WIP | O | Omistajan kuvattu työnkulku; ei nykyinen Entropi-ominaisuus |
| Repo-, branch-, diff- ja review-työkalut | O, R | Crewissä |
| Gerrit patchsetit, labels ja muutoksen tilakone | O | Idea adapteriksi |
| CI/buildit ja lineaariset rutiiniketjut | O | Crewissä fixtureita ja incident-workflow; yleinen integraatio puuttuu |
| PR-/change-kuorman pilkkominen ja niputtaminen | O | Idea |
| Valvonta, poikkeaman tunnistus ja self-heal | O, R | Crewissä todellinen rajattu demoskenaario |
| Hälytyksestä case, tutkimus, päätös, toiminta ja varmennus | O, R | Crewissä; Entropissa scripted approval -demo |
| Jira, GitHub, GitLab, Gerrit, Grafana, CI ja ympäristötilat | O, E, R | Crewissä uskottavat fake-integraatiot; yleiset oikeat adapterit puuttuvat |
| Jenkins/Groovy tai muu nykyinen toteutus työn executorina | O, E | Idea |
| MCP-työkalut, Prometheus/Loki, Alertmanager ja GitOps/Argo CD | E | Idea |

### Yhteinen ymmärrys, media ja evidenssi

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Agentin valitsemat muistilaput, haku ja kanava-/agenttikohtainen scope | E, R | Crewissä; nykyisessä Entropissa puuttuu |
| Video, ääni, dokumentit ja kokoustallenteet yhteisen kontekstin aineistona | O | Idea; tekstilinkit ja kuvat ovat jo käytettävissä |
| Kokoustarpeen tunnistaminen, aiheet ja agentti esittelemään ongelma | O | Idea |
| Kokouksen litterointi, päätökset, vastuut ja avoimet kysymykset | O, E | Idea |
| Hiljainen kanava-agentti ylläpitää yhteistä kokonaisuutta | O, E | Idea |
| Päätökset, ristiriidat, havainnot ja tehtävät johdettuina näkymiin | O, E | Osittain: päätökset ja huomio; semanttinen kokonaisuus puuttuu |
| Havainto linkitetään alkuperäiseen kuvaan tai video-/ääniaikaan | E, liittyy O | Idea |

## 3. Teknologia — toteutuksen keinot

Tekniikka tuottaa pysyvän tilan, suorituksen ja yhteydet. Sen arvo näkyy yllä kuvatuissa töissä ja ihmisen kokemuksessa.

### Pysyvyys, suorittajat, työkalut ja eristys

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Headless-käyttö, tila ytimessä | O, R | Entropissa |
| Pitkäikäiset agentit ja kaatumisesta palautuvat keskustelut | O, R | Entropissa Pi-adapterilla |
| Työ ja pysyvä agentti-identiteetti erillään sessiosta/workerista | O, E, R | Perusta Entropissa |
| Transaktionaalinen outbox ja tunnisteilla idempotentti dispatch | R | Entropissa |
| Agenttikohtaiset mallit ja vaihdettava inferenssi | O, R | Entropissa |
| Paikallinen OpenAI-yhteensopiva inferenssi ja airgap | O, R | Entropissa |
| Erillinen halpa tiivistysmalli | E, R | Entropissa |
| Mallikäytön seuranta ja selkeät quota-virheet | E, R | Entropissa; yleiset käyttäjä-/realm-budjetit puuttuvat |
| Pi:n omistama consult-apuri | R | Entropissa; ei vielä yleinen swarm-moottori |
| Omien työkalujen ja laajennusten liittäminen | O, R | Entropissa Pi-laajennuksina; yleinen tuoteplugin-SDK puuttuu |
| Kaupalliset harnessit / subscription-pohjainen executor: Unicorn / Frontier Singular | O | Idea |
| Oneshot- ja jatkuva ACP-sessio | O | Idea Entropissa |
| Kiro-, Claude- ja muut coding executor -adapterit | O | Idea Entropissa |
| Sandboxissa komennot ja tiedostot | O, R | Entropissa Podman-/Kube-adaptereilla; tämän aamun uusi toteutus |
| Sandboxin resurssirajat, elinkaari ja yksityisen tilan eristys | E, R | Entropissa perusta, backendkohtaiset rajat |
| Synteettinen suoritusympäristö vain tyypitetyillä operaatioilla | O | Idea; nykyinen sandbox tarjoaa myös shellin |
| Agentti-/tool-kohtainen identiteetti ja rajatut credentials | E | Idea |
| Agenttien versiot, migraatiot ja rolloutit | E | Osittain: nykyisessä työssä runtime-konfiguraation pinnausta; ei yleistä rollout-tuotetta |

### Historia ja muistimekanismit

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Pysyvä alkuperäinen keskusteluhistoria | O, R | Entropissa, Pi omistaa runtime-transkriptin |
| OptChat: tiivistettävä ja avattava muistipuu | O, R | Entropissa; johdettu data voidaan rakentaa historiasta |
| Muistin jakamisen hallinta eri tilojen, agenttien ja realmien välillä | O, E | Osittain: DM-eristys; laajempi jakaminen puuttuu |
| Kuvat: liittäminen, paste/drop, esikatselu ja vision-malli | O, R | Entropissa |
| Muistin alkuperä, säilytys, poisto ja vienti | E | Idea; varsinaista kokonaispolitiikkaa ei ole |

### Mikä kuuluu coreen

Coreen kuuluu tila tai sääntö, jonka pitää päteä riippumatta käyttöpinnasta ja suoritusmoottorista. Tilannekuvan päättely, työn suorittaminen ja esittäminen voivat käyttää tätä tilaa omissa palveluissaan.

| Idea | Coreen kuuluva osa | Muun kerroksen vastuu | Nykyinen tilanne |
|---|---|---|---|
| Multiuser | Jäsenyys, identiteetti, toimivalta, jaettu tila ja ristiriitaisten päätösten ratkaisu | Kirjautuminen, yhteydet, käyttöliittymät | Actors, realm-jäsenyys ja ensimmäinen päätös voittaa. Oikeustarkistukset ovat epätasaisia. |
| Realm | Kontekstin, näkyvyyden ja toimivallan rajat; henkilökohtainen ja yhteinen käyttö | Realmien valinta ja yhteenvedot | Realm on lähes kaikessa ydindatassa. Realmien välinen jakaminen puuttuu. |
| Pitkäikäinen työ | Tavoite, omistaja, tila, suhteet ja päätökset | Workflowvaiheet, mallivuorot, workerit | WorkItem, parentId, ownerId, phase ja ExternalRef ovat olemassa. |
| Ulkoinen totuus | Työn yhteys ulkoisiin kohteisiin ja havaintojen alkuperä | Temporal-/Gerrit-/CI-kyselyt ja toiminta | ExternalRef ja lähderajapinta ovat olemassa; varsinaiset lähdeadapterit puuttuvat. |
| Päätöksenteko | Päätösobjekti, vastausoikeus, määräaika, idempotenssi ja tarvittaessa tehtävien eriytys | Kysymyksen sanallistaminen, puhe, kortti ja toiminnon suoritus | Perusta olemassa. Näkyvyys- ja määräaikarajoissa on korjattavaa. |
| Toimintavaltuudet | Kuka saa pyytää tai sallia minkä toiminnon missä kohteessa; tarvittaessa hyväksynnän sidonta täsmälliseen toimintoon | Varsinainen tool ja sandboxin eristys | Roolit ja delegoinnin rajat ovat olemassa. Yleinen capability-/action-raja ei vielä ole. |
| Fokus | Käyttäjän valitut työt, kiinnostuksen kohteet ja keskeytyssäännöt, jos niiden pitää toimia yli asiakkaiden | Priorisointi, tiivistäminen ja näkymän mukautuminen | Focus johdetaan tilasta, mutta käyttäjän omia fokusvalintoja ei tallenneta. |
| Poissaolosta paluu | Tarvittaessa käyttäjän käsittelemä tapahtumakohta ja kuittaukset | ”Mitä tapahtui poissa ollessani” -kooste | Tapahtumahistoria on olemassa; henkilökohtainen paluutila puuttuu. |
| Presence ja Echo | Ihmisen läsnäolo, edustajan tunnistaminen ja edustajan toimivallan rajat | Digitaalinen edustaja, muistin haku ja vastaus | Away/echo-kentät ja päätöskielto olemassa. Varsinainen Echo-toimija ja sen vastaaminen puuttuvat. |
| Yksityinen tieto ja muisti | Näkyvyys ja sallitun jakamisen rajat kaikille käyttöpinnolle | Muistipuu, muistilaput, hakeminen ja tiivistys | DM-raja olemassa; yleinen muistijakamisen malli puuttuu. |
| Multimodaalinen evidenssi | Tarvittaessa artefaktin identiteetti, käyttöoikeus ja viittaus lähteeseen tai aikakohtaan | Tallennus, litterointi, kuvien/videoiden analyysi | Kuvaliitteiden metadata olemassa. Aikaan sidottu evidenssi ei vielä ole. |
| Delegointi ja omistajuus | Vastuu, työn suhteet, sallittu luovutus ja pysäytyksen merkitys | Swarm-reititys ja runtimen lapsitehtävät | Delegointiviestit, outbox ja rajat olemassa. Työnluovutus nojaa myös vapaaseen message-metaan. |
| Autonomia ja budjetit | Jaetut, pakottavat toimintarajat, jos niitä aletaan käyttää | Mallin valinta, rahankäytön laskenta ja strategiat | Delegointirajat toimivat. Autonomy-kenttä on kuvaileva. Yleisiä budjettirajoja ei ole. |

Näistä fokusvalinnat, paluun kuittaukset, edustajan toimivalta ja tiedon jakamisen rajat ovat keskusteluissa tunnistettuja seuraavia ydintarpeita. Niille kannattaa tehdä pienin toimiva tila vasta todellisen käyttötapauksen yhteydessä.

#### Nykyisen coren rajaongelmat

Päivitys 7.10.2026, commit `7503572` ja sen työpuu: roolien muuttamisen admin-raja, päätöksen työn näkyvyys ja määräajan tarkistus on lisätty koodiin. Alla ensimmäiset kolme kohtaa kuvaavat aiempaa havaintoa, jonka korjaus näkyy nyt koodissa; tässä ei ajettu korjausten testejä. [Uusi yhteensopivuusarvio](compatibility-notes.md) erottaa jäljellä olevat ydintarpeet palveluista ja adaptereista.

Edeltävässä tarkastuksessa todettiin suorilla core-kutsuilla:

- `addActor` sallii tavallisen jäsenen muuttaa omat roolinsa adminiksi.
- `canDecide` ei tarkista päätökseen liittyvän työn yksityisyyttä. Toisen henkilön DM:n päätös voidaan hyväksyä suoralla core-kutsulla.
- `decide` ei tarkista määräaikaa; hyväksyntä onnistuu määräajan jälkeen ennen expiry-ajastimen käsittelyä.
- `createWork(state: "failed")` ei luo attentionia, vaikka samaan tilaan siirtyminen myöhemmin luo.
- `addAttachment` muuttaa tilaa tuottamatta tapahtumaa. Kaikki mutaatiot eivät siis täytä coren omaa tapahtumalupausta.

Lisäksi yleiset lukumetodit eivät ota katsojaa, `db` on julkinen, ja Pi-adapteri tekee siitä suoria kyselyitä. Nykyinen Core on osittain luotetun hostin sisäinen API. Skill-/agentti-käyttöpinta tarvitsee selvästi rajatun käyttäjäkohtaisen komentorajapinnan; actorId:n antaminen parametrina ei itsessään todista kutsujan identiteettiä.

Core määrittelee myös jo prosessikäyttäytymistä: päätöspyyntö siirtää työn waiting-tilaan ja viimeinen vastaus working-tilaan. Tämä oletus voi olla liian vahva rinnakkaisille töille tai ulkoiselle workflowlle. OptChatin tiivistysajon sijoittaminen core-hakemistoon on toinen arvioitava raja. Kanavat, keskustelut, liitteiden oikeudet ja outbox ovat perusteltuja yhteisen yhteistyötilan osia.


### Swarm ja Gym

Omistajan tavoite on kokeilla hyvää päättelyketjua ja kontekstin voimaa, sekä yhdistää swarm ja Unicorn samaan tuotteeseen. Keskustelun laaja historiallinen strategiakatalogi on assistentin ehdotuksia, ei tilaus toteuttaa kaikki. Historiallisia vuosilukuja tai tutkimusväitteitä ei tässä tarkistettu.

| Perhe / ominaisuus | Keskustelussa esiintyvät vaihtoehdot | Sijainti ja tilanne |
|---|---|---|
| Vertailutaso | Direct, yksi agentti; Unicorn yhtenä vahvana harnessina | Executor/strategiapalvelu. Pi-direct olemassa, Unicorn idea. |
| Riippumattomat ratkaisut | Blind swarm, context isolation, self-consistency ja synteesi | Swarm-palvelu; idea |
| Kritiikki ja korjaaminen | Critic, debate, reflexion, adversarial, Red/Blue, swarm ennen hyväksyntää | Swarm-palvelu; idea |
| Yhteinen työmuisti | Blackboard, blackboard scheduler, evidence packets, context capsules, stigmergy | Swarm-palvelu; tiedon näkyvyys coreen. Idea. |
| Mukautuva työmäärä | Entropy gate, adaptive swarm, minimal swarm, information bottleneck, lossy context | Swarm-palvelu; pakottavat resurssirajat ja oikeudet yhteisiä. Idea. |
| Reititys ja työnjako | Mixture of Experts, expert choice, contract net/auction, contextual bandit, dynaamiset specialistit | Swarm-palvelu; työn vastuusuhteet coreen. Idea. |
| Hakustrategiat | Tree/Graph of Thoughts, Monte Carlo, simulated annealing, evolutionary, novelty search, MAP-Elites | Swarm-palvelu; idea |
| Kollektiiviset ja hierarkkiset mallit | Ant colony, particle swarm, Society of Mind, Ashby/requisite variety, subsumption, hierarchical/fractal, role mutation | Tutkimus-/strategiakokeiluja; idea |
| Episteeminen päättely | Hypoteesit, erimielisyys, epistemic/Bayesian swarm, lähteisiin sidottu varmuus | Swarm-/evidenssipalvelu; idea |
| Kaksi swarm-tasoa | Yhden agentin apurit; usean pysyvän agentin työnjako | Ensimmäisestä consult-perusta; laajempi orkestrointi puuttuu |
| Gym | Sama tehtävä eri strategioilla, budgetit, onnistuminen, viive, hinta ja päättelyn hyöty | Kehitys-/eval-ympäristö; idea |
| Swarmien hardening | Spawn-/depth-/rate-/tokenrajat, kontekstieristys, oikeudet, duplikaattien torjunta ja hyväksyntäportit | Entropissa delegoinnin rajat ja runtime/sandbox-perusta; yleinen swarm-policy puuttuu |


### Kehitys, oma käyttö ja tarkistaminen

| Ominaisuus | Alkuperä | Tilanne |
|---|---|---|
| Rakentaminen, oma käyttö, testaus, aukkojen löytäminen ja korjaus | O | Nykyinen toimintatapa |
| Halpa oikea LLM ohjaa simuloitua, muuttuvaa maailmaa | O | Entropissa live-testien ja fake-/gateway-testien perusta; koko Crewpin maailma ei mukana |
| Deterministinen plumbing-/E2E-testaus | E, R | Entropissa |
| Todellinen prosessin tappaminen ja palautumisen tarkistus | E, R | Entropissa |
| Oikean selaimen multiuser-, oikeus-, kuva- ja mobiilitarkistus | R | Entropissa scripts/ui-check |
| Prompt injection, loopit, hylkäys, kiintiöt ja virheiden simulointi | E, R | Osittain: delegointirajat, hylkäys, quota ja flaky-gateway |
| Historiasta replay/eval uuden mallin tai promptin vertailuun | E | Idea |
| Auditointi ja suoritusten havainnointi | O, E, R | Core-eventit ja Pi:n historia/käyttö olemassa; laajempi observability puuttuu |
| Backup/restore, deploy-polku ja tuotannon ylläpidettävyys | E | Crewpin arvioinnin kehitysehdotuksia; ei tämän koonnin määräämä toteutuslista |


## Pi-projektien yhteys tähän karttaan

[Pi-ekosysteemin katsaus](pi-projects.md) kokoaa verkosta tutkitut projektit samoihin ergonomian, työn ja teknologian näkökulmiin. Se erottaa viralliset rakennuspalikat, valmiit sovellukset ja yhteisön laajennukset sekä arvioi niiden suhdetta Entropiin.

[Puuttuvat yhteydet ja yhteensopivuus](compatibility-notes.md) tarkastelee nykyisen koodin perusteella työn ja suorituksen yhteyttä, yhteistä komentorajaa, hyväksytyn toiminnon sitomista, ulkoista totuutta ja usean käyttöpinnan palautumista.

## Käytännön reitti kohti alkuperäistä hyötyä

Näiden keskustelujen ja nykyisen toteutuksen perusteella seuraava kokeilu voisi olla yksi omistajan oikea työ: TR → Temporal → ACP/Kiro → Gerrit → CI. Entropi linkittää sen yhdeksi Workiksi, näyttää varmennetun tilanteen, vastaanottaa tarvittavan ihmisen päätöksen ja antaa tarkastella alkuperäistä evidenssiä.

Samassa kokeilussa selviää, tarvitseeko core heti fokusvalinnan, käyttäjän kuittauskohdan tai toimintavaltuuden uuden käsitteen. Palaa poissaolon jälkeen ja katso, pystyykö Entropi kertomaan mitä muuttui ja mikä tarvitsee sinua. Swarm ja Unicorn voidaan kokeilla tämän työn suorittajina ilman, että niiden strategiat päätyvät coreen.

Omistajan sanoin tavoite liittyy ”mitä tapahtuu missäkin” -kuorman vähentämiseen ja siihen, että käyttäjä kokee olevansa kontrollissa. Terminaalien vähentyminen, tarpeellisten keskeytysten määrä ja tiedon oikeellisuus ovat käyttökelpoisia havaintoja tästä. Keskustelun numeroehdotukset, kuten 30 changen tiivistäminen 3–5 asiaksi, ovat assistentin havainnollistuksia, eivät hyväksyttyjä mittaritavoitteita.


## Lähteet

- [Pi Durable testipenkki](</home/tiny/tra/Pi Durable testipenkki (1).md>): alkuperäinen kokeilu, multiuser-työtila, workflowt ja core-ajatukset.
- [Crewpi arviointi](</home/tiny/tra/Crewpi arviointi (1).md>): tekninen velka ja oikealla halvalla mallilla ajettava simuloitu ketju.
- [Pi Durable swarm-ratkaisu](</home/tiny/tra/Pi Durable swarm-ratkaisu (1).md>): swarm/Gym, Unicorn, Echo, fokus ja multimodaalinen yhteistyö.
- [Pi Durablen selitys](</home/tiny/tra/Pi Durablen selitys (1).zip>), `conversation.md`: omistajan tarkennukset Entropin tarkoituksesta, realmeista, käyttöpinnasta, huomionhallinnasta ja kontrollista.
- [UI-idea log](/home/tiny/projects/durable/entropi-ideas.md): wireframe ja muokattavat teematasot.
- [Crew README](/home/tiny/projects/durable/workspace/README.md) ja [durable agent OS](/home/tiny/projects/durable/workspace/docs/durable-agent-os.md): ensimmäisen toteutuksen ominaisuudet ja kokemukset.
- Entropin `src/core`, `src/adapters`, `src/http`, `public`, `test` ja `scripts`: nykytilan vertailu. Tämän koonnin aikaan muut agentit jatkoivat toteutusta.
