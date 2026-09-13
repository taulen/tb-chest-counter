# Intel iGPU passthrough (Proxmox → LXC → Docker)

Let the scanner render Total Battle's WebGL canvas on the host Intel iGPU
instead of the CPU (SwiftShader), which is the dominant CPU cost of a scan.
**Validated** on an Intel UHD 770 (Alder Lake) → WebGL renderer reports
`ANGLE (Intel, Vulkan 1.3.x (Intel(R) UHD Graphics 770 …), Intel open-source Mesa driver)`.

The code + image side (mesa/Vulkan drivers, the `SCANNER_GPU` toggle, the
`/dev/dri` mapping, the new-headless + ANGLE-Vulkan launch, the WebGL self-check)
is already in this repo. This file is the **host-side** setup.

## Why Vulkan, why new-headless (the two things that actually matter)

- **New headless, not the default.** Playwright's default `headless:true` uses
  `chromium-headless-shell`, which has **zero GPU support**. The app uses
  `channel:'chromium'` → Chromium's *new* headless mode, which is GPU-capable.
- **Vulkan, not GL.** In a headless container the GL/EGL backends try to open an
  X display and fail (`Could not open the default X display`). ANGLE's **Vulkan**
  backend (`--use-angle=vulkan`, mesa ANV) talks to `/dev/dri/renderD128`
  directly — no X server, no Xvfb. That's the only backend that works headless
  here.
- **Access by file mode, not idmap.** The render node is made `0666` on the host
  via a udev rule, so the unprivileged container can open it without any
  `lxc.idmap` GID remapping (which is fragile and previously destabilised the
  host). No `group_add` needed either.

---

## Step 1 — Host: confirm the iGPU

On the **Proxmox host**:

```sh
ls -l /dev/dri            # expect renderD128 (major 226, minor 128)
lspci -nnk | grep -A3 -Ei 'vga|display'   # "Kernel driver in use: i915"
```

## Step 2 — Host: make renderD128 world-openable (udev)

```sh
echo 'SUBSYSTEM=="drm", KERNEL=="renderD128", MODE="0666"' > /etc/udev/rules.d/99-drm-render.rules
udevadm control --reload && udevadm trigger
ls -l /dev/dri/renderD128     # expect crw-rw-rw-
```

## Step 3 — Host: expose the node to the LXC (no idmap)

Append to `/etc/pve/lxc/<VMID>.conf`:

```conf
lxc.cgroup2.devices.allow: c 226:128 rwm
lxc.mount.entry: /dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file
```

Restart the container, then verify the device is live inside it:

```sh
pct stop <VMID> && pct start <VMID>
pct exec <VMID> -- ls -l /dev/dri/renderD128    # expect crw-rw-rw- (owner may show nobody — fine, 0666 is what matters)
```

> ⚠️ If this LXC hosts other services, `pct stop/start` restarts **all** of them.
> Do it in a maintenance window.

## Step 4 — Docker: enable it

The compose file already declares `devices: /dev/dri:/dev/dri` and reads
`SCANNER_GPU`. Set in the stack env and redeploy:

```env
SCANNER_GPU=1
```

Deploying via a Portainer Git stack (or `docker compose up -d --build`) rebuilds
the image with the mesa/Vulkan drivers.

## Step 5 — Verify the iGPU engaged

Chromium fails **soft** (silently drops to SwiftShader), so check the log the app
prints at every browser launch when `SCANNER_GPU=1`:

```sh
docker logs tb-chest-counter 2>&1 | grep -iE 'WebGL renderer|NOT on the iGPU'
```

- ✅ `GPU mode ON — WebGL renderer: "ANGLE (Intel, Vulkan … UHD Graphics 770 …)"`
- ❌ `GPU mode ON but WebGL is NOT on the iGPU: "… SwiftShader …"` → troubleshoot below.

Then confirm the CPU dropped: run a scan and watch `docker stats tb-chest-counter`.

---

## Quick standalone probe (optional)

To test the GPU without deploying — a disposable, CPU-capped container that
prints the renderer and cleans itself up:

```sh
docker run --rm --cpus=2 --device /dev/dri:/dev/dri debian:bookworm-slim bash -c '
apt-get update -qq >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium libgl1-mesa-dri libegl-mesa0 libgbm1 libvulkan1 mesa-vulkan-drivers >/dev/null 2>&1
printf "%s" "<canvas id=c></canvas><script>var g=document.getElementById(\"c\").getContext(\"webgl\");var e=g.getExtension(\"WEBGL_debug_renderer_info\");document.title=g.getParameter(e.UNMASKED_RENDERER_WEBGL)</script>" > /p.html
chromium --headless=new --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage \
  --use-gl=angle --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist \
  --dump-dom file:///p.html 2>/dev/null | grep -aoiE "(intel|vulkan|swiftshader|llvmpipe)[^<]{0,45}" | sort -u'
```

Always cap it (`--cpus`) on a shared host — an uncapped Chromium install can
saturate the box.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `NOT on the iGPU: … SwiftShader` | Device not reaching Chromium: `docker exec tb-chest-counter ls -l /dev/dri` (renderD128 present, `crw-rw-rw-`?), `SCANNER_GPU=1` set, image rebuilt with the Vulkan drivers. |
| `… llvmpipe` / `no-webgl` | Wrong backend — must be `--use-angle=vulkan` (the app sets this). GL/EGL need X and won't work headless. |
| Container won't start (device error) | `/dev/dri` missing in the LXC. Redo Steps 2–3, `pct stop/start`, confirm with `ls /dev/dri` inside the LXC. |
| GPU works but CPU still a concern on a shared host | The compose `deploy.resources.limits.cpus` cap (default 4) coexists fine — a GPU-rendering scanner uses far less CPU anyway. |

## Rolling back

Set `SCANNER_GPU=0` and redeploy → headless software path, instantly. To remove
passthrough entirely, drop the compose `devices:` block and the `lxc.*` lines
(the udev rule is inert on its own).
