# PrimeStack Switch — Complete Architecture

## 14 Services, 8 Phases, 134 Files

```
PHASE 1: CORE FOUNDATION
  ✅ Ledger Service          :9010   Double-entry accounting (SERIALIZABLE)
  ✅ Transfer Service        :9014   Fund movement orchestration
  ✅ Auth Service             :9012   Legacy HMAC (superseded by security-service)
  ✅ Terminal Service         :9013   Terminal registry + full TMS

PHASE 2: SWITCH CORE + SECURITY
  ✅ Switch Core              :9019   Transaction lifecycle engine (PS20261022000001)
  ✅ Security Service         :9020   API keys, HMAC, mTLS refs, RBAC, bcrypt, key rotation

PHASE 4: RISK ENGINE
  ✅ Risk Engine              :9015   Blacklist, velocity (Redis), scoring, AML, manual review

PHASE 5: ROUTING ENGINE
  ✅ Routing Engine           :9021   BIN routing, acquirer failover, health monitoring

PHASE 6: SETTLEMENT & RECONCILIATION
  ✅ Settlement Engine        :9017   Net settlement, NACHA, EOD, reversals, chargebacks
  ✅ Reconciliation Engine    :9017   Switch vs Bank vs Processor comparison, exceptions

PHASE 7: ISO 8583 NETWORK GATEWAY
  ✅ ISO 8583 Gateway         :9022   Parser, builder, MTI router, host connections, sessions

PHASE 8: TERMINAL MANAGEMENT PLATFORM
  ✅ Terminal Management      :9013   Groups, parameter distribution, app management,
                                     key lifecycle, firmware deployment, device analytics

INFRASTRUCTURE
  ✅ API Gateway              :9024   Single external entry (IP → HMAC → Route)
  ✅ IP Whitelist Service     :9011   CIDR/INET range matching
  ✅ Audit Service            :9016   INSERT-ONLY compliance event log
  ✅ Notification Service     :9018   Email/SMS/webhook with retry + i18n templates
```

## Complete Transaction Flow

```
Terminal / API Client
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│ API Gateway :9024                                       │
│   1. IP Whitelist check  (ip-whitelist-service :9011)   │
│   2. HMAC verify          (security-service    :9020)   │
│   3. Route to service                                    │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│ Switch Core :9019                                        │
│   4. Generate txRef: PS20261022000000001                 │
│   5. Generate STAN/RRN/auth_code                         │
│   6. Validate terminal   (terminal-service    :9013)    │
│   7. Risk evaluation     (risk-service         :9015)   │
│      → BLOCK (blacklist/geo) → decline                    │
│      → REVIEW (score 30-69) → manual_review queue         │
│      → APPROVE (score <30) → continue                     │
│   8. Route decision      (routing-service      :9021)   │
│      → NO_ROUTE → ISO code 92                             │
│      → FOUND → failover chain check                       │
│   9. Post to ledger      (ledger-service        :9010)   │
│      → SERIALIZABLE transaction                            │
│      → Atomic balance change (THE money movement)         │
│  10. Mark APPROVED + auth_code                            │
│  11. Enqueue settlement                                   │
│  12. Notify               (notification-service :9018)   │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│ ISO 8583 Gateway :9022 (for terminal-originated tx)     │
│   - Parse inbound hex message                            │
│   - MTI routing (0200→switch, 0800→echo)                 │
│   - Forward to switch-core                               │
│   - Build ISO response with response code               │
│   - Host connection pool management                      │
│   - Session tracking + heartbeat                         │
└─────────────────────────────────────────────────────────┘

      Async settlement path:
┌─────────────────────────────────────────────────────────┐
│ Settlement Engine :9017                                  │
│   - Settlement queue (PENDING → SETTLED)                  │
│   - Net positions per participant per business date      │
│   - Net settlement: 25,100 tx → 3 wire transfers         │
│   - NACHA bank file generation (SHA-256 integrity)       │
│   - Chargebacks (CB-20261022-000001)                      │
│   - Reversals (full lifecycle)                           │
│   - Reconciliation: Switch vs Bank vs Processor           │
│   - EOD: FREEZE → BATCH → NET → SETTLE → RECON → REPORT  │
│   - Treasury dashboard                                   │
│   - Business reports (daily/monthly)                     │
└─────────────────────────────────────────────────────────┘

      Terminal management:
┌─────────────────────────────────────────────────────────┐
│ Terminal Management Platform :9013                       │
│   - Terminal registry (register, activate, decommission) │
│   - Health monitoring (heartbeats, CPU, memory, latency)  │
│   - Remote command queue (reboot, update config, keys)   │
│   - EMV parameter management                             │
│   - Terminal groups (batch operations)                   │
│   - Parameter distribution (push config remotely)        │
│   - Application management (version tracking)             │
│   - Key lifecycle (inject, rotate, expiry tracking)       │
│   - Firmware deployment (download, verify, rollback)     │
│   - Device analytics (per-terminal daily stats)           │
│   - Activity log (audit trail)                            │
└─────────────────────────────────────────────────────────┘
```

