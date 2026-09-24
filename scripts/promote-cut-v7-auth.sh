#!/usr/bin/env bash
# Atomic Cut Salon auth promotion: canary → production BAILEYS_V7 owner.
# Run as root on the VPS. Does NOT delete backups.
set -Eeuo pipefail

CUT_KEY="wa_f09d54055f079b2624800b46"
CANARY_SVC="whatsapp-cut-v7-canary.service"
BOT_SVC="whatsapp-bot.service"
CANARY_AUTH="/home/whatsapp/canary-auth/cut-salon-v7"
PROD_V7_BASE="/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts-v7"
PROD_V7_AUTH="${PROD_V7_BASE}/${CUT_KEY}"
PROD_V6_AUTH="/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts/${CUT_KEY}"
BACKUP_ROOT="/home/whatsapp/auth-backups/selective-v7-$(date -u +%Y%m%dT%H%M%SZ)"
REGISTRY="/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts/runtime-registry.json"

echo "BACKUP_ROOT=${BACKUP_ROOT}"
mkdir -p "${BACKUP_ROOT}"

echo "[1] Stop canary (exclusive owner release)"
systemctl stop "${CANARY_SVC}" || true
sleep 2
if systemctl is-active --quiet "${CANARY_SVC}"; then
  echo "FATAL: canary still active"
  exit 1
fi
# Ensure no leftover canary node
pkill -u whatsapp -f 'baileys-v7-cut-canary' 2>/dev/null || true
sleep 1

echo "[2] Backup canary auth + v6 auth"
cp -a "${CANARY_AUTH}" "${BACKUP_ROOT}/canary-auth"
if [ -d "${PROD_V6_AUTH}" ]; then
  cp -a "${PROD_V6_AUTH}" "${BACKUP_ROOT}/v6-auth"
fi
cp -a "${REGISTRY}" "${BACKUP_ROOT}/runtime-registry.json" 2>/dev/null || true

echo "[3] Adopt canary auth into production v7 path (move, not live copy)"
mkdir -p "${PROD_V7_BASE}"
if [ -e "${PROD_V7_AUTH}" ]; then
  mv "${PROD_V7_AUTH}" "${BACKUP_ROOT}/preexisting-v7-auth"
fi
mv "${CANARY_AUTH}" "${PROD_V7_AUTH}"
# Recreate empty canary path marker (auth moved)
mkdir -p "${CANARY_AUTH}.MOVED"
chown -R whatsapp:whatsapp "${PROD_V7_BASE}"
chmod 700 "${PROD_V7_AUTH}"

echo "[4] Patch registry: Cut → BAILEYS_V7 RUNNING; keep others"
python3 - <<'PY'
import json, os, time
from pathlib import Path
reg_path = Path("/home/whatsapp/whatsapp-bot/data/baileys-auth-accounts/runtime-registry.json")
CUT = "wa_f09d54055f079b2624800b46"
doc = {"version": 1, "accounts": {}}
if reg_path.exists():
    try:
        doc = json.loads(reg_path.read_text())
    except Exception:
        pass
if not isinstance(doc.get("accounts"), dict):
    doc["accounts"] = {}
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for k, v in list(doc["accounts"].items()):
    if not isinstance(v, dict):
        doc["accounts"][k] = {"desiredState": "STOPPED", "runtimeEngine": "BAILEYS_V6", "updatedAt": now}
        continue
    eng = v.get("runtimeEngine") or "BAILEYS_V6"
    if k == CUT:
        eng = "BAILEYS_V7"
    doc["accounts"][k] = {
        "desiredState": v.get("desiredState") or "STOPPED",
        "runtimeEngine": "BAILEYS_V7" if k == CUT else ("BAILEYS_V7" if eng == "BAILEYS_V7" else "BAILEYS_V6"),
        "updatedAt": now if k == CUT else (v.get("updatedAt") or now),
    }
doc["accounts"][CUT] = {
    "desiredState": "RUNNING",
    "runtimeEngine": "BAILEYS_V7",
    "updatedAt": now,
}
tmp = reg_path.with_suffix(".tmp")
tmp.write_text(json.dumps(doc, indent=2) + "\n")
tmp.replace(reg_path)
print("registry_cut", doc["accounts"][CUT])
PY
chown whatsapp:whatsapp "${REGISTRY}"

echo "[5] Disable canary unit (keep unit file + backups)"
systemctl disable "${CANARY_SVC}" || true

echo "[6] Restart production runtime (recovery starts Cut on V7)"
systemctl restart "${BOT_SVC}"
sleep 8
systemctl is-active --quiet "${BOT_SVC}"

echo "PROMOTE_OK backup=${BACKUP_ROOT}"
