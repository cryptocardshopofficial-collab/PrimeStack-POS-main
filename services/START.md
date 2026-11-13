# PrimeStack Switch — How to Start

## Full stack with Docker

```bash
cd services

# Start all infrastructure + services
docker compose up --build

# Services come up in this order (enforced by healthchecks):
#   1. postgres + redis + rabbitmq
#   2. ledger-service       :9010
#   3. ip-whitelist-service  :9011
#   4. auth-service          :9012
#   5. security-service      :9020
#   6. terminal-service      :9013
#   7. risk-service          :9015
#   8. routing-service       :9021
#   9. transfer-service      :9014  (needs ledger + risk)
#  10. switch-core           :9019  (needs ledger + risk + routing)
#  11. settlement-service    :9017  (needs ledger)
#  12. notification-service   :9018
#  13. iso8583-gateway        :9022  (needs switch-core)
#  14. audit-service          :9016
#  15. api-gateway            :9024  (single external entry point)
```

## Individual service (development)

```bash
# 1. Start infrastructure
docker compose up postgres redis rabbitmq -d

# 2. Run the ledger service (foundation — start first)
cd services/ledger-service
npm install
npx tsx src/server.ts
# → [ledger-service] listening on port 9010

# 3. Run the security service (handles HMAC + API keys)
cd services/security-service
npm install
npx tsx src/server.ts
# → [security-service] listening on port 9020

# 4. Run the risk engine (Redis + PostgreSQL)
cd services/risk-service
npm install
npx tsx src/server.ts
# → [risk-service] listening on port 9015

# 5. Run the routing engine
cd services/routing-service
npm install
npx tsx src/server.ts
# → [routing-service] listening on port 9021

# 6. Run the switch core (the transaction engine)
cd services/switch-core
npm install
npx tsx src/server.ts
# → [switch-core] listening on port 9019

# 7. Run the API gateway (entry point)
cd services/api-gateway-service
npm install
npx tsx src/server.ts
# → [api-gateway] listening on port 9024
```

## Run migrations manually

```bash
# Each service has its own database
psql -U primestack -d primestack_ledger    -f ledger-service/migrations/001_initial.sql
psql -U primestack -d primestack_auth      -f auth-service/migrations/001_initial.sql
psql -U primestack -d primestack_security   -f security-service/migrations/001_initial.sql
psql -U primestack -d primestack_ipwl      -f ip-whitelist-service/migrations/001_initial.sql
psql -U primestack -d primestack_terminal   -f terminal-service/migrations/001_initial.sql
psql -U primestack -d primestack_terminal   -f terminal-service/migrations/002_tms.sql
psql -U primestack -d primestack_transfer   -f transfer-service/migrations/001_initial.sql
psql -U primestack -d primestack_risk       -f risk-service/migrations/001_initial.sql
psql -U primestack -d primestack_audit      -f audit-service/migrations/001_initial.sql
psql -U primestack -d primestack_settlement -f settlement-service/migrations/001_initial.sql
psql -U primestack -d primestack_settlement -f settlement-service/migrations/002_reconciliation.sql
psql -U primestack -d primestack_settlement -f settlement-service/migrations/003_full_settlement.sql
psql -U primestack -d primestack_notification -f notification-service/migrations/001_initial.sql
psql -U primestack -d primestack_routing    -f routing-service/migrations/001_initial.sql
psql -U primestack -d primestack_iso8583    -f iso8583-gateway/migrations/001_initial.sql
```

## Verify services are running

```bash
for port in 9010 9011 9012 9013 9014 9015 9016 9017 9018 9019 9020 9021 9022 9024; do
  curl -s http://localhost:$port/health | head -1
  echo " (port $port)"
done
```

## Run all test suites

