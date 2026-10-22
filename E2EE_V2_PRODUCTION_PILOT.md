# E2EE v2 Production Pilot Runbook

Status: voorbereiding; niet geactiveerd.

Dit runbook activeert uitsluitend een kleine, vooraf vastgelegde cohort. Zet
nooit wildcards, productie-identifiers of reviewbewijs in Git.

## Vereisten

1. `npm run verify:e2ee:security-review` slaagt op de vastgepinde frontend.
2. Frontend- en backendcommits uit het attestation zijn gedeployed.
3. Alle pilotapparaten ondersteunen `pulse_e2ee_v2`.
4. De geselecteerde gesprekken zijn een-op-een-gesprekken.
5. Firestore TTL voor `e2eePreKeyClaims.expiresAt` is actief en gecontroleerd.

## Serverconfiguratie

Stel de volgende waarden uitsluitend als afgeschermde deploymentsecrets in:

```text
E2EE_V2_ENABLED=true
E2EE_V2_ROLLOUT_MODE=pilot
E2EE_V2_PILOT_SEND_ENABLED=false
E2EE_V2_PILOT_USER_IDS=<comma-separated opaque user IDs>
E2EE_V2_PILOT_CONVERSATION_IDS=<comma-separated opaque conversation IDs>
E2EE_V2_REVIEW_ATTESTATION_SHA256=<64 lowercase hex characters>
E2EE_V2_REVIEW_FRONTEND_COMMIT=<40 lowercase hex characters>
E2EE_V2_REVIEW_BACKEND_COMMIT=<40 lowercase hex characters>
PULSE_RELEASE_COMMIT_SHA=<same reviewed backend commit, injected by CI>
E2EE_V2_WEB_PROVIDER_ENABLED=true
```

De server weigert pilotmodus als een allowlist leeg of ongeldig is, als een
reviewpin ontbreekt, als de gedeployde releasecommit van de beoordeelde
backendcommit afwijkt of als een wildcard wordt gebruikt. Niet-ingeschreven
gebruikers en gesprekken krijgen `403`.

QA gebruikt afzonderlijk:

```text
E2EE_V2_ENABLED=true
E2EE_V2_ROLLOUT_MODE=qa
E2EE_V2_QA_MODE_ACKNOWLEDGED=true
```

Gebruik `qa` nooit op een productieomgeving.

## Activering

1. Deploy met `E2EE_V2_PILOT_SEND_ENABLED=false`.
2. Controleer `/readyz`; `capabilities.e2eeV2` moet `true` zijn.
3. Laat uitsluitend ingeschreven accounts hun devices registreren.
4. Controleer per account devicecapaciteit, prekeys en identityversies.
5. Zet uitsluitend allowlisted gesprekken op `v2_pending`.
6. Controleer dat plaintext, identifiers en ciphertext niet in applicatielogs
   voorkomen.
7. Zet `E2EE_V2_PILOT_SEND_ENABLED=true` en voer de pilotmatrix uit.
8. Zet een gesprek pas na een volledig geslaagde matrix op `v2_required`.
9. Toon uitsluitend voor `v2_required` de E2EE-indicator.

## Privacyveilige observatie

`[PulseMetric]`-regels bevatten uitsluitend:

- vaste operatienaam;
- `success`, `client_error` of `server_error`;
- HTTP-statuscode;
- rolloutmodus;
- grove tijdsbucket.

De telemetrie accepteert geen user-, conversation-, message- of device-ID,
URL, ciphertext of berichtinhoud.

## Stoppen en herstel

Zet bij afwijkingen eerst `E2EE_V2_PILOT_SEND_ENABLED=false`. Daarmee stoppen
nieuwe berichten, terwijl bestaande ciphertext nog kan worden opgehaald,
ontsleuteld en bevestigd en devices kunnen worden ingetrokken. Verlaag een
`v2_required` gesprek nooit naar plaintext of legacy. Zet de globale gate pas
uit nadat alle pending envelopes zijn hersteld of bewust zijn afgehandeld.

Verwijder of vervang daarna de betrokken conversation- en user-ID's in de
allowlists, trek zo nodig devices in en onderzoek de vaste foutklasse. Breid de
cohort pas uit nadat alle open kritieke en hoge bevindingen nul zijn.
