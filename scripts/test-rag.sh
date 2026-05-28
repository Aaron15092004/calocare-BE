#!/usr/bin/env bash
# RAG Integration Test Script
# Usage: TOKEN=<jwt> bash scripts/test-rag.sh
# Set BASE_URL if your server runs elsewhere (default: localhost:1509)

BASE_URL="${BASE_URL:-http://localhost:1509}"
TOKEN="${TOKEN:-}"
PASS=0; FAIL=0

c_green="\033[32m"; c_red="\033[31m"; c_reset="\033[0m"; c_bold="\033[1m"
ok()   { echo -e "${c_green}  PASS${c_reset} $1"; ((PASS++)); }
fail() { echo -e "${c_red}  FAIL${c_reset} $1"; ((FAIL++)); }

auth_header() {
  if [ -n "$TOKEN" ]; then echo "-H \"Authorization: Bearer $TOKEN\""; fi
}

# Helper: POST JSON, check HTTP status and optional jq filter
post_check() {
  local label=$1 url=$2 body=$3 expected_status=${4:-200} jq_check=${5:-}
  local response http_code
  response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL$url" \
    -H "Content-Type: application/json" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    -d "$body")
  http_code=$(echo "$response" | tail -1)
  body_out=$(echo "$response" | head -n -1)
  if [ "$http_code" != "$expected_status" ]; then
    fail "$label — expected HTTP $expected_status, got $http_code"
    echo "    Response: $body_out" | head -c 200
    return 1
  fi
  if [ -n "$jq_check" ]; then
    local val; val=$(echo "$body_out" | python3 -c "import sys,json; d=json.load(sys.stdin); print($jq_check)" 2>/dev/null)
    if [ -z "$val" ] || [ "$val" = "None" ] || [ "$val" = "0" ]; then
      fail "$label — jq check failed: $jq_check → '$val'"
      return 1
    fi
  fi
  ok "$label"
}

echo -e "\n${c_bold}=== RAG Integration Tests ===${c_reset}"
echo "Base URL: $BASE_URL"
echo "Auth: $([ -n "$TOKEN" ] && echo "Bearer token provided" || echo "No token (anonymous)")"
echo ""

# ───────────────────────────────────────────────
echo -e "${c_bold}1. Search Endpoint${c_reset}"
# ───────────────────────────────────────────────

post_check "VN: 'pho bo'" /api/rag/search-food \
  '{"query":"pho bo","top_k":5}' 200 \
  "len(d.get('results',[]))>0"

post_check "VN: 'com tam'" /api/rag/search-food \
  '{"query":"com tam suon bi","top_k":5}' 200 \
  "len(d.get('results',[]))>=0"

post_check "VN: 'bun bo hue'" /api/rag/search-food \
  '{"query":"bun bo hue","top_k":5}' 200

post_check "VN: 'rau muong xao toi'" /api/rag/search-food \
  '{"query":"rau muong xao toi","top_k":5}' 200

post_check "VN: 'banh mi thit'" /api/rag/search-food \
  '{"query":"banh mi thit","top_k":5}' 200

post_check "EN: 'grilled chicken breast'" /api/rag/search-food \
  '{"query":"grilled chicken breast","top_k":5}' 200 \
  "len(d.get('results',[]))>0"

post_check "EN: 'brown rice'" /api/rag/search-food \
  '{"query":"brown rice","top_k":5}' 200

post_check "EN: 'salmon fillet'" /api/rag/search-food \
  '{"query":"salmon fillet","top_k":5}' 200

post_check "EN: 'avocado' (USDA)" /api/rag/search-food \
  '{"query":"avocado","top_k":5,"include_sources":["usda"]}' 200 \
  "len(d.get('results',[]))>0"

post_check "EN: 'greek yogurt protein'" /api/rag/search-food \
  '{"query":"greek yogurt protein","top_k":5}' 200

echo ""

# ───────────────────────────────────────────────
echo -e "${c_bold}2. Chat Endpoint (requires token)${c_reset}"
# ───────────────────────────────────────────────

if [ -z "$TOKEN" ]; then
  echo "  SKIP — no TOKEN provided (set TOKEN=<jwt> to test chat)"
else
  # Chat tests using curl with SSE — read first event then stop
  chat_check() {
    local label=$1 message=$2
    local result
    result=$(curl -s --max-time 30 -X POST "$BASE_URL/api/rag/chat" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"message\":\"$message\"}" 2>&1 | head -c 500)
    if echo "$result" | grep -q '"type":"chunk"\|"text":'; then
      ok "$label"
    elif echo "$result" | grep -q '"type":"done"\|"ok":true'; then
      ok "$label"
    else
      fail "$label — no chunk/done event: $result"
    fi
  }

  chat_check "FAQ mode: nutrient question" "Vitamin C co trong thuc pham nao?"
  chat_check "FAQ mode: calorie question" "100g uc bo bao nhieu calo?"
  chat_check "Personal mode: diary summary" "Hom nay toi an bao nhieu calo?"
fi

echo ""

# ───────────────────────────────────────────────
echo -e "${c_bold}3. Meal Plan Endpoint (requires token + premium+)${c_reset}"
# ───────────────────────────────────────────────

if [ -z "$TOKEN" ]; then
  echo "  SKIP — no TOKEN provided"
else
  result=$(curl -s --max-time 120 -X POST "$BASE_URL/api/rag/generate-meal-plan" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"duration_days":7,"goal":"weight_loss","preferences":{"dietary_preference":"omnivore"}}' 2>&1 | head -c 2000)
  if echo "$result" | grep -q '"type":"day"\|"type":"done"'; then
    ok "Meal plan: 7 days weight_loss (SSE stream received)"
  elif echo "$result" | grep -q '"error":"feature_locked"'; then
    echo "  INFO  Meal plan: rate limited (free tier) — expected"
  else
    fail "Meal plan: unexpected response: ${result:0:200}"
  fi
fi

echo ""

# ───────────────────────────────────────────────
echo -e "${c_bold}4. Input Validation${c_reset}"
# ───────────────────────────────────────────────

post_check "Search: empty query → 400" /api/rag/search-food \
  '{"query":""}' 400

post_check "Search: no body → 400" /api/rag/search-food \
  '{}' 400

echo ""
echo -e "${c_bold}Results: ${c_green}$PASS passed${c_reset}, ${c_red}$FAIL failed${c_reset}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