```bash
# 9 test suites, 94 tests total
cd services/ledger-service     && npm install && npm test    # 12 tests — ledger guarantees
cd services/transfer-service   && npm install && npm test    # 6 tests  — orchestration
cd services/risk-service       && npm install && npm test     # 12 tests — risk pipeline
cd services/routing-service    && npm install && npm test    # 12 tests — routing + failover
cd services/settlement-service && npm install && npm test   # 13 tests — settlement + EOD
cd services/switch-core        && npm install && npm test    # 10 tests — references + ISO
cd services/security-service  && npm install && npm test    # 12 tests — HMAC + bcrypt + RBAC
cd services/iso8583-gateway   && npm install && npm test     # 15 tests — parser round-trip
cd services/terminal-service   && npm install && npm test    # 18 tests — TMS lifecycle
```

## Service ports summary

| Port | Service | Phase | Purpose |
|------|---------|-------|---------|
| 9010 | ledger-service | 1 | Double-entry accounting (SERIALIZABLE) |
| 9011 | ip-whitelist-service | 1 | CIDR/INET network filtering |
| 9012 | auth-service | 1 | Legacy HMAC (use security-service) |
| 9013 | terminal-service | 1+8 | Terminal registry + full TMS |
| 9014 | transfer-service | 1 | Fund movement orchestration |
| 9015 | risk-service | 4 | Velocity/blacklist/scoring/AML |
| 9016 | audit-service | 1 | INSERT-ONLY compliance log |
| 9017 | settlement-service | 6 | Net settlement, NACHA, EOD, chargebacks |
| 9018 | notification-service | 1 | Multi-channel delivery + i18n |
| 9019 | switch-core | 2 | Transaction lifecycle engine |
| 9020 | security-service | 2 | API keys, HMAC, RBAC, key rotation |
| 9021 | routing-service | 5 | BIN routing, acquirer failover |
| 9022 | iso8583-gateway | 7 | Parser, builder, host connections |
| 9024 | api-gateway | Infra | Single external entry point |

## Create your first HMAC key

```bash
curl -X POST http://localhost:9020/hmac/keys \
  -H "Content-Type: application/json" \
  -d '{"label":"My first key"}'
# Response: { "data": { "clientId": "psk_...", "secret": "..." } }
# → SAVE THE SECRET — it will never be shown again
```

## Add your IP to the whitelist

```bash
curl -X POST http://localhost:9011/entries \
  -H "Content-Type: application/json" \
  -d '{"ipRange":"YOUR_IP/32","label":"My dev machine"}'
```

## Send your first transaction through the switch

```bash
# Sign and send via the API gateway
CLIENT_ID="psk_..."
SECRET="..."
TIMESTAMP=$(date +%s%3N)
BODY='{"txType":"WALLET","sourceAccount":"wallet-alice","destinationAccount":"wallet-bob","amount":"50","currency":"USD"}'
BODY_HASH=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
PAYLOAD="POST\n/v1/transactions\n$TIMESTAMP\n$BODY_HASH"
SIGNATURE=$(echo -e "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST http://localhost:9024/v1/transactions \
  -H "Content-Type: application/json" \
  -H "x-primestack-client-id: $CLIENT_ID" \
  -H "x-primestack-timestamp: $TIMESTAMP" \
  -H "x-primestack-signature: $SIGNATURE" \
  -d "$BODY"

# Response: { "success": true, "data": { "txRef": "PS20261022000000001", "responseCode": "00", "approved": true } }
```

## Parse an ISO 8583 message

```bash
curl -X POST http://localhost:9022/parse \
  -H "Content-Type: application/json" \
  -d '{"hexMessage":"00080200..."}'
# Returns: { "mti": "0200", "fields": {"2":"4111...","4":"000000001000",...} }
```

## Run the EOD settlement cycle

```bash
curl -X POST http://localhost:9017/eod/run \
  -H "Content-Type: application/json" \
  -d '{"businessDate":"2026-10-22","runBy":"ops-admin"}'

# Returns: { "batchId": "...", "participantsSettled": 42, "totalVolume": "1250000.00" }
```
