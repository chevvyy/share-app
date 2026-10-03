# share-app

A temporary file-sharing site for a k3s cluster, served at **https://share.howellsas.com** through Traefik.

- **Backend:** Node.js 22 using only the standard library. No npm dependencies, no build step.
- **Frontend:** plain HTML/CSS and vanilla JavaScript.

Users create a **file set** and get back a 43-character random ID (256 bits from `crypto.randomBytes`). Anyone holding the ID can upload, download and delete files in that set, and the ID is the only access control. Each set is deleted automatically after a time the user chooses, at most **6 hours**.

| Limit | Default | Enforced |
|---|---|---|
| Time until deletion | 1 min to 6 h (6 h is also a hard cap in code) | Server-side. A background sweeper deletes expired sets every 15 s, whether or not anyone visits the site. |
| Bytes per file set | 5 GiB | Server-side, across all uploads, including concurrent ones. The full size of each upload is reserved before any byte is accepted. |
| File sets at once | 10 | Server-side. Creating an 11th returns `409` plus `Retry-After`. |

Uploads and downloads are streamed straight to and from disk, so memory stays flat: measured peak RSS was about 96 MB while moving 12 GB. Downloads support `Range` requests, so they can be resumed.

---

## Project layout

```
.
├── Dockerfile
├── package.json
├── src/
│   ├── index.js        # entrypoint: config, startup, graceful shutdown
│   ├── config.js       # env-var configuration with validation
│   ├── server.js       # HTTP routing, streaming upload/download, validation, security headers
│   ├── store.js        # file-set state, quotas/reservations, persistence, expiry sweeper
│   ├── logger.js       # JSON-lines logging (set IDs are never logged, only a hash)
│   ├── errors.js
│   └── format.js
├── public/             # index.html, app.js, style.css (the web UI)
├── test/integration.test.js
├── k8s/                # kustomization.yaml, pvc.yaml, deployment.yaml, service.yaml, ingress.yaml
└── traefik/helmchartconfig.yaml   # one-time cluster setting for long uploads (kube-system)
```

## Run and test locally

```bash
npm test                                   # 16 end-to-end tests against a real server process
DATA_DIR=./data PORT=8080 npm start        # then open http://localhost:8080
```

---

## Deploy: source to live site

Values you must supply are written as **`YOUR_…` placeholders**:

| Placeholder | Example |
|---|---|
| `YOUR_GIT_REPO_URL` | `https://github.com/your-user/share-app.git` |
| `YOUR_REGISTRY` | `ghcr.io/your-user` or `docker.io/your-user` |
| `YOUR_CLUSTER_ISSUER` (optional, for TLS) | `letsencrypt-prod` |

The manifests deploy into the **`claude-sandbox`** namespace. To use a different one, change `namespace:` in `k8s/kustomization.yaml` and the `-n` flags below.

### 1. Push the project to git (dev machine)

```bash
cd share-app
git init -b main            # skip if already a repo
git add .
git commit -m "share-app: initial commit"
git remote add origin YOUR_GIT_REPO_URL
git push -u origin main
```

### 2. Pull it and build/push the image (any machine with Docker)

```bash
git clone YOUR_GIT_REPO_URL share-app && cd share-app
docker build -t YOUR_REGISTRY/share-app:1.0.0 .
docker push YOUR_REGISTRY/share-app:1.0.0
```

Record the image in git, so that the repo describes exactly what is deployed:

```bash
sed -i 's#YOUR_REGISTRY/share-app#ghcr.io/your-user/share-app#' k8s/kustomization.yaml   # your real registry path
git commit -am "Deploy share-app 1.0.0" && git push
```

<details>
<summary>Private registry: add a pull secret</summary>

```bash
kubectl -n claude-sandbox create secret docker-registry share-regcred \
  --docker-server=YOUR_REGISTRY_HOST --docker-username=YOUR_REGISTRY_USER --docker-password=YOUR_REGISTRY_TOKEN
kubectl -n claude-sandbox patch serviceaccount default -p '{"imagePullSecrets":[{"name":"share-regcred"}]}'
```
</details>

<details>
<summary>No registry: import the image straight into k3s</summary>

Run this on the k3s node, or on every node in a multi-node cluster:

```bash
docker save YOUR_REGISTRY/share-app:1.0.0 | sudo k3s ctr images import -
```

`imagePullPolicy: IfNotPresent` then uses the local copy.
</details>

### 3. One-time: let Traefik accept long-running uploads (cluster admin)

Traefik v3, which k3s bundles, aborts any request whose body takes longer than **60 s** to read. This was verified on this cluster: a slow single-request upload was cut off at 60.05 s with `504 Gateway Timeout`.

