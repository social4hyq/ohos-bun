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
# Hand-rolled tarball (NOT `brew bottle`): brew bottle only operates on a keg
# installed in the Cellar, so pointing it at the CI build tree would silently
# re-bottle whatever old bun happens to be installed on the runner. Instead we
# replicate bun.rb's install() keg layout exactly:
#   <keg>/libexec/bin/bun  — the real (CI-built, signed) binary
#   <keg>/bin/bun          — LD_PRELOAD wrapper (must match bun.rb verbatim)
# Keg dir MUST be bun/<version>_<rev> when the formula has `revision N`;
# a bun/<version> dir pours into the wrong place and the install breaks.

echo ""
echo "--- Creating bottle layout ---"

HB="${HOMEBREW_PREFIX:?HOMEBREW_PREFIX not set}"
BOTTLE_DIR="/tmp/bun-bottle-$$"
KEG="$BOTTLE_DIR/bun/${VERSION}_${REV}"
mkdir -p "$KEG/bin" "$KEG/libexec/bin"
cp build/release/bun "$KEG/libexec/bin/bun"
chmod 0755 "$KEG/libexec/bin/bun"

# Wrapper content mirrors bun.rb install() — keep the two in sync.
cat > "$KEG/bin/bun" <<WRAP
#!/bin/sh
export LD_PRELOAD="$HB/opt/ohos-compat-shim/lib/libohos_compat.so\${LD_PRELOAD:+:\$LD_PRELOAD}"
# Opt in the shim's linkat hook (default OFF): OHOS SELinux blocks hardlinks.
# bun's source-level copy_file_fallback was removed in favor of the shim's
# byte-copy fallback (equivalent — both lose hardlink identity). symlinkat is
# deliberately NOT opted in (unsafe for relative tarball symlink targets).
export OHOS_COMPAT_SHIM_ENABLE="linkat\${OHOS_COMPAT_SHIM_ENABLE:+,\$OHOS_COMPAT_SHIM_ENABLE}"
exec "$HB/opt/bun/libexec/bin/bun" "\$@"
WRAP
chmod 0755 "$KEG/bin/bun"

echo "✅ Layout: $KEG/{bin/bun wrapper, libexec/bin/bun}"

# gnu-tar required: toybox tar/gzip cannot produce a valid compressed bottle.
GTAR=$(command -v gtar || command -v "$HB/bin/tar" || command -v tar)
cd "$BOTTLE_DIR"
"$GTAR" -czf "$BOTTLE" bun
BOTTLE_FILE="$BOTTLE"

echo "✅ Created: $BOTTLE_FILE ($(du -h "$BOTTLE_FILE" | cut -f1))"
echo "sha256: $(sha256sum "$BOTTLE_FILE" | cut -d' ' -f1)  ← paste into bun.rb bottle block"

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