## Service Ports

| Port | Service | Phase | Key Responsibility |
|------|---------|-------|--------------------|
| 9010 | ledger-service | 1 | Double-entry accounting (SERIALIZABLE isolation) |
| 9011 | ip-whitelist-service | 1 | CIDR/INET network filtering with 30s cache |
| 9012 | auth-service | 1 | Legacy HMAC (use security-service) |
| 9013 | terminal-service | 1+8 | Terminal registry + full TMS |
| 9014 | transfer-service | 1 | Fund movement orchestration |
| 9015 | risk-service | 4 | Velocity/blacklist/scoring/AML/manual review |
| 9016 | audit-service | 1 | INSERT-ONLY compliance log |
| 9017 | settlement-service | 6 | Net settlement, NACHA, EOD, chargebacks, reconciliation |
| 9018 | notification-service | 1 | Multi-channel delivery with retry + i18n |
| 9019 | switch-core | 2 | Transaction lifecycle (PS refs, STAN, ISO 8583 codes) |
| 9020 | security-service | 2 | API keys (bcrypt), HMAC (AES-256-GCM), RBAC, key rotation |
| 9021 | routing-service | 5 | BIN routing, acquirer failover, health monitoring |
| 9022 | iso8583-gateway | 7 | Parser, builder, MTI router, host connections, sessions |
| 9024 | api-gateway | Infra | Single external entry: IP → HMAC → Route |

## Test Suites

```bash
# 8 test suites, 76 tests total
cd services/ledger-service     && npm test   # 12 tests — double-entry guarantees
cd services/transfer-service   && npm test   # 6 tests  — orchestration flow
cd services/risk-service       && npm test   # 12 tests — blacklist, scoring, AML
cd services/routing-service    && npm test   # 12 tests — terminal/merchant/rule/failover
cd services/settlement-service && npm test   # 13 tests — batches, EOD, reconciliation
cd services/switch-core        && npm test   # 10 tests — reference format, ISO codes
cd services/security-service  && npm test   # 12 tests — HMAC, bcrypt, RBAC
cd services/iso8583-gateway   && npm test   # 15 tests — parser round-trip, MTI mapping
```

## Start Everything

```bash
cd services
docker compose up --build

# 14 services start in dependency order:
#   postgres → redis → rabbitmq
#   → ledger → ip-whitelist → auth → security
#   → terminal → risk → routing
#   → transfer → switch-core → settlement → notification
#   → iso8583-gateway → audit
#   → api-gateway (last, depends on all)
```

## What This Is NOT (Production Requirements)

- [ ] PCI DSS Level 1 certification
- [ ] HSM integration for cryptographic key storage
- [ ] Money transmitter license (jurisdiction-specific)
- [ ] Bank sponsor / acquirer agreements
- [ ] Card network certification (Visa, MC)
- [ ] ISO 8583 host certification with acquiring bank
- [ ] Security audit by qualified firm
- [ ] Load testing at 10x expected peak TPS
- [ ] Disaster recovery with tested RPO/RTO
- [ ] SOC 2 Type II audit
- [ ] 24/7 on-call + incident response playbook
- [ ] Financial reconciliation procedures + SAR process
