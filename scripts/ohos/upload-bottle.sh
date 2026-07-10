#!/bin/bash
# Build Homebrew bottle tarball and upload to atomgit release.
# Called from CI workflow (ohos-build.yml) on workflow_dispatch.
# ATOMGIT_TOKEN is injected from GitHub Secrets.

set -euo pipefail

TOKEN="${ATOMGIT_TOKEN:?ATOMGIT_TOKEN not set — add it as a GitHub Secret}"

# ── Determine version and tag ──────────────────────────────────────────

VERSION=$(build/release/bun --version 2>/dev/null || echo "1.4.0")
REV="${BOTTLE_REV:-30}"
TAG="bun-v${VERSION}-r${REV}"
BOTTLE="bun-${VERSION}_${REV}.arm64_ohos.bottle.tar.gz"

echo "=== Bottle build & upload ==="
echo "Version: $VERSION  Rev: $REV  Tag: $TAG"
echo "Bottle:  $BOTTLE"

# ── Create bottle ─────────────────────────────────────────────────────

echo ""
echo "--- Creating bottle layout ---"

BOTTLE_DIR="/tmp/bun-bottle-$$"
KEG="$BOTTLE_DIR/bun/$VERSION"
mkdir -p "$KEG/bin"
cp build/release/bun "$KEG/bin/bun"

echo "✅ Layout: $KEG/bin/bun"

cd "$BOTTLE_DIR"
brew bottle --json --root-url="https://atomgit.com/social4hyq/homebrew-core/releases/download/$TAG" bun

# brew bottle outputs: bun-<version>_<rev>.arm64_ohos.bottle.{tar.gz,json}
# but with directory name bun/<version>/ inside.
# The expected bottle filename may differ; find it.
BOTTLE_FILE=$(ls *.arm64_ohos.bottle.tar.gz 2>/dev/null | head -1)
if [ -z "$BOTTLE_FILE" ]; then
  echo "❌ Bottle tarball not found in $BOTTLE_DIR"
  ls -la "$BOTTLE_DIR"
  exit 1
fi

echo "✅ Created: $BOTTLE_FILE ($(du -h "$BOTTLE_FILE" | cut -f1))"

# ── Step 1 — Ensure release tag exists on atomgit ──────────────────────

echo ""
echo "--- Step 1: Check/create release $TAG ---"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "https://atomgit.com/api/v5/repos/social4hyq/homebrew-core/releases/tags/$TAG")

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Release $TAG already exists"
elif [ "$HTTP_CODE" = "404" ]; then
  echo "⚠️  Release $TAG not found — creating..."
  curl -sf -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"target_commitish\":\"main\",\"body\":\"$TAG bottle\"}" \
    "https://atomgit.com/api/v5/repos/social4hyq/homebrew-core/releases"
  echo ""
  echo "✅ Created release $TAG"
else
  echo "❌ Unexpected HTTP $HTTP_CODE checking release $TAG"
  exit 1
fi

# ── Step 2 — Get presigned upload URL ──────────────────────────────────

echo ""
echo "--- Step 2: Get presigned upload URL ---"

RESP=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://atomgit.com/api/v5/repos/social4hyq/homebrew-core/releases/$TAG/upload_url?file_name=$BOTTLE")

UPLOAD_URL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
H_PROJECT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['headers']['x-obs-meta-project-id'])")
H_ACL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['headers']['x-obs-acl'])")
H_CALLBACK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['headers']['x-obs-callback'])")

echo "✅ Got presigned URL"

# ── Step 3 — Upload to OBS ─────────────────────────────────────────────

echo ""
echo "--- Step 3: Upload $BOTTLE ---"

HTTP_CODE=$(curl -sf -X PUT "$UPLOAD_URL" \
  -H "x-obs-meta-project-id: $H_PROJECT" \
  -H "x-obs-acl: $H_ACL" \
  -H "x-obs-callback: $H_CALLBACK" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$BOTTLE_FILE" \
  -w "%{http_code}" -o /dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Uploaded: $TAG/$BOTTLE"
else
  echo "❌ Upload failed: HTTP $HTTP_CODE"
  exit 1
fi

echo ""
echo "Download URL:"
echo "  https://atomgit.com/social4hyq/homebrew-core/releases/download/$TAG/$BOTTLE"
