FROM node:22-slim

WORKDIR /app

COPY package*.json ./

# Skip automatic browser download during npm install — we install only Chromium below
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install prod deps, then strip onnxruntime-node's prebuilt binaries for every
# platform except this container's arch. The npm package bundles darwin +
# win32 + linux (x64 & arm64) native libs in a single tarball (~260MB); a
# Linux container needs only its own arch (~40MB). The prune MUST run in the
# same layer as `npm ci` — deleting the files in a later RUN would leave them
# baked into the earlier (additive) layer and shrink nothing.
#
# NOTE: this locks the image to Linux (macOS/Windows ORT binaries are removed).
# The base is a Linux image so that's always true here; a non-Linux build would
# need this prune dropped. Local dev is unaffected — node_modules is
# .dockerignore'd and reinstalled fresh in the container.
RUN npm ci --omit=dev \
    && ARCH="$(node -p 'process.arch')" \
    && ORT=node_modules/onnxruntime-node/bin/napi-v6 \
    && find "$ORT" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
    && find "$ORT/linux" -mindepth 1 -maxdepth 1 ! -name "$ARCH" -exec rm -rf {} +

# Install Chromium + its OS deps and Xvfb in a single layer, then drop the apt
# package lists so ~40MB of metadata isn't committed. playwright's --with-deps
# runs its own `apt-get update` but never cleans up, so doing this here (rather
# than a separate RUN) keeps that cruft out of the image.
#
# Xvfb (X virtual framebuffer) is kept only as an escape hatch for the admin
# login-bridge (LOGIN_BRIDGE_DISPLAY=xvfb). The bridge now defaults to
# Chromium's NEW headless mode instead. It originally ran headed to capture a
# fuller cookie set during Google OAuth — a flow that was abandoned in favour
# of email+password login, and whose cookie-count concern was retracted anyway
# (only PTBHSSID matters). New headless is also the only mode where the bridge
# can use the iGPU, since Xvfb is a pure software framebuffer.
#
# The mesa + Vulkan packages let the game's WebGL canvas render on a
# passed-through Intel iGPU instead of the CPU, for BOTH the scanner
# (SCANNER_GPU=1) and the login bridge (LOGIN_BRIDGE_GPU, inherits
# SCANNER_GPU). Both run new-headless Chromium with ANGLE's Vulkan backend
# (mesa ANV, in mesa-vulkan-drivers + the libvulkan1 loader) talking to
# /dev/dri/renderD128 — validated to render on an Intel UHD 770. The GL/DRI
# libs (libgl1-mesa-dri / libegl-mesa0 / libgbm1) are part of the validated
# driver set. All inert unless GPU is enabled and /dev/dri is passed in. See
# docs/igpu-passthrough.md.
RUN npx playwright install --with-deps chromium \
    && apt-get install -y --no-install-recommends \
        xvfb \
        libgl1-mesa-dri \
        libegl-mesa0 \
        libgbm1 \
        libvulkan1 \
        mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

# Copy only what the runtime actually needs
COPY dist/ ./dist/
COPY src/web/public/ ./src/web/public/
COPY assets/ ./assets/
# The one script an operator has to be able to run INSIDE the container:
# putting an install back into first-run state, which needs the files on the
# mounted volume. Node builtins only, so it costs nothing. The rest of
# scripts/ is analysis tooling that runs from a checkout.
COPY scripts/reset-setup.mjs ./scripts/

# Build identity — written AFTER the COPYs above so cache invalidation
# on those layers also re-runs these steps.
#
# BUILD_TIME: when this image was built. Exposed via /api/health so an
# operator can confirm after a redeploy that Portainer/Docker actually
# rebuilt instead of serving a cached layer set. If the time is stale,
# the deploy didn't take.
#
# BUILD_FINGERPRINT: short hash covering both the compiled server
# (dist/) and the browser-served static files (src/web/public/).
# Hashing only dist/index.js missed frontend-only commits and most
# server-side changes — index.ts is rarely touched. Hashing the
# combined tree means ANY code change produces a new fingerprint.
# `find -type f | sort | xargs sha256sum | sha256sum` is the canonical
# way to compute a stable directory hash on Linux: sort makes the
# output order deterministic, the outer sha256sum collapses the
# per-file checksums into one digest.
#
# (Portainer's stack-from-git deploys don't ship .git in the build
# context, so we can't bake the actual commit SHA without manual env
# var injection. Time + fingerprint together are enough to answer
# "did this deploy take?" without that.)
RUN date -u -Iseconds > /app/BUILD_TIME \
    && (cd /app \
        && find dist src/web/public -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) \
        | sort \
        | xargs sha256sum \
        | sha256sum \
        | cut -c1-7 \
        > /app/BUILD_FINGERPRINT)

ENV NODE_ENV=production
ENV WEB_PORT=3000
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Allow Node's V8 heap to grow to ~4GB before OOMing, leaving ~1GB headroom
# in the 5GB container ceiling for Chromium/WebGL/Tesseract native memory.
# Override at runtime with NODE_MAX_OLD_SPACE_MB.
ENV NODE_OPTIONS="--max-old-space-size=4096"
# ONNX Runtime tries to pin its thread pool to cores with pthread_setaffinity_np,
# which fails in Docker (no CAP_SYS_NICE / restricted cpuset). OMP_NUM_THREADS
# only bounds OpenMP, NOT ORT's own intra-op pool, so the real fix lives in code:
# src/vision/paddle-service.ts passes explicit intra/inter-op thread counts on
# session creation (ORT skips affinity when the count is set explicitly). This
# env var is kept as belt-and-suspenders for any OpenMP-backed op.
ENV OMP_NUM_THREADS=1

EXPOSE 3000

CMD ["node", "dist/index.js"]