The browser UI already uploads in 32 MiB chunks, so it works regardless. This step removes the limit for slow connections and for single-request (`curl`) uploads of large files.

```bash
kubectl get helmchartconfig traefik -n kube-system   # if it exists, MERGE traefik/helmchartconfig.yaml into it instead
kubectl apply -f traefik/helmchartconfig.yaml
kubectl -n kube-system rollout status deploy/traefik --timeout=180s
kubectl -n kube-system get deploy traefik -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep respondingTimeouts
```

Traefik doesn't limit request body size by default (bodies are streamed unless a Buffering middleware is attached), so no body-size setting is needed.

### 4. Deploy from git with kubectl

From the clone, after `git pull`:

```bash
git pull
kubectl apply -k k8s/
kubectl -n claude-sandbox rollout status deploy/share --timeout=180s
```

You can also apply straight from the remote repo. This needs `git` on the machine running kubectl. GitHub example:

```bash
kubectl apply -k "https://github.com/your-user/share-app//k8s?ref=main"
```

### 5. DNS and Cloudflare

`share.howellsas.com` currently resolves to **Cloudflare** addresses, so requests go through Cloudflare's proxy: either an orange-cloud record or a Cloudflare Tunnel. Point it at Traefik:

- **Cloudflare Tunnel** (needed here, because Traefik's LoadBalancer IPs are private 192.168.0.x addresses): add an ingress rule `hostname: share.howellsas.com` → `service: http://traefik.kube-system.svc.cluster.local:80`.
- **Proxied DNS record:** point it at a public IP that forwards ports 80/443 to Traefik.

> **Cloudflare caps a single request body at 100 MB on Free and Pro plans, 200 MB on Business, and 500 MB on Enterprise.**
> The web UI handles this by sending files in 32 MiB chunks (`CHUNK_BYTES`), so 5 GiB uploads go through Cloudflare fine.
> Scripts that use the single-request endpoint (`POST …/files`) are limited to that cap through Cloudflare. Use the chunked API instead (see the API section), or the in-cluster/LAN URL.

Kubernetes requires lowercase Ingress hosts, so the rule uses `share.howellsas.com`. DNS is case-insensitive, so `share.Howellsas.com` works the same.

**HTTPS:** the `websecure` entrypoint serves TLS using Traefik's default certificate. With Cloudflare in front, set Cloudflare SSL mode to *Full*. For a real origin certificate, uncomment the cert-manager annotation and the `tls:` block in `k8s/ingress.yaml` and set `YOUR_CLUSTER_ISSUER`.

---

## Verify it works

```bash
# Resources are up and the PVC is Bound
kubectl -n claude-sandbox get deploy,pods,svc,ingress,pvc -l app.kubernetes.io/part-of=share
kubectl -n claude-sandbox logs deploy/share --tail=20

# Health through Traefik on the LAN (bypasses DNS/Cloudflare). Use any Traefik LoadBalancer IP:
LB=$(kubectl -n kube-system get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s --max-time 10 -H 'Host: share.howellsas.com' http://$LB/healthz        # {"status":"ok"}

# End-to-end through the public hostname
BASE=https://share.howellsas.com
curl -s --max-time 10 $BASE/healthz
ID=$(curl -s --max-time 10 -X POST -H 'Content-Type: application/json' -d '{"ttlSeconds":600}' \
     $BASE/api/sets | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "set id: $ID (length ${#ID}, expect 43)"
echo "hello from share-app" > hello.txt
FID=$(curl -s --max-time 30 -X POST -T hello.txt "$BASE/api/sets/$ID/files?name=hello.txt" \
     | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s --max-time 30 "$BASE/api/sets/$ID/files/$FID"                           # prints the file
curl -s --max-time 10 -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
     -d '{"ttlSeconds":21601}' $BASE/api/sets                                     # 400: over 6 h
curl -s --max-time 10 -X DELETE -o /dev/null -w '%{http_code}\n' "$BASE/api/sets/$ID"   # 204
```

Then open **https://share.howellsas.com** in a browser. Create a set, upload a file larger than 100 MB (this exercises chunking), check the countdown and storage bar, download the file, and delete the set.

---

## Storage sizing (adjust to your disk)

`k8s/pvc.yaml` requests **55Gi**. That's the worst case of 10 sets × 5 GiB = 50 GiB, plus about 10% headroom for metadata and in-flight temp files.

- k3s's `local-path` provisioner **does not enforce** PVC sizes. The data is a directory on one node's disk (default `/var/lib/rancher/k3s/storage`), so make sure that disk has the space.
- The app checks the volume's real free space before every upload and answers `507 Insufficient Storage` instead of failing mid-write. `DISK_RESERVE_BYTES` (default 256 MiB) is always kept free.
- If your node has less space, lower the PVC request **and** `MAX_SETS` / `MAX_SET_BYTES` in `k8s/deployment.yaml`.

## Configuration (env vars, set in `k8s/deployment.yaml`)

| Variable | Default | Meaning |
|---|---|---|
| `MAX_SETS` | `10` | File sets that may exist at once |
| `MAX_SET_BYTES` | `5368709120` (5 GiB) | Byte cap per file set |
| `MAX_TTL_SECONDS` | `21600` | Longest allowed lifetime. Values above 6 h are rejected at startup. |
| `MIN_TTL_SECONDS` | `60` | Shortest allowed lifetime |
| `MAX_FILES_PER_SET` | `1000` | File count cap per set |
| `CHUNK_BYTES` | `33554432` (32 MiB) | Chunk size the browser uses. Keep below any proxy body limit. |
| `UPLOAD_SESSION_IDLE_SECONDS` | `900` | Abandoned chunked uploads are discarded and their quota released after this |
| `SWEEP_INTERVAL_SECONDS` | `15` | How often expired sets are deleted |
| `IDLE_TIMEOUT_SECONDS` | `120` | Close a connection when no bytes move for this long |
| `DISK_RESERVE_BYTES` | `268435456` | Free space always kept on the volume |
| `SHUTDOWN_GRACE_SECONDS` | `20` | Drain time on SIGTERM (keep below `terminationGracePeriodSeconds`) |
| `TRUST_PROXY` | `true` | Use `X-Forwarded-For` for client IPs in logs |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DATA_DIR`, `PORT`, `HOST` | `/data`, `8080`, `0.0.0.0` | |

## HTTP API

All errors are JSON: `{"error":{"code":"…","message":"…","requestId":"…"}}`.

| Method & path | Body | Result |
|---|---|---|
| `GET /api/config` | | Limits and current set count |
| `POST /api/sets` | `{"ttlSeconds": 3600}` | `201` with the set, including `id` and `expiresAt` · `400 INVALID_TTL` · `409 SET_LIMIT_REACHED` |
| `GET /api/sets/{id}` | | Set info, file list, `remainingSeconds`, usage · `404` |
| `DELETE /api/sets/{id}` | | `204`. Deletes the set and its files now. |
| `POST /api/sets/{id}/files?name=N` | raw file bytes (`Content-Length` required) | `201`. Single-request upload. · `411` · `413 SET_QUOTA_EXCEEDED` · `507` |
| `POST /api/sets/{id}/uploads` | `{"name":"a.iso","size":123}` | `201 {uploadId}`. Starts a chunked upload and reserves `size`. |
| `PUT /api/sets/{id}/uploads/{uploadId}?offset=N` | raw chunk bytes | `200 {received}`, or `201 {file}` on the last chunk · `409 OFFSET_MISMATCH {expectedOffset}` to resume |
| `DELETE /api/sets/{id}/uploads/{uploadId}` | | `204`. Cancels the upload and releases its quota. |
| `GET /api/sets/{id}/files/{fileId}` | | The file as an attachment (`Range` supported) |
| `DELETE /api/sets/{id}/files/{fileId}` | | `204`. Frees the file's quota. |
| `GET /healthz`, `GET /readyz` | | Liveness and readiness (readiness checks the data volume is writable) |

## Operational notes

- **Single replica, `Recreate` strategy.** All state lives in one process on a ReadWriteOnce volume. Each deploy or restart causes a few seconds of downtime, and in-flight uploads must be restarted. Committed files and sets survive restarts because they're persisted in `meta.json` per set. Sets that expired while the app was down are deleted at startup.
- **Logs** are JSON lines on stdout/stderr. Set IDs are bearer secrets, so they are **never logged**. Logs show `set:<sha256 prefix>` instead, which still correlates log lines. If you enable Traefik access logs, note that they record request paths, which contain set IDs.
- **Security:** downloads are always `application/octet-stream` + `Content-Disposition: attachment` + `nosniff`, so uploaded HTML can't run on the site. The UI is protected by a strict CSP and `Referrer-Policy: no-referrer`. Files are stored under random IDs, so client file names never touch the filesystem. The container runs as non-root UID 1000 with a read-only root filesystem, all capabilities dropped and the RuntimeDefault seccomp profile, which meets Pod Security "restricted".
- **Abuse:** by design, anyone can create sets, so one person could hold all 10 slots for 6 hours. If that matters, rate-limit `POST /api/sets` at the edge, for example with a Cloudflare WAF rate-limiting rule or Cloudflare Access.

## Uninstall

```bash
kubectl delete -k k8s/     # also deletes the PVC and all uploaded data
```
