# Ghost MCP Secure — hướng dẫn cho AI

## Tổng quan

MCP server cho Ghost CMS (blog `cuongn.com`), "secure-by-default": mặc định chỉ đọc, mỗi nhóm quyền ghi (post/page/tag/ảnh, publish, delete, members, monetization, system) chỉ mở khi đặt cờ env riêng. Hai cách chạy cùng một mã: local qua stdio (`src/index.js`, Claude Desktop/Code) và remote qua Streamable HTTP + OAuth 2.1 (`src/http-server.js`, claude.ai / ChatGPT connector). Người dùng: anh Cường; mã nguồn công khai (MIT, có README/REMOTE/SECURITY tiếng Anh cho cộng đồng).

- Công ty: tech — Lumen Technologies (Cuong Holdings). Manifest: `company.json`.
- Production: `https://ghost-mcp-secure-production.up.railway.app` (endpoint MCP `/mcp`, health `/healthz`) — Railway project `superb-smile`, service `ghost-mcp-secure`, build từ `Dockerfile`, 1 replica (session trong bộ nhớ). Deploy bằng `npm run deploy:railway` (cần `railway login` và bí mật trong env — chỉ anh chạy). GitHub Actions deploy có sẵn nhưng inert (chưa đặt `DEPLOY_RAILWAY`/`DEPLOY_CLOUD_RUN`). Chưa xác nhận Railway có tự deploy khi push `main` → coi push là deploy, cần anh duyệt.
- Stack: Node ≥ 18 (ESM, không build step), 2 dependency pin cứng `@modelcontextprotocol/sdk` 1.29.0 + `zod`. Máy Mac hiện chưa `npm ci` (không có `node_modules`).

## Cấu trúc

```text
src/index.js          entrypoint LOCAL (stdio)
src/http-server.js    entrypoint REMOTE: HTTP + OAuth, GET /healthz → "ok", GET / landing, /mcp, /sse (legacy)
src/core.js           lắp server dùng chung hai entrypoint
src/oauth.js          OAuth 2.1 + PKCE stateless (node:crypto)
src/config.js         đọc env, cờ quyền, PUBLIC_URL — NGUỒN CHÍNH về cờ và mặc định
src/helpers.js        dựng kết quả, slim object, upload
src/ghost-client.js   client Ghost Admin API (JWT 5 phút, không dependency)
src/tools/            site, content, images, members, monetization, system — mỗi file một nhóm quyền
test/smoke-remote.mjs smoke test OAuth + MCP chạy local (cần node_modules, tự spawn server với credential giả)
deploy/railway.sh     deploy Railway một lệnh; deploy/cloud-run.sh, setup-gcp-wif.sh — Cloud Run (chưa dùng)
.github/workflows/    deploy-railway.yml, deploy-cloud-run.yml — gated bằng biến repo, hiện skipped
Dockerfile, railway.json, app.json   image + cấu hình Railway/Cloud Run
README.md, REMOTE.md, SECURITY.md    tài liệu công khai (tiếng Anh)
tools/health.py       lệnh health (Python stdlib)
docs/ROADMAP.md       lộ trình và trạng thái
logs/                 log và báo cáo của agent (không đưa vào git)
company.json          manifest cho HQ
```

Bí mật: không có trong repo (`.env.example` chỉ là mẫu; `.gitignore` chặn `.env*`, `test.js`, `scratch/`). Biến production nằm trên Railway.

## Lệnh

Chạy từ gốc repo. Phải khớp `commands` trong `company.json`.

- `npm run check` — kiểm cú pháp `node --check src/index.js && node --check src/http-server.js` (mã thoát 0 = qua, không cần `node_modules`). Kết quả 8/11/2026: qua, 0,3 s. Đây là toàn bộ test tự động offline; `npm run smoke:remote` (OAuth + MCP end-to-end, local) cần `npm ci` trước; `npm run audit` cần mạng nên không nằm trong `test`.
- `/usr/bin/python3 tools/health.py --json` — sức khoẻ vận hành, định dạng `{area, name, level: ok|warn|bad, detail}`: git (nhánh, commit chưa push, file chưa commit), `GET /healthz` production (200 + body `ok`, timeout 5 s; khác → bad), `node_modules` thiếu → warn. Có `bad` → mã thoát 1. `--only git|api|build`. Không gửi token.
- `/usr/bin/python3 tools/health.py` — cùng dữ liệu dạng bảng ngắn (lệnh `status`).
- `npm ci` rồi `npm start` (stdio) / `npm run start:http` (HTTP, cần env theo `.env.example`) — chạy local.
- `npm run deploy:railway` / `npm run deploy:cloud-run` — deploy, **cần anh duyệt và anh tự chạy** (đòi bí mật trong env); không có trong `jobs`.

## An toàn

**Được tự làm**
- Sửa trong phạm vi việc được giao: `src/`, `test/`, `tools/`, `docs/`, README/REMOTE/SECURITY.
- Chạy lệnh đọc: `npm run check`, `tools/health.py`, `git log/status/diff`; `npm run smoke:remote` khi đã có `node_modules` (chỉ gọi localhost với credential giả).

**Không được làm**
- Không commit, không push (phiên điều hành commit sau khi kiểm; push có thể deploy).
- Không đọc/in bí mật: `~/.config/ghost-mcp-secure/`, `.env*`, `GHOST_ADMIN_API_KEY`, `MCP_AUTH_PASSWORD`, `MCP_OAUTH_SECRET`, token Railway/GCP.
- Không gọi Ghost Admin API thật (`cuongn.com`) từ test; không gọi `/mcp` production với token; chỉ `GET /healthz`.
- Không nới mô hình quyền: mặc định mọi cờ `false`, delete/publish/system phải vẫn là opt-in; không thêm dependency, không bỏ pin phiên bản; không thêm bước build.
- Không sửa `Dockerfile`/`railway.json`/workflow khi chưa được giao; không chạy `railway`/`gcloud` ghi.

**Cần anh duyệt**
- Push `main`, mọi deploy (`npm run deploy:*`), đổi biến env trên Railway, bật `DEPLOY_RAILWAY`/`DEPLOY_CLOUD_RUN`, tăng replica.
- Đổi cờ quyền production (nhất là `GHOST_ALLOW_DELETE`, `GHOST_ALLOW_SYSTEM`), xoay Admin API key.
- Nâng `@modelcontextprotocol/sdk`, đổi hành vi OAuth, thêm job `mutates: true` vào `company.json`.

## Phòng ban

Agent dùng chung của Holdings (cài qua `./hq install`); repo này không có agent riêng. Agent không gọi được agent khác; việc nhiều phòng do phiên điều hành gọi lần lượt.

| Việc | Giao cho | Ghi chú |
|---|---|---|
| Code server, tool MCP, client Ghost (`src/`) | `tools-dev` | Node ESM; giữ mô hình quyền opt-in |
| Railway/Cloud Run, env, health production | `devops` | chỉ đọc; thay đổi cần anh duyệt |
| Chạy test, kiểm `/healthz` | `qa-tester` | `npm run check`, `tools/health.py`; chỉ sửa file test |
| Đặc tả tool mới | `ba` | `docs/specs/` |
| Thẩm định diff trước commit | `reviewer` | chỉ đọc; chú ý bề mặt tấn công và lộ bí mật |
| Chi phí, dự toán | `finance` | chỉ đọc |
