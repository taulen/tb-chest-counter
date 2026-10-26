# Docker image

- **The Docker image is Linux-only by design.** To trim ~220MB, the build prunes `onnxruntime-node`'s bundled native libraries down to the build platform's arch — it keeps only `linux/<arch>` and strips the macOS/Windows binaries. Building a non-Linux image would need that prune step (in the `npm ci` layer of the [Dockerfile](../Dockerfile)) removed. This does **not** affect local dev on any OS: `node_modules` is `.dockerignore`d and reinstalled fresh inside the container, so your local install keeps every platform's binaries.
